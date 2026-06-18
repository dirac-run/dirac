import { StateManager } from "@/core/storage/StateManager"

/**
 * Append a replacement taskId for an ACP session into the persistent map.
 * Called only when a second (or later) task is started within a session,
 * i.e. after a terminal failure caused a fresh initTask.
 */
export async function recordTaskForSession(sessionId: string, taskId: string): Promise<void> {
	const stateManager = StateManager.get()
	const map = { ...(stateManager.getGlobalStateKey("acpSessionTasks") ?? {}) }
	const existing = map[sessionId] ?? []
	map[sessionId] = [...existing, taskId]
	stateManager.setGlobalState("acpSessionTasks", map)
	await stateManager.flushPendingState()
}

/**
 * Return the latest replacement taskId recorded for a session, or undefined
 * if no replacement tasks have been recorded (the common single-task case).
 */
export function getLatestTaskIdForSession(sessionId: string): string | undefined {
	const map = StateManager.get().getGlobalStateKey("acpSessionTasks") ?? {}
	const tasks = map[sessionId]
	return tasks && tasks.length > 0 ? tasks[tasks.length - 1] : undefined
}
