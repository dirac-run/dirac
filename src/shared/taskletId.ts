import { randomUUID } from "node:crypto"

export const TASKLET_ID_PREFIX = "tasklet_"
const TASKLET_ID_PATTERN = /^tasklet_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Stable conversation identity, independent of a Task ID or a storage path. */
export function createTaskletId(): string {
	return `${TASKLET_ID_PREFIX}${randomUUID()}`
}

/** Format classification only; the owning root must resolve and authorize the handle. */
export function isTaskletId(id: string): boolean {
	return id.length === TASKLET_ID_PREFIX.length + 36 && TASKLET_ID_PATTERN.test(id)
}
