import * as path from "node:path"
import { getOrDiscoverSkills } from "@core/context/instructions/user-instructions/skills"
import { PromptRegistry, DiracToolSet } from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { validateToolRequestSnapshot, type ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { HostRegistryInfo } from "@/registry"
import { DiracDefaultTool, DiracTool } from "@shared/tools"
import { Logger } from "@shared/services/Logger"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import type { TaskConfig } from "../types/TaskConfig"
import { ToolRegistry } from "../registry/ToolRegistry"
import { SubagentBuilder } from "./SubagentBuilder"

// Builds the system prompt context and tool request snapshot for subagent runs.
export class SubagentContextBuilder {
	constructor(private baseConfig: TaskConfig, private agent: SubagentBuilder, private allowedTools: string[], private apiHandler: any) {}

	// Builds the full system prompt context for the subagent run.
	async buildContext(): Promise<{ context: SystemPromptContext; systemPrompt: string; requestSnapshot: ToolRequestSnapshot; useNativeToolCalls: boolean }> {
		const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
		const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
		const api = this.apiHandler
		const providerId = (mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider) as string
		const providerInfo = { providerId, phone: undefined, model: api.getModel(), mode, customPrompt: this.baseConfig.services.stateManager.getGlobalSettingsKey("customPrompt") }
		const host = HostRegistryInfo.get()
		const availableSkills = await getOrDiscoverSkills(this.baseConfig.cwd, this.baseConfig.taskState)
		const skills = this.resolveSkills(availableSkills)
		const context: SystemPromptContext = {
			providerInfo, cwd: this.baseConfig.cwd, ide: host?.platform || "Unknown", skills,
			browserSettings: this.baseConfig.browserSettings, yoloModeToggled: false, enableParallelToolCalling: false, isSubagentRun: true,
			isMultiRootEnabled: this.baseConfig.isMultiRootEnabled,
			workspaceRoots: this.baseConfig.workspaceManager?.getRoots().map((root) => ({ path: root.path, name: root.name || path.basename(root.path), vcs: root.vcs })),
		}
		const requestSnapshot = this.buildSubagentRequestSnapshot(context)
		const promptRegistry = PromptRegistry.getInstance()
		const generatedSystemPrompt = await promptRegistry.get(context, requestSnapshot)
		const systemPrompt = this.agent.buildSystemPrompt(generatedSystemPrompt)
		return { context, systemPrompt, requestSnapshot, useNativeToolCalls: requestSnapshot.nativeTools.length > 0 }
	}

	// Appends execution limits (timeout/maxTurns) to the system prompt.
	appendExecutionLimits(systemPrompt: string, timeout?: number, maxTurns?: number): string {
		if (!timeout && !maxTurns) return systemPrompt
		const limits = []
		if (timeout) limits.push(`${timeout} seconds`)
		if (maxTurns) limits.push(`${maxTurns} turns`)
		return systemPrompt + `\n\n# Execution Limits\nYou must complete your task and call attempt_completion within ${limits.join(" and ")}.`
	}

	private resolveSkills(availableSkills: any[]): any[] {
		const configuredSkillNames = this.agent.getConfiguredSkills()
		if (configuredSkillNames === undefined) return availableSkills
		return configuredSkillNames.map((skillName) => {
			const skill = availableSkills.find((candidate) => candidate.name === skillName)
			if (!skill) Logger.warn(`[SubagentRunner] Configured skill '${skillName}' not found for subagent run.`)
			return skill
		}).filter((skill): skill is any => Boolean(skill))
	}

	buildSubagentRequestSnapshot(context: SystemPromptContext): ToolRequestSnapshot {
		const enabledTools = this.baseConfig.activeToolSnapshot?.inventoryEnabledTools ?? ToolRegistry.getInstance().getEnabledTools()
		const allowedEnabledTools = enabledTools.filter((tool) => this.isDiscoveredToolAllowed(tool))
		const contextFilteredSpecs = allowedEnabledTools.map((tool) => tool.spec).filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
		const promptVisibleSpecs = DiracToolSet.withDynamicSubagentToolSpecs(contextFilteredSpecs, context).filter((spec) => spec.id !== DiracDefaultTool.USE_SUBAGENTS || this.allowedTools.includes(spec.name))
		const coordinator = this.buildSubagentCoordinator(allowedEnabledTools)
		const nativeTools = DiracToolSet.convertSpecsToNativeTools(promptVisibleSpecs, context)
		const snapshot = subagentToolSnapshot(promptVisibleSpecs, nativeTools, allowedEnabledTools, coordinator)
		validateToolRequestSnapshot(snapshot)
		return snapshot
	}

	private buildSubagentCoordinator(enabledTools: DiscoveredTool[]): ToolExecutorCoordinator {
		const coordinator = new ToolExecutorCoordinator()
		for (const tool of enabledTools) coordinator.registerModularTool(tool.factory(this.baseConfig))
		return coordinator
	}

	isDiscoveredToolAllowed(tool: DiscoveredTool): boolean {
		const allowedSet = new Set(this.allowedTools)
		return allowedSet.has(tool.id) || allowedSet.has(tool.name) || allowedSet.has(tool.spec.name)
	}
}

function subagentToolSnapshot(promptVisibleSpecs: ToolRequestSnapshot["promptVisibleSpecs"], nativeTools: DiracTool[], inventoryEnabledTools: readonly DiscoveredTool[], coordinator: ToolExecutorCoordinator): ToolRequestSnapshot {
	return { inventoryVersion: 0, requestId: "subagent", promptVisibleSpecs, inventoryEnabledTools, nativeTools, coordinator, executableToolNames: new Set(promptVisibleSpecs.map((spec) => spec.name)), dynamicSubagentToolNames: new Set() }
}
