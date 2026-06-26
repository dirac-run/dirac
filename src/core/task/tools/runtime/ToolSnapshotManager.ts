import { ulid } from "ulid"
import { DiracToolSet } from "@core/prompts/system-prompt/registry/DiracToolSet"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { DiracDefaultTool } from "@/shared/tools"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolRegistry } from "../registry/ToolRegistry"
import { refreshToolRegistryForWorkspace } from "../registry/refreshToolRegistry"
import type { TaskConfig } from "../types/TaskConfig"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import { ToolInventorySnapshot, ToolRequestSnapshot, ToolSnapshotDirtyReason, validateToolRequestSnapshot } from "./ToolSnapshot"

interface ToolSnapshotManagerOptions {
	createTaskConfig: (coordinator: ToolExecutorCoordinator) => TaskConfig
	getWorkspaceRoot: () => string | undefined
	getToggles: () => Record<string, boolean>
}

export class ToolSnapshotManager {
	private inventoryDirty = true
	private togglesDirty = true
	private inventoryVersion = 0
	private inventorySnapshot?: ToolInventorySnapshot
	private activeRequestSnapshot?: ToolRequestSnapshot

	constructor(private readonly options: ToolSnapshotManagerOptions) {}

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
		const promptVisibleSpecs = this.buildPromptVisibleSpecs(inventory.enabledTools, context)
		const nativeTools = DiracToolSet.convertSpecsToNativeTools(promptVisibleSpecs, context)
		const dynamicSubagentToolNames = new Set(
			promptVisibleSpecs
				.filter((spec) => spec.id === DiracDefaultTool.USE_SUBAGENTS && spec.name !== DiracDefaultTool.USE_SUBAGENTS)
				.map((spec) => spec.name),
		)
		const executableToolNames = new Set([...inventory.executableToolNames, ...dynamicSubagentToolNames])

		const snapshot: ToolRequestSnapshot = {
			inventoryVersion: inventory.version,
			requestId: ulid(),
			promptVisibleSpecs,
			inventoryEnabledTools: inventory.enabledTools,
			nativeTools,
			coordinator: inventory.coordinator,
			executableToolNames,
			dynamicSubagentToolNames,
		}

		validateToolRequestSnapshot(snapshot)
		return snapshot
	}

	private async getInventorySnapshot(): Promise<ToolInventorySnapshot> {
		if (!this.inventoryDirty && !this.togglesDirty && this.inventorySnapshot) {
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
		this.togglesDirty = false
		return this.inventorySnapshot
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
