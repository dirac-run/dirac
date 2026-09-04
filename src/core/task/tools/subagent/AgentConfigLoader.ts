import { LEGACY_RESPONSE_TOOLS, RESPOND_TOOL_NAME } from "@shared/responseTool"
import { Logger } from "@shared/services/Logger"
import { setDynamicToolUseNames } from "@shared/tools"
import { parseYamlFrontmatter } from "@utils/frontmatter"
import chokidar, { type FSWatcher } from "chokidar"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { z } from "zod"
import { toError } from "@/shared/errors"
import { ChokidarWatcherCloser } from "@/shared/utils/ChokidarWatcherCloser"
import { buildSubagentToolName } from "./SubagentToolName"

/** Default Directory for agent configurations: ~/Documents/Dirac/Agents */
export const AGENTS_CONFIG_DIRECTORY_NAME = "Agents"
const SUBAGENT_DYNAMIC_TOOL_NAMESPACE = "subagent"

const AgentBaseConfigSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	tools: z.array(z.string()).default([]),
	skills: z.array(z.string().trim().min(1)).optional(),
	modelId: z.string().trim().min(1).optional(),
	systemPrompt: z.string().trim().min(1),
})

const AgentConfigFrontmatterSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	modelId: z.string().trim().min(1).optional(),
	tools: z.union([z.string(), z.array(z.string())]).optional(),
	skills: z.union([z.string(), z.array(z.string())]).optional(),
})

export type AgentBaseConfig = z.infer<typeof AgentBaseConfigSchema>

function normalizeToolName(toolName: string): string[] {
	const trimmed = toolName.trim()
	if (!trimmed) {
		throw new Error("Tool name cannot be empty.")
	}

	const operation = LEGACY_RESPONSE_TOOLS[trimmed as keyof typeof LEGACY_RESPONSE_TOOLS]
	return [operation ? `${RESPOND_TOOL_NAME}:${operation}` : trimmed]
}

function parseTools(tools: string | string[] | undefined): string[] {
	if (!tools) {
		return []
	}

	const rawTools = Array.isArray(tools) ? tools : tools.split(",")
	if (rawTools.length === 0) {
		return []
	}
	return Array.from(new Set(rawTools.flatMap(normalizeToolName)))
}

function normalizeSkillName(skillName: string): string {
	const trimmed = skillName.trim()
	if (!trimmed) {
		throw new Error("Skill name cannot be empty.")
	}
	return trimmed
}

function parseSkills(skills: string | string[] | undefined): string[] | undefined {
	if (skills === undefined) {
		return undefined
	}

	const rawSkills = Array.isArray(skills) ? skills : skills.split(",")
	return Array.from(new Set(rawSkills.map(normalizeSkillName)))
}

export function parseAgentConfigFromYaml(content: string): AgentBaseConfig {
	const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(content)
	if (parseError) {
		throw new Error(`Failed to parse YAML frontmatter: ${parseError}`)
	}
	if (!hadFrontmatter) {
		throw new Error("Missing YAML frontmatter block in agent config file.")
	}

	const parsedFrontmatter = AgentConfigFrontmatterSchema.parse(data)
	const systemPrompt = body.trim()
	if (!systemPrompt) {
		throw new Error("Missing system prompt body in agent config file.")
	}

	return AgentBaseConfigSchema.parse({
		name: parsedFrontmatter.name,
		description: parsedFrontmatter.description,
		modelId: parsedFrontmatter.modelId,
		tools: parseTools(parsedFrontmatter.tools),
		skills: parseSkills(parsedFrontmatter.skills),
		systemPrompt,
	}) as AgentBaseConfig
}

/**
 * Resolves the agents configuration directory path.
 * Defaults to ~/.dirac/Agents to avoid macOS ~/Documents TCC sandbox restrictions.
 */
export function getAgentsConfigPath(homeDir = os.homedir()): string {
	const baseDir = process.env.DIRAC_DIR || path.join(homeDir, ".dirac")
	return path.join(baseDir, AGENTS_CONFIG_DIRECTORY_NAME)
}

/**
 * Returns the legacy ~/Documents/Dirac/Agents path used for backward-compatible migration.
 */
export function getLegacyAgentsConfigPath(homeDir = os.homedir()): string {
	return path.join(homeDir, "Documents", "Dirac", AGENTS_CONFIG_DIRECTORY_NAME)
}

function normalizeAgentName(name: string): string {
	return name.trim().toLowerCase()
}

function isYamlFile(filePath: string): boolean {
	return /\.(yaml|yml)$/i.test(filePath)
}

function isExpectedMigrationError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code
	return code === "ENOENT" || code === "EPERM" || code === "EACCES"
}

async function migrateLegacyAgentConfigs(legacyPath: string, newPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(legacyPath, { withFileTypes: true })
		await fs.mkdir(newPath, { recursive: true })
		await Promise.all(
			entries
				.filter((entry) => entry.isFile() && isYamlFile(entry.name))
				.map(async (entry) => {
					const src = path.join(legacyPath, entry.name)
					const dest = path.join(newPath, entry.name)
					try {
						await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL)
						Logger.debug(`[AgentConfigLoader] Migrated legacy agent config '${entry.name}' to ${dest}`)
					} catch (copyErr) {
						if ((copyErr as NodeJS.ErrnoException).code !== "EEXIST") {
							Logger.warn(`[AgentConfigLoader] Failed to copy legacy agent config '${entry.name}': ${copyErr}`)
						}
					}
				}),
		)
	} catch (error) {
		if (isExpectedMigrationError(error)) {
			return
		}
		Logger.warn(`[AgentConfigLoader] Failed to read legacy agent configs from '${legacyPath}': ${error}`)
	}
}

export async function readAgentConfigsFromDisk(homeDir = os.homedir()): Promise<Map<string, AgentBaseConfig>> {
	const agentsDirectoryPath = getAgentsConfigPath(homeDir)
	const legacyDirectoryPath = getLegacyAgentsConfigPath(homeDir)
	await migrateLegacyAgentConfigs(legacyDirectoryPath, agentsDirectoryPath)
	const configs = new Map<string, AgentBaseConfig>()

	try {
		const entries = await fs.readdir(agentsDirectoryPath, { withFileTypes: true })
		const yamlFiles = entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.filter(isYamlFile)
			.sort((a, b) => a.localeCompare(b))
		Logger.debug(`[AgentConfigLoader] Found ${yamlFiles.length} YAML file(s).`)

		await Promise.all(
			yamlFiles.map(async (fileName) => {
				const filePath = path.join(agentsDirectoryPath, fileName)
				try {
					const content = await fs.readFile(filePath, "utf8")
					const parsed = parseAgentConfigFromYaml(content)
					Logger.debug(`[AgentConfigLoader] Loaded agent config '${fileName}'`, parsed)
					configs.set(normalizeAgentName(parsed.name), parsed)
				} catch (error) {
					Logger.error(`[AgentConfigLoader] Failed to parse agent config '${fileName}'`, error)
				}
			}),
		)

		return configs
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code === "ENOENT") {
			return configs
		}
		Logger.error("[AgentConfigLoader] Failed to read agent configs from disk", error)
		throw error
	}
}

export type AgentConfigChangeListener = (configs: ReadonlyMap<string, AgentBaseConfig>, error?: Error) => void

export class AgentConfigLoader {
	private static instance?: AgentConfigLoader

	private readonly homeDir: string
	private readonly directoryPath: string
	private readonly initialLoadPromise: Promise<void>
	private watcher?: FSWatcher
	private readonly watcherCloser = new ChokidarWatcherCloser()
	private disposed = false
	private cachedConfigs = new Map<string, AgentBaseConfig>()
	private cachedAgentToolNames = new Map<string, string>()
	private cachedToolNameToAgentName = new Map<string, string>()
	private listeners = new Set<AgentConfigChangeListener>()

	private constructor(homeDir = os.homedir()) {
		this.homeDir = homeDir
		this.directoryPath = getAgentsConfigPath(homeDir)
		this.initialLoadPromise = this.load()
			.then(() => undefined)
			.catch((error) => {
				Logger.error("[AgentConfigLoader] Failed to load initial agent configs", error)
			})
			.finally(() =>
				this.watch().catch((error) => Logger.error("[AgentConfigLoader] Failed to start watching agent configs", error)),
			)
	}

	public static getInstance(homeDir = os.homedir()): AgentConfigLoader {
		if (!AgentConfigLoader.instance) {
			AgentConfigLoader.instance = new AgentConfigLoader(homeDir)
		}
		return AgentConfigLoader.instance
	}

	/**
	 * Test-only helper to clear singleton state between unit tests.
	 */
	public static async resetInstanceForTests(): Promise<void> {
		if (!AgentConfigLoader.instance) {
			return
		}

		await AgentConfigLoader.instance.dispose()
		AgentConfigLoader.instance = undefined
	}

	public getConfigPath(): string {
		return this.directoryPath
	}

	public async ready(): Promise<void> {
		await this.initialLoadPromise
	}

	public getCachedConfig(subagentName?: string): AgentBaseConfig | undefined {
		if (!subagentName?.trim()) {
			return undefined
		}
		return this.cachedConfigs.get(normalizeAgentName(subagentName))
	}

	public getAllCachedConfigs(): ReadonlyMap<string, AgentBaseConfig> {
		return new Map(this.cachedConfigs)
	}

	public getAllCachedConfigsWithToolNames(): Array<{ toolName: string; config: AgentBaseConfig }> {
		const result: Array<{ toolName: string; config: AgentBaseConfig }> = []
		for (const [normalizedName, config] of this.cachedConfigs.entries()) {
			const toolName = this.cachedAgentToolNames.get(normalizedName)
			if (toolName) {
				result.push({ toolName, config })
			}
		}
		return result
	}

	public resolveSubagentNameForTool(toolName?: string): string | undefined {
		if (!toolName?.trim()) {
			return undefined
		}

		const normalizedName = this.cachedToolNameToAgentName.get(toolName.trim())
		if (!normalizedName) {
			return undefined
		}

		return this.cachedConfigs.get(normalizedName)?.name
	}

	public isDynamicSubagentTool(toolName?: string): boolean {
		if (!toolName?.trim()) {
			return false
		}
		return this.cachedToolNameToAgentName.has(toolName.trim())
	}

	public async load(): Promise<ReadonlyMap<string, AgentBaseConfig>> {
		const configs = await readAgentConfigsFromDisk(this.homeDir)
		this.cachedConfigs = configs
		this.rebuildDynamicToolMappings()
		Logger.debug(`[AgentConfigLoader] Loaded ${configs.size} agent config(s) from disk.`)
		return this.getAllCachedConfigs()
	}

	public async watch(listener?: AgentConfigChangeListener): Promise<void> {
		await this.watcherCloser.closeAll()
		if (this.disposed) return
		if (listener) {
			this.listeners.add(listener)
		}

		if (this.watcher) {
			return
		}

		try {
			await fs.mkdir(this.directoryPath, { recursive: true })
			const watcher = chokidar.watch(this.directoryPath, {
				persistent: true,
				ignoreInitial: true,
				awaitWriteFinish: {
					stabilityThreshold: 300,
					pollInterval: 100,
				},
			})
			this.watcher = watcher
			watcher
				.on("error", (error) => {
					if (this.watcher !== watcher) return
					this.watcher = undefined
					const watcherError = toError(error)
					const isPerm = (watcherError as any).code === "EPERM" || (watcherError as any).code === "EACCES"
					if (isPerm) {
						Logger.warn(
							`[AgentConfigLoader] Agent config live reload is disabled due to missing filesystem permissions on '${this.directoryPath}'`,
						)
					} else {
						Logger.error(
							"[AgentConfigLoader] Agent config live reload is disabled after watcher failure",
							watcherError,
						)
					}
					this.notify(this.cachedConfigs, watcherError)
					void this.watcherCloser
						.close(watcher)
						.catch((closeError) =>
							Logger.warn("[AgentConfigLoader] Failed to close disabled agent config watcher", closeError),
						)
				})
				.on("add", (filePath) => {
					if (this.watcher !== watcher) return
					if (isYamlFile(filePath)) {
						void this.reloadAndNotify()
					}
				})
				.on("change", (filePath) => {
					if (this.watcher !== watcher) return
					if (isYamlFile(filePath)) {
						void this.reloadAndNotify()
					}
				})
				.on("unlink", (filePath) => {
					if (this.watcher !== watcher) return
					if (isYamlFile(filePath)) {
						void this.reloadAndNotify()
					}
				})
		} catch (error) {
			this.watcher = undefined
			const watcherError = toError(error)
			const isPerm = (watcherError as any).code === "EPERM" || (watcherError as any).code === "EACCES"
			if (isPerm) {
				Logger.warn(
					`[AgentConfigLoader] Agent config live reload could not start due to missing filesystem permissions on '${this.directoryPath}'`,
				)
			} else {
				Logger.error("[AgentConfigLoader] Agent config live reload could not start and is disabled", watcherError)
			}
			this.notify(this.cachedConfigs, watcherError)
		}
	}

	public unwatch(listener: AgentConfigChangeListener): void {
		this.listeners.delete(listener)
	}

	public async dispose(): Promise<void> {
		this.disposed = true
		const watcher = this.watcher
		this.watcher = undefined
		await this.watcherCloser.closeAll(watcher ? [watcher] : [])
	}

	private async reloadAndNotify(): Promise<void> {
		try {
			await this.load()
			this.notify(this.cachedConfigs)
		} catch (error) {
			const parseError = toError(error)
			Logger.error("[AgentConfigLoader] Failed to reload agent configs", parseError)
			this.notify(this.cachedConfigs, parseError)
		}
	}

	private notify(configs: ReadonlyMap<string, AgentBaseConfig>, error?: Error): void {
		for (const listener of this.listeners) {
			try {
				listener(new Map(configs), error)
			} catch (listenerError) {
				Logger.error("[AgentConfigLoader] Agent config listener failed", listenerError)
			}
		}
	}

	private rebuildDynamicToolMappings(): void {
		const sortedConfigs = Array.from(this.cachedConfigs.entries()).sort((a, b) => a[0].localeCompare(b[0]))
		const usedToolNames = new Set<string>()
		const agentToolNames = new Map<string, string>()
		const toolNameToAgentName = new Map<string, string>()

		for (const [normalizedName, config] of sortedConfigs) {
			const baseName = buildSubagentToolName(config.name)
			let candidate = baseName
			let suffix = 2
			while (usedToolNames.has(candidate)) {
				const suffixText = `_${suffix++}`
				const maxBaseLength = Math.max(1, 64 - suffixText.length)
				candidate = `${baseName.slice(0, maxBaseLength)}${suffixText}`
			}

			usedToolNames.add(candidate)
			agentToolNames.set(normalizedName, candidate)
			toolNameToAgentName.set(candidate, normalizedName)
		}

		this.cachedAgentToolNames = agentToolNames
		this.cachedToolNameToAgentName = toolNameToAgentName
		setDynamicToolUseNames(SUBAGENT_DYNAMIC_TOOL_NAMESPACE, Array.from(toolNameToAgentName.keys()))
	}
}
