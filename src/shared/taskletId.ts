import { SUBAGENT_NAMES } from "./subagentNames";

/** Storage location only, not proof of ownership or permission to access an execution. */
export type TaskStorageAddress = { kind: "task"; taskId: string } | { kind: "tasklet"; rootTaskId: string; taskletId: string }

/** Process-local state only; copied tasklet identities remain distinct under different roots. */
export function getTaskScopedStateKey(identity: string, address?: string | TaskStorageAddress): string {
	return typeof address !== "string" && address?.kind === "tasklet"
		? JSON.stringify([address.rootTaskId, address.taskletId, identity])
		: identity
}

/** Historical reserved prefix; new conversation IDs do not depend on it. */
export const TASKLET_ID_PREFIX = "tasklet_"
const UNIQUE_SUBAGENT_NAMES = [...new Set(SUBAGENT_NAMES)]

/** Select the next unused identity. The owning host must reserve it synchronously before starting work. */
export function createTaskletId(usedIds: ReadonlySet<string>): string {
	for (let round = 1; ; round++) {
		for (const name of UNIQUE_SUBAGENT_NAMES) {
			const id = round === 1 ? name : `${name} ${round}`
			if (!usedIds.has(id)) return id
		}
	}
}

/** Safe opaque path segment only; the root must separately resolve and authorize the conversation. */
export function isTaskletId(id: string): boolean {
	return typeof id === "string" && id.length > 0 && id.length <= 128 &&
		id !== "." && id !== ".." && id === id.trim() &&
		!/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(id) && !id.endsWith(".") &&
		!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
}
