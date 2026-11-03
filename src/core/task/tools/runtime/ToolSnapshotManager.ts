import { meetsHostCapabilityRequirement } from "@hosts/host-capabilities"
import { DiracToolSet } from "@core/prompts/system-prompt/registry/DiracToolSet"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { DiracDefaultTool } from "@/shared/tools"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { SurfaceToolEnvironmentFactory } from "../adapters/SurfaceAdapter"
import { ToolRegistry } from "../registry/ToolRegistry"
import { refreshToolRegistryForWorkspace } from "../registry/refreshToolRegistry"
import type { TaskConfig } from "../types/TaskConfig"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import type { SkillMetadata } from "@shared/skills"
import { ToolInventorySnapshot, ToolRequestSnapshot, ToolSnapshotDirtyReason, validateToolRequestSnapshot } from "./ToolSnapshot"
import { applyToolSelectionPolicy, type ToolSelectionPolicy } from "./ToolSelectionPolicy"

import { Logger } from "@/shared/services/Logger"

interface ToolSnapshotManagerOptions {
	createTaskConfig: (coordinator: ToolExecutorCoordinator) => TaskConfig
	getTaskId: () => string
	getWorkspaceRoot: () => string | undefined
	getToggles: () => Record<string, boolean>
	getSelectionPolicy: () => ToolSelectionPolicy | undefined
	getActiveSkills: () => readonly SkillMetadata[]
	isToolAvailable?: (tool: DiscoveredTool) => boolean
	allowedTools?: readonly string[]
	environmentFactory?: import("../interfaces/ToolEnvironmentFactory").ToolEnvironmentFactory
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

	async getSnapshotForRequest(
		context: SystemPromptContext,
		request: { requestId: string; configurationRevision: number },
	): Promise<ToolRequestSnapshot> {
		const captureSnapshot = (registry: ToolRegistry): ToolRequestSnapshot => {
			// Registry toggle state is process-global, so every task capture must install
			// this request's detached toggles before deriving enabled membership.
			registry.loadToggles(this.options.getToggles())
			const inventory = this.getInventorySnapshot(registry)
			const activeSkills = this.options.getActiveSkills().filter(meetsHostCapabilityRequirement)
			const skillTools = registry.resolveSkillDependencyTools(
				activeSkills,
				this.options.getTaskId(),
				this.options.getWorkspaceRoot(),
			)
			const selectedConfiguredTools = applyToolSelectionPolicy(
				inventory.tools,
				inventory.enabledTools,
				this.options.getSelectionPolicy(),
			)
			const effectiveTools = this.mergeTools(selectedConfiguredTools, skillTools).filter(
				(tool) => meetsHostCapabilityRequirement(tool.spec) && (this.options.isToolAvailable?.(tool) ?? true),
			)
				.map((tool) => this.options.allowedTools ? registry.scopeToolForSubagent(tool, this.options.allowedTools) : tool)
				.filter((tool): tool is DiscoveredTool => tool !== undefined)
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
				requestId: request.requestId,
				configurationRevision: request.configurationRevision,
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

		if (this.inventoryDirty) {
			return refreshToolRegistryForWorkspace(
				{
					workspaceRoot: this.options.getWorkspaceRoot(),
					includeUserTools: true,
					toggles: this.options.getToggles(),
				},
				captureSnapshot,
			)
		}
		return ToolRegistry.withExclusiveAccess(captureSnapshot)
	}

	private getInventorySnapshot(registry: ToolRegistry): ToolInventorySnapshot {
		const registryVersion = registry.getVersion()
		if (!this.inventoryDirty && !this.togglesDirty && this.inventorySnapshot && registryVersion === this.cachedRegistryVersion) {
			return this.inventorySnapshot
		}

		// Detach the inventory before releasing the process-global registry lock.
		// Tool definitions are immutable runtime descriptors; copying the arrays is
		// sufficient to prevent later per-Task toggle loads from changing membership.
		const ownerTaskId = this.options.getTaskId()
		const workspaceRoot = this.options.getWorkspaceRoot()
		const tools = [...registry.getAllTools(ownerTaskId, workspaceRoot)]
		const enabledTools = [...registry.getEnabledTools(ownerTaskId, workspaceRoot)].filter(
			(tool) => meetsHostCapabilityRequirement(tool.spec) && (this.options.isToolAvailable?.(tool) ?? true),
		)
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
		const coordinator = new ToolExecutorCoordinator(
			this.options.environmentFactory ?? new SurfaceToolEnvironmentFactory(),
		)
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
