import type { DiracTool, DiracToolSpec } from "@/shared/tools"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"

export type ToolSnapshotDirtyReason =
	| "task_start"
	| "tool_toggles_changed"
	| "user_tool_files_changed"
	| "settings_refresh_detected_change"
	| "manual_refresh"

export interface ToolInventorySnapshot {
	version: number
	tools: DiscoveredTool[]
	enabledTools: DiscoveredTool[]
	coordinator: ToolExecutorCoordinator
	executableToolNames: Set<string>
	createdAt: number
}

export interface ToolRequestSnapshot {
	inventoryVersion: number
	requestId: string
	promptVisibleSpecs: DiracToolSpec[]
	inventoryEnabledTools: readonly DiscoveredTool[]
	activeSkillIds: readonly string[]
	nativeTools: DiracTool[]
	coordinator: ToolExecutorCoordinator
	executableToolNames: Set<string>
	dynamicSubagentToolNames: Set<string>
}

export function validateToolRequestSnapshot(snapshot: ToolRequestSnapshot): void {
	const activeSkillIds = new Set(snapshot.activeSkillIds)
	for (const tool of snapshot.inventoryEnabledTools) {
		if (tool.exposure.kind !== "skill_only") continue
		if (!tool.exposure.authorizedSkillIds.some((skillId) => activeSkillIds.has(skillId))) {
			throw new Error(`Tool snapshot invariant violated: skill-only tool '${tool.id}' has no active authorized skill.`)
		}
	}

	for (const spec of snapshot.promptVisibleSpecs) {
		if (!snapshot.coordinator.has(spec.name)) {
			throw new Error(`Tool snapshot invariant violated: prompt-visible tool '${spec.name}' has no runtime handler.`)
		}
	}
}
