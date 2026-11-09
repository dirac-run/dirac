import type { WatcherFactory } from "@core/ignore/DiracIgnoreController"
import chokidar, { FSWatcher } from "chokidar"
import fs from "fs/promises"
import path from "path"
import { commandPermissionsEnv } from "@/shared/config/environment"
import { Logger } from "@/shared/services/Logger"
import { ChokidarWatcherCloser } from "@/shared/utils/ChokidarWatcherCloser"
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
	private readonly watcherCloser = new ChokidarWatcherCloser()
	private disposed = false
	private config: CommandPermissionConfig | null = null
	private configRevision = 0
	private configLoadGeneration = 0
	private configError: Error | null = null
	private hasValidConfig = false

	/** Changes independently of Task working configuration (including live file reloads). */
	get revision(): number {
		return this.configRevision
	}
	private readonly ruleEvaluator = new PermissionRuleEvaluator()
	private readonly commandParser = new CommandParser()
	private readonly dangerousCharDetector = new DangerousCharDetector()

	constructor(private watcherFactory: WatcherFactory = chokidar.watch) {
		try {
			this.config = this.parseConfigFromEnv()
		} catch (error) {
			this.configError = new Error(`Invalid ${COMMAND_PERMISSIONS_ENV_VAR} configuration`, { cause: error })
			Logger.error(this.configError.message, error)
		}
	}

	/** Initialize the controller with a workspace root and load configuration from file. */
	async initialize(workspaceRoot: string): Promise<void> {
		if (this.disposed) return
		this.workspaceRoot = workspaceRoot
		await this.loadConfig()
		await this.setupFileWatcher()
	}

	/** Set up a file watcher for .dirac/permissions.json */
	private async setupFileWatcher(): Promise<void> {
		await this.watcherCloser.closeAll()
		if (this.disposed) return
		if (this.fileWatcher) {
			const previousWatcher = this.fileWatcher
			this.fileWatcher = undefined
			await this.watcherCloser.close(previousWatcher)
		}
		if (this.disposed || !this.workspaceRoot || this.fileWatcher) return

		const configPath = path.join(this.workspaceRoot, ".dirac", "permissions.json")
		try {
			const watcher = this.watcherFactory(configPath, {
				persistent: true,
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
				atomic: true,
			})
			this.fileWatcher = watcher
			watcher.on("error", (error) => {
				if (this.fileWatcher !== watcher) return
				this.fileWatcher = undefined
				Logger.error("Command permissions live reload is disabled after watcher failure:", error)
				void this.watcherCloser
					.close(watcher)
					.catch((closeError) => Logger.error("Failed to close disabled command permissions watcher:", closeError))
			})
			watcher.on("all", (_event) => {
				if (this.fileWatcher !== watcher) return
				void this.loadConfig().catch((error) => {
					Logger.error("Failed to reload command permissions:", error)
				})
			})
		} catch (error) {
			this.fileWatcher = undefined
			Logger.error("Command permissions live reload could not start and is disabled:", error)
		}
	}

	/** Load a complete valid snapshot; invalid updates must not replace existing restrictions. */
	private async loadConfig(): Promise<void> {
		const generation = ++this.configLoadGeneration
		try {
			const envConfig = this.parseConfigFromEnv()
			const fileConfig = await this.loadConfigFromFile()
			if (generation !== this.configLoadGeneration) return
			this.config = {
				...envConfig,
				...fileConfig,
				rules: [...(envConfig?.rules || []), ...(fileConfig?.rules || [])],
			}
			this.hasValidConfig = true
			this.configError = null
		} catch (error) {
			if (generation !== this.configLoadGeneration) return
			this.configError = new Error("Invalid command permission configuration", { cause: error })
			Logger.error("Failed to load command permissions; retaining the last valid restrictions:", error)
		}
		this.configRevision++
	}

	/** Only a missing file means no project configuration; invalid and unreadable files are errors. */
	private async loadConfigFromFile(): Promise<CommandPermissionConfig | null> {
		if (!this.workspaceRoot) return null

		const configPath = path.join(this.workspaceRoot, ".dirac", "permissions.json")
		try {
			const content = await fs.readFile(configPath, "utf8")
			return this.parseConfig(content)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
			throw new Error(`Failed to read permission configuration at ${configPath}`, { cause: error })
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

		const content = JSON.stringify(config, null, 2)
		this.parseConfig(content)
		const diracDir = path.join(this.workspaceRoot, ".dirac")
		const configPath = path.join(diracDir, "permissions.json")
		await fs.mkdir(diracDir, { recursive: true })
		await fs.writeFile(configPath, content, "utf8")
		await this.loadConfig()
	}

	private isConfigEmpty(): boolean {
		if (!this.config) return true
		return !(this.config.rules?.length || this.config.allow?.length || this.config.deny?.length)
	}

	/** Parse the DIRAC_COMMAND_PERMISSIONS environment variable without discarding invalid restrictions. */
	private parseConfigFromEnv(): CommandPermissionConfig | null {
		const envValue = commandPermissionsEnv()
		if (!envValue) return null
		return this.parseConfig(envValue)
	}

	/** Invalid configuration must never be overridden by automatic approval or a remembered grant. */
	assertConfigurationValid(): void {
		if (this.configError) throw this.configError
	}

	private parseConfig(content: string): CommandPermissionConfig {
		const parsed = JSON.parse(content)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Permission configuration must be an object")
		}
		for (const key of ["allow", "deny"] as const) {
			if (
				parsed[key] !== undefined &&
				(!Array.isArray(parsed[key]) || !parsed[key].every((pattern: unknown) => typeof pattern === "string"))
			) {
				throw new Error(`Permission ${key} must be an array of strings`)
			}
		}
		if (parsed.allowRedirects !== undefined && typeof parsed.allowRedirects !== "boolean") {
			throw new Error("Permission allowRedirects must be a boolean")
		}
		if (parsed.rules !== undefined) {
			if (!Array.isArray(parsed.rules)) throw new Error("Permission rules must be an array")
			for (const rule of parsed.rules) {
				if (
					!rule ||
					typeof rule !== "object" ||
					Array.isArray(rule) ||
					typeof rule.tool !== "string" ||
					!rule.tool ||
					(rule.action !== "allow" && rule.action !== "deny") ||
					(rule.pattern !== undefined && typeof rule.pattern !== "string")
				) {
					throw new Error("Permission rules require a tool, allow/deny action, and optional string pattern")
				}
			}
		}
		return parsed as CommandPermissionConfig
	}

	/** Applicable restriction tokens, independent of unrelated settings, rule order, and command identity. */
	getCommandRestrictionContext(command: string): readonly string[] {
		this.assertConfigurationValid()
		if (this.isConfigEmpty()) return []

		const restrictions = new Set<string>()
		const rules = this.config?.rules || []
		for (const rule of rules) {
			if (rule.action === "deny" && this.ruleEvaluator.matchesRule(rule, "execute_command", command)) {
				restrictions.add(JSON.stringify(["rule", rule.tool, rule.pattern ?? null]))
			}
		}
		const explicitlyAllowed = rules.some(
			(rule) => rule.action === "allow" && this.ruleEvaluator.matchesRule(rule, "execute_command", command),
		)
		if (!explicitlyAllowed) {
			const dangerousChar = this.dangerousCharDetector.detect(command)
			if (dangerousChar) restrictions.add(JSON.stringify(["shell_operator", dangerousChar.operator]))
		}
		const parsed = this.commandParser.parseCommandSegments(command)
		if (!parsed) restrictions.add("parse_error")
		else this.collectParsedCommandRestrictions(parsed, restrictions)
		return [...restrictions].sort()
	}

	private collectParsedCommandRestrictions(parsed: ParsedCommand, restrictions: Set<string>): void {
		const config = this.config!
		if (parsed.hasRedirects && !config.allowRedirects) restrictions.add("redirects")
		for (const segment of parsed.segments) {
			const matchingRules = (config.rules || []).filter(
				(rule) => rule.pattern && this.ruleEvaluator.matchesRule(rule, "execute_command", segment),
			)
			for (const rule of matchingRules) {
				if (rule.action === "deny") restrictions.add(JSON.stringify(["rule", rule.tool, rule.pattern]))
			}
			if (matchingRules.some((rule) => rule.action === "allow")) continue
			for (const pattern of config.deny || []) {
				if (this.ruleEvaluator.matchesPattern(segment, pattern)) restrictions.add(JSON.stringify(["deny", pattern]))
			}
			if (config.allow?.length && !config.allow.some((pattern) => this.ruleEvaluator.matchesPattern(segment, pattern))) {
				restrictions.add("allowlist")
			}
		}
		for (const subshell of parsed.subshells) this.collectParsedCommandRestrictions(subshell, restrictions)
	}

	validateTool(tool: string, pattern?: string): PermissionValidationResult {
		if (this.configError && !this.hasValidConfig) return { allowed: false, reason: "denied" }
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
		if (this.configError && !this.hasValidConfig) return { allowed: false, reason: "denied" }
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
		this.disposed = true
		const watcher = this.fileWatcher
		this.fileWatcher = undefined
		await this.watcherCloser.closeAll(watcher ? [watcher] : [])
	}
}
