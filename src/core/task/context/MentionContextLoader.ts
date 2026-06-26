import { parseMentions } from "@core/mentions"
import { parseSlashCommands } from "@core/slash-commands"
import { SkillMetadata } from "@/shared/skills"
import { refreshToolRegistryForWorkspace } from "../tools/registry/refreshToolRegistry"
import { ToolRegistry } from "../tools/registry/ToolRegistry"
import { FileContextLoader } from "./FileContextLoader"
import { ContextLoaderDependencies } from "../types/context-loader"

export interface EnrichContextResult {
	enrichedText: string
	needsDiracrulesFileCheck: boolean
	isDirectResponse?: boolean
	directResponseText?: string
}

export class MentionContextLoader {
	constructor(
		private dependencies: ContextLoaderDependencies,
		private fileContextLoader: FileContextLoader,
	) {}

	// Parse mentions and slash commands, then optionally enrich with file/symbol context
	async enrichContext(
		text: string,
		cwd: string,
		localWorkflowToggles: any,
		globalWorkflowToggles: any,
		ulid: string,
		providerInfo: any,
		includePathContext: boolean,
		availableSkills: SkillMetadata[],
	): Promise<EnrichContextResult> {
		const parsedText = await parseMentions(text, cwd, this.urlContentFetcher, this.fileContextTracker, this.workspaceManager)
		const { processedText, needsDiracrulesFileCheck, isDirectResponse, directResponseText } = await parseSlashCommands(
			parsedText,
			localWorkflowToggles,
			globalWorkflowToggles,
			ulid,
			providerInfo,
			availableSkills,
			this.dependencies.commandPermissionController,
			this.dependencies.extensionPath,
			this.dependencies.sourceDir,
		)

		// Handle /reloadtools direct response: trigger tool registry refresh
		if (isDirectResponse && directResponseText === "__RELOAD_TOOLS__") return await this.handleReloadTools()

		// Skip automatic path and symbol detection for subsequent turns
		if (!includePathContext)
			return { enrichedText: processedText, needsDiracrulesFileCheck, isDirectResponse, directResponseText }

		const { filePaths, directoryPaths, symbols } = await this.fileContextLoader.extractContext(text, cwd)
		const { skeletons, directoryLists } = await this.fileContextLoader.getPathContext(filePaths, directoryPaths, cwd)
		const symbolDefinitions = await this.fileContextLoader.getSymbolContext(symbols, cwd)

		const additionalContext = [...skeletons, ...directoryLists, ...symbolDefinitions]
		if (additionalContext.length > 0) {
			return { enrichedText: `${processedText}\n\n${additionalContext.join("\n\n")}`, needsDiracrulesFileCheck }
		}
		return { enrichedText: processedText, needsDiracrulesFileCheck, isDirectResponse, directResponseText }
	}

	// Refresh tool registry and build a summary response for /reloadtools
	private async handleReloadTools(): Promise<EnrichContextResult> {
		const primaryRootPath = this.workspaceManager?.getPrimaryRoot()?.path
		await refreshToolRegistryForWorkspace({ workspaceRoot: primaryRootPath, includeUserTools: true })
		await this.dependencies.postStateToWebview()
		const registry = ToolRegistry.getInstance()
		const allTools = registry.getAllTools()
		const userTools = allTools.filter((t) => t.source !== "builtin")
		const enabledTools = registry.getEnabledTools()
		const userToolSummary =
			userTools.length > 0
				? userTools
						.map(
							(t) =>
								`  - ${t.id} (${t.source}) — ${enabledTools.some((e) => e.id === t.id) ? "enabled" : "disabled"}`,
						)
						.join("\n")
				: "  (none found)"
		const reloadResponse = [
			`Tools reloaded. Found ${allTools.length} total tools (${userTools.length} user tools).`,
			"",
			"User tools:",
			userToolSummary,
			"",
			"Note: User tools are disabled by default. Enable them in Settings \u2192 Tools or by toggling the switch.",
		].join("\n")
		return { enrichedText: "", needsDiracrulesFileCheck: false, isDirectResponse: true, directResponseText: reloadResponse }
	}

	private get urlContentFetcher() {
		return this.dependencies.urlContentFetcher
	}
	private get fileContextTracker() {
		return this.dependencies.fileContextTracker
	}
	private get workspaceManager() {
		return this.dependencies.workspaceManager
	}
}
