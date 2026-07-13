import type { WatcherFactory } from "@core/ignore/DiracIgnoreController"
import { fileExistsAtPath } from "@utils/fs"
import chokidar, { FSWatcher } from "chokidar"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { CommandParser, type ParsedCommand } from "./CommandParser"
import { DangerousCharDetector } from "./DangerousCharDetector"
import { PermissionRuleEvaluator } from "./PermissionRuleEvaluator"
import { COMMAND_PERMISSIONS_ENV_VAR, CommandPermissionConfig, PermissionValidationResult, ToolPermissionRule } from "./types"

/**
 * Controls command execution permissions based on environment variable configuration.
 * Uses glob pattern matching to allow/deny specific commands.
 *
 * Configuration is read from the DIRAC_COMMAND_PERMISSIONS environment variable.
 * Format: {"allow": ["pattern1", "pattern2"], "deny": ["pattern3"], "allowRedirects": true}
 *
 * Rule evaluation for chained commands (e.g., "cd /tmp && npm test"):
 * 1. Parse command into segments split by operators (&&, ||, |, ;)
 * 2. Check for dangerous characters (backticks outside single quotes, newlines outside quotes)
 * 3. If redirects detected and allowRedirects !== true → DENIED
 * 4. Validate EACH segment against allow/deny rules - ALL must pass
 * 5. Recursively validate any subshell contents
 * 6. If no rules are defined (env var not set) → ALLOWED (backward compatibility)
 */
export class CommandPermissionController {
	private workspaceRoot: string | null = null
	private fileWatcher?: FSWatcher
	private config: CommandPermissionConfig | null = null
	private readonly ruleEvaluator = new PermissionRuleEvaluator()
	private readonly commandParser = new CommandParser()
	private readonly dangerousCharDetector = new DangerousCharDetector()

	constructor(private watcherFactory: WatcherFactory = chokidar.watch) {
		this.config = this.parseConfigFromEnv()
	}

	/** Initialize the controller with a workspace root and load configuration from file. */
	async initialize(workspaceRoot: string): Promise<void> {
		this.workspaceRoot = workspaceRoot
		await this.loadConfig()
		await this.setupFileWatcher()
	}

	/** Set up a file watcher for .dirac/permissions.json */
	private async setupFileWatcher(): Promise<void> {
		if (this.fileWatcher) {
			await this.fileWatcher.close()
			this.fileWatcher = undefined
		}
		if (!this.workspaceRoot) return

		const configPath = path.join(this.workspaceRoot, ".dirac", "permissions.json")

		this.fileWatcher = this.watcherFactory(configPath, {
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
			atomic: true,
		})

		this.fileWatcher.on("all", (event) => {
			this.loadConfig()
		})
	}

	/** Load configuration from environment and file. */
	private async loadConfig(): Promise<void> {
		const envConfig = this.parseConfigFromEnv()
		const fileConfig = await this.loadConfigFromFile()

		this.config = {
			...envConfig,
			...fileConfig,
			rules: [...(envConfig?.rules || []), ...(fileConfig?.rules || [])],
		}
	}

	/** Load configuration from .dirac/permissions.json */
	private async loadConfigFromFile(): Promise<CommandPermissionConfig | null> {
		if (!this.workspaceRoot) return null

		const configPath = path.join(this.workspaceRoot, ".dirac", "permissions.json")
		if (!(await fileExistsAtPath(configPath))) return null

		try {
			const content = await fs.readFile(configPath, "utf8")
			return JSON.parse(content) as CommandPermissionConfig
		} catch (_error) {
			return null
		}
	}

	/** Add a new permission rule and save to file. */
	async addRule(rule: ToolPermissionRule): Promise<void> {
		const currentConfig = (await this.loadConfigFromFile()) || { rules: [] }
		const rules = currentConfig.rules || []

		// Check if rule already exists to avoid duplicates
		const exists = rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action)

		if (!exists) {
			rules.push(rule)
			await this.saveConfig({ ...currentConfig, rules })
		}
	}

	/** List project-scoped rules persisted in .dirac/permissions.json. */
	async listRules(): Promise<ToolPermissionRule[]> {
		const config = await this.loadConfigFromFile()
		return config?.rules || []
	}

	/** Delete one project-scoped rule by its exact persisted value. */
	async deleteRule(rule: ToolPermissionRule): Promise<void> {
		const currentConfig = await this.loadConfigFromFile()
		if (!currentConfig?.rules) {
			return
		}

		const rules = currentConfig.rules.filter(
			(candidate) => candidate.tool !== rule.tool || candidate.pattern !== rule.pattern || candidate.action !== rule.action,
		)
		if (rules.length === currentConfig.rules.length) {
			return
		}

		await this.saveConfig({ ...currentConfig, rules })
	}

	async saveConfig(config: CommandPermissionConfig): Promise<void> {
		if (!this.workspaceRoot) {
			throw new Error("Workspace root not set. Cannot save permissions.")
		}

		const diracDir = path.join(this.workspaceRoot, ".dirac")
		const configPath = path.join(diracDir, "permissions.json")

		await fs.mkdir(diracDir, { recursive: true })
		await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8")

		// Update in-memory config. loadConfig() will be called by file watcher,
		// but we update it here for immediate effect.
		const envConfig = this.parseConfigFromEnv()
		this.config = {
			...envConfig,
			...config,
			rules: [...(envConfig?.rules || []), ...(config.rules || [])],
		}
	}

	private isConfigEmpty(): boolean {
		if (!this.config) return true
		return !(this.config.rules?.length || this.config.allow?.length || this.config.deny?.length)
	}

	/** Parse the DIRAC_COMMAND_PERMISSIONS environment variable. */
	private parseConfigFromEnv(): CommandPermissionConfig | null {
		const envValue = process.env[COMMAND_PERMISSIONS_ENV_VAR]
		if (!envValue) return null

		try {
			const parsed = JSON.parse(envValue)
			return {
				allow: Array.isArray(parsed.allow) ? parsed.allow : undefined,
				deny: Array.isArray(parsed.deny) ? parsed.deny : undefined,
				allowRedirects: typeof parsed.allowRedirects === "boolean" ? parsed.allowRedirects : undefined,
			}
		} catch (error) {
			Logger.error(`Failed to parse ${COMMAND_PERMISSIONS_ENV_VAR}:`, error)
			return null
		}
	}

	validateTool(tool: string, pattern?: string): PermissionValidationResult {
		if (this.isConfigEmpty()) {
			return { allowed: true, reason: "no_config" }
		}

		// Check general rules first (deny takes precedence, then allow)
		if (this.config?.rules) {
			const denyResult = this.matchToolRule(tool, pattern, "deny")
			if (denyResult) return denyResult

			const allowResult = this.matchToolRule(tool, pattern, "allow")
			if (allowResult) return allowResult
		}

		// Fallback to legacy command validation if it's execute_command
		if (tool === "execute_command" && pattern) {
			return this.validateCommand(pattern)
		}

		return { allowed: true, reason: "no_config" }
	}

	/** Match a tool against rules of a specific action (deny or allow). Returns null if no match. */
	private matchToolRule(
		tool: string,
		pattern: string | undefined,
		action: "allow" | "deny",
	): PermissionValidationResult | null {
		if (!this.config?.rules) return null

		for (const rule of this.config.rules) {
			if (rule.action !== action || !this.ruleEvaluator.matchesRule(rule, tool, pattern)) continue

			if (action === "deny") {
				return { allowed: false, reason: "denied", matchedPattern: rule.pattern }
			}

			// Allow rule matched - for execute_command, still run full validation (dangerous chars, redirects)
			if (tool === "execute_command" && pattern) {
				// Explicit allow means we bypass dangerous char checks (user trusted this pattern)
				const validationResult = this.validateCommand(pattern, true)
				if (validationResult.allowed) {
					return { ...validationResult, matchedPattern: rule.pattern }
				}
				return validationResult
			}
			return { allowed: true, reason: "allowed", matchedPattern: rule.pattern }
		}

		return null
	}

	/**
	 * Validate a command against allow/deny rules.
	 * @param allowDangerous - If true, bypasses checks for dangerous characters (newlines, backticks).
	 *                        Use this only when the command has already matched an explicit allow rule.
	 */
	validateCommand(command: string, allowDangerous = false): PermissionValidationResult {
		// No config = allow everything (backward compatibility)
		if (this.isConfigEmpty()) {
			return { allowed: true, reason: "no_config" }
		}

		// Check for dangerous characters first (backticks in double quotes, newlines outside quotes)
		if (!allowDangerous) {
			const dangerousChar = this.dangerousCharDetector.detect(command)
			if (dangerousChar) {
				return { allowed: false, reason: "shell_operator_detected", detectedOperator: dangerousChar.operator }
			}
		}

		// Parse the command into segments recursively
		const parseResult = this.commandParser.parseCommandSegments(command)
		if (!parseResult) {
			// Parsing failed - be conservative and block
			return { allowed: false, reason: "shell_operator_detected", detectedOperator: "parse_error" }
		}

		return this.validateParsedCommand(parseResult)
	}

	/** Recursively validate a parsed command structure. */
	private validateParsedCommand(parsed: ParsedCommand): PermissionValidationResult {
		// Check if redirects are allowed
		if (parsed.hasRedirects && !this.config?.allowRedirects) {
			return { allowed: false, reason: "redirect_detected" }
		}

		// Validate each command segment
		const isMultiSegment = parsed.segments.length > 1 || parsed.subshells.length > 0
		for (const segment of parsed.segments) {
			const result = this.ruleEvaluator.validateSingleCommand(segment, this.config!)
			if (!result.allowed) {
				return isMultiSegment ? this.toSegmentResult(result, segment) : result
			}
		}

		// Recursively validate subshell contents
		for (const subshell of parsed.subshells) {
			const result = this.validateParsedCommand(subshell)
			if (!result.allowed) return result
		}

		return { allowed: true, reason: "allowed" }
	}

	/** Convert a validation result to a segment-specific result for multi-segment commands. */
	private toSegmentResult(result: PermissionValidationResult, segment: string): PermissionValidationResult {
		const segmentReason =
			result.reason === "denied"
				? "segment_denied"
				: result.reason === "no_match_deny_default"
					? "segment_no_match"
					: result.reason
		return { ...result, failedSegment: segment, reason: segmentReason }
	}

	/** Clean up resources when the controller is no longer needed. */
	async dispose(): Promise<void> {
		if (this.fileWatcher) {
			await this.fileWatcher.close()
			this.fileWatcher = undefined
		}
	}
}
