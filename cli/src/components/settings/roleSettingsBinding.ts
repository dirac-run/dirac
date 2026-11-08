import { type SubagentRole, validateSubagentRoles } from "@shared/subagentRoles"
import type { StateManager } from "@/core/storage/StateManager"
import type { Controller } from "@/core/controller"

/** Role-only changes are global defaults for future children, never a Task update. */
export async function saveRoleSettings(state: StateManager, roles: SubagentRole[], controller?: Pick<Controller, "postStateToWebview">): Promise<SubagentRole[]> {
	const validated = validateSubagentRoles(roles)
	const previous = structuredClone(state.getSystemDefaultSettingsKey("subagentRoles"))
	try {
		state.setGlobalState("subagentRoles", validated)
		await state.flushPendingState()
	} catch (error) {
		try { state.setGlobalState("subagentRoles", previous); await state.flushPendingState() }
		catch (rollbackError) { throw new AggregateError([error, rollbackError], "Role settings persistence and rollback failed") }
		throw error
	}
	await controller?.postStateToWebview()
	return validated
}
