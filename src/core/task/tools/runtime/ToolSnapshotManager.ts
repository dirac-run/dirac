import { ulid } from "ulid"
import { DiracToolSet } from "@core/prompts/system-prompt/registry/DiracToolSet"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { DiracDefaultTool } from "@/shared/tools"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolRegistry } from "../registry/ToolRegistry"
import { refreshToolRegistryForWorkspace } from "../registry/refreshToolRegistry"
import type { TaskConfig } from "../types/TaskConfig"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import type { SkillMetadata } from "@shared/skills"
import { ToolInventorySnapshot, ToolRequestSnapshot, ToolSnapshotDirtyReason, validateToolRequestSnapshot } from "./ToolSnapshot"

import { Logger } from "@/shared/services/Logger"

interface ToolSnapshotManagerOptions {
	createTaskConfig: (coordinator: ToolExecutorCoordinator) => TaskConfig
	getWorkspaceRoot: () => string | undefined
	getToggles: () => Record<string, boolean>
	getActiveSkills: () => readonly SkillMetadata[]
}

export class ToolSnapshotManager {
	private inventoryDirty = true
	private cachedRegistryVersion = -1
	private togglesDirty = true
	private inventoryVersion = 0
	private inventorySnapshot?: ToolInventorySnapshot
	private activeRequestSnapshot?: ToolRequestSnapshot

	constructor(private readonly options: ToolSnapshotManagerOptions) { }

	markDirty(reason: ToolSnapshotDirtyReason): void {
		if (reason === "tool_toggles_changed") {
			this.togglesDirty = true
			return
		}

		this.inventoryDirty = true
		this.togglesDirty = true
	}

	getActiveSnapshot(): ToolRequestSnapshot | undefined {
		return this.activeRequestSnapshot
	}

	activateSnapshot(snapshot: ToolRequestSnapshot): void {
		this.activeRequestSnapshot = snapshot
	}

	async getSnapshotForRequest(context: SystemPromptContext): Promise<ToolRequestSnapshot> {
		const inventory = await this.getInventorySnapshot()
		const activeSkills = this.options.getActiveSkills()
		const skillTools = ToolRegistry.getInstance().resolveSkillDependencyTools(activeSkills)
		const effectiveTools = this.mergeTools(inventory.enabledTools, skillTools)
		const promptVisibleSpecs = this.buildPromptVisibleSpecs(effectiveTools, context)
		const nativeTools = DiracToolSet.convertSpecsToNativeTools(promptVisibleSpecs, context)
		const dynamicSubagentToolNames = new Set(
			promptVisibleSpecs
				.filter((spec) => spec.id === DiracDefaultTool.USE_SUBAGENTS && spec.name !== DiracDefaultTool.USE_SUBAGENTS)
				.map((spec) => spec.name),
		)
		const coordinator = this.buildCoordinator(effectiveTools)
		this.validateInventoryCoordinator(effectiveTools, coordinator)
		const executableToolNames = new Set([...effectiveTools.map((tool) => tool.spec.name), ...dynamicSubagentToolNames])

		const snapshot: ToolRequestSnapshot = {
			inventoryVersion: inventory.version,
			requestId: ulid(),
			promptVisibleSpecs,
			inventoryEnabledTools: effectiveTools,
			activeSkillIds: activeSkills.map((skill) => skill.name),
			nativeTools,
			coordinator,
			executableToolNames,
			dynamicSubagentToolNames,
		}

		validateToolRequestSnapshot(snapshot)
		return snapshot
	}

	private async getInventorySnapshot(): Promise<ToolInventorySnapshot> {
		const registryVersion = ToolRegistry.getInstance().getVersion()
		if (!this.inventoryDirty && !this.togglesDirty && this.inventorySnapshot && registryVersion === this.cachedRegistryVersion) {
			return this.inventorySnapshot
		}

		if (this.inventoryDirty) {
			await refreshToolRegistryForWorkspace({
				workspaceRoot: this.options.getWorkspaceRoot(),
				includeUserTools: true,
				toggles: this.options.getToggles(),
			})
		} else if (this.togglesDirty) {
			ToolRegistry.getInstance().loadToggles(this.options.getToggles())
		}

		const registry = ToolRegistry.getInstance()
		const tools = registry.getAllTools()
		const enabledTools = registry.getEnabledTools()
		const coordinator = this.buildCoordinator(enabledTools)
		this.validateInventoryCoordinator(enabledTools, coordinator)
		const executableToolNames = new Set(enabledTools.map((tool) => tool.spec.name))

		this.inventoryVersion += 1
		this.inventorySnapshot = {
			version: this.inventoryVersion,
			tools,
			enabledTools,
			coordinator,
			executableToolNames,
			createdAt: Date.now(),
		}

		this.inventoryDirty = false
		this.cachedRegistryVersion = registry.getVersion()
		this.togglesDirty = false

		const toolIds = enabledTools.map((t) => `${t.id}(${t.source})`).join(", ")
		Logger.info(`[ToolSnapshotManager] Inventory rebuilt (v${this.inventoryVersion}): [${toolIds}]`)

		return this.inventorySnapshot
	}

	private mergeTools(baseTools: DiscoveredTool[], skillTools: DiscoveredTool[]): DiscoveredTool[] {
		const tools = new Map(baseTools.map((tool) => [tool.id, tool]))
		for (const tool of skillTools) tools.set(tool.id, tool)
		return [...tools.values()]
	}

	private buildCoordinator(enabledTools: DiscoveredTool[]): ToolExecutorCoordinator {
		const coordinator = new ToolExecutorCoordinator()
		const config = this.options.createTaskConfig(coordinator)

		for (const tool of enabledTools) {
			coordinator.registerModularTool(tool.factory(config))
		}

		return coordinator
	}

	private validateInventoryCoordinator(enabledTools: DiscoveredTool[], coordinator: ToolExecutorCoordinator): void {
		for (const tool of enabledTools) {
			if (!coordinator.has(tool.spec.name)) {
				throw new Error(`Enabled tool '${tool.spec.name}' was not registered in coordinator.`)
			}
		}
	}

	private buildPromptVisibleSpecs(enabledTools: DiscoveredTool[], context: SystemPromptContext) {
		const contextFilteredSpecs = enabledTools
			.map((tool) => tool.spec)
			.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))

		return DiracToolSet.withDynamicSubagentToolSpecs(contextFilteredSpecs, context)
	}
}
