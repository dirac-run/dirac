import fs from "node:fs"
import path from "node:path"
import { DIRAC_CLI_DIR } from "../utils/path.js"

const SESSION_TASKS_FILE = path.join(DIRAC_CLI_DIR.data, "acp-session-tasks.json")

function readSessionTasksMap(): Record<string, string[]> {
	try {
		const raw = fs.readFileSync(SESSION_TASKS_FILE, "utf-8")
		return JSON.parse(raw)
	} catch {
		return {}
	}
}

function writeSessionTasksMap(map: Record<string, string[]>): void {
	fs.mkdirSync(path.dirname(SESSION_TASKS_FILE), { recursive: true })
	fs.writeFileSync(SESSION_TASKS_FILE, JSON.stringify(map, null, 2))
}

/**
 * Append a replacement taskId for an ACP session into the persistent map.
 * Called only when a second (or later) task is started within a session,
 * i.e. after a terminal failure caused a fresh initTask.
 */
export async function recordTaskForSession(sessionId: string, taskId: string): Promise<void> {
	const map = readSessionTasksMap()
	const existing = map[sessionId] ?? []
	map[sessionId] = [...existing, taskId]
	writeSessionTasksMap(map)
}

/**
 * Return the latest replacement taskId recorded for a session, or undefined
 * if no replacement tasks have been recorded (the common single-task case).
 */
export function getLatestTaskIdForSession(sessionId: string): string | undefined {
	const map = readSessionTasksMap()
	const tasks = map[sessionId]
	return tasks && tasks.length > 0 ? tasks[tasks.length - 1] : undefined
}

/** Remove all replacement task IDs recorded for an ACP session. */
export function deleteTasksForSession(sessionId: string): void {
	const map = readSessionTasksMap()
	delete map[sessionId]
	writeSessionTasksMap(map)
}
