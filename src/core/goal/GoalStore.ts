import { atomicWriteFile } from "@core/storage/atomicWrite"
import { ensureTaskDirectoryExists } from "@core/storage/directoryEnsurers"
import { getTaskDirectoryPath, listTaskDirectoryIds } from "@core/storage/taskDirectory"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import { type GoalRecord, type GoalStatusTransition, isActiveGoalStatus, isSettledGoalStatus } from "@shared/goal"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import Mutex from "p-mutex"
import path from "path"
import { applyGoalStatusTransition } from "./GoalLifecycle"
import { assertGoalRecord, isLegacyGoalRecord } from "./validateGoalRecord"

const GOAL_STATE_FILE = "goal.json"
const goalLocks = new Map<string, Mutex>()

export type GoalRecordUpdate = (record: GoalRecord, now: number) => void | Promise<void>

export interface GoalStartupReconciliationFailure {
	goalId: string
	error: Error
}

export interface GoalStartupReconciliationReport {
	records: GoalRecord[]
	/** Root directories and historical private children, including non-executable Goals. */
	ownedDirectoryIds: string[]
	failures: GoalStartupReconciliationFailure[]
}

interface GoalLifecycleSnapshot {
	status: GoalRecord["status"]
	statusReason?: string
	settledAt?: number
	activeDurationMs: number
	lastActivatedAt?: number
	lastPausedAt?: number
}

function goalLock(goalId: string): Mutex {
	let lock = goalLocks.get(goalId)
	if (!lock) {
		lock = new Mutex()
		goalLocks.set(goalId, lock)
	}
	return lock
}

async function withGoalLock<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
	const lock = goalLock(goalId)
	try {
		return await lock.withLock(operation)
	} finally {
		if (!lock.isLocked && goalLocks.get(goalId) === lock) goalLocks.delete(goalId)
	}
}

function goalStatePath(goalId: string): string {
	return path.join(getTaskDirectoryPath(goalId), GOAL_STATE_FILE)
}

function lifecycleSnapshot(record: GoalRecord): GoalLifecycleSnapshot {
	return {
		status: record.status,
		statusReason: record.statusReason,
		settledAt: record.settledAt,
		activeDurationMs: record.activeDurationMs,
		lastActivatedAt: record.lastActivatedAt,
		lastPausedAt: record.lastPausedAt,
	}
}

function assertLifecycleUnchanged(record: GoalRecord, before: GoalLifecycleSnapshot): void {
	const after = lifecycleSnapshot(record)
	if (
		after.status !== before.status ||
		after.statusReason !== before.statusReason ||
		after.settledAt !== before.settledAt ||
		after.activeDurationMs !== before.activeDurationMs ||
		after.lastActivatedAt !== before.lastActivatedAt ||
		after.lastPausedAt !== before.lastPausedAt
	) {
		throw new Error(`Goal ${record.id} lifecycle fields may only change through GoalStore.transition`)
	}
}

function assertClockTime(now: number): void {
	if (!Number.isFinite(now) || now < 0) throw new Error("GoalStore clock returned an invalid timestamp")
}

async function readGoalRecord(goalId: string): Promise<GoalRecord> {
	const filePath = goalStatePath(goalId)
	if (!(await fileExistsAtPath(filePath))) throw new Error(`Goal ${goalId} does not exist`)
	const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
	assertGoalRecord(parsed, goalId)
	return parsed
}

/** Reads ownership IDs without loading transcripts or accepting historical execution state. */
function ownedGoalDirectoryIds(goalId: string, value: unknown): { directoryIds: string[]; errors: Error[] } {
	const ids = new Set([goalId])
	const errors: Error[] = []
	if (!value || typeof value !== "object" || Array.isArray(value)) return { directoryIds: [...ids], errors }
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.children)) return { directoryIds: [...ids], errors }
	for (const child of record.children) {
		if (!child || typeof child !== "object" || Array.isArray(child)) continue
		const id = (child as Record<string, unknown>).id
		if (typeof id !== "string" || !id) continue
		// New contained handles are nested under the root, not independent directories.
		if (record.version === 2) continue
		try {
			getTaskDirectoryPath(id)
			ids.add(id)
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)))
		}
	}
	return { directoryIds: [...ids], errors }
}

async function writeGoalRecord(record: GoalRecord): Promise<void> {
	assertGoalRecord(record, record.id)
	await atomicWriteFile(goalStatePath(record.id), JSON.stringify(record, null, 2))
}

export class GoalStore {
	constructor(private readonly clock: () => number = Date.now) { }

	async create(goalId: string, conversationUlid: string, objectiveMarkdown: string): Promise<GoalRecord> {
		if (!objectiveMarkdown.trim()) throw new Error("A Goal objective cannot be empty")
		if (!conversationUlid) throw new Error("A Goal conversation ULID cannot be empty")
		return withGoalLock(goalId, async () => {
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(goalId))
			try {
				const filePath = goalStatePath(goalId)
				if (await fileExistsAtPath(filePath)) throw new Error(`Goal ${goalId} already exists`)
				const now = this.clock()
				assertClockTime(now)
				await ensureTaskDirectoryExists(goalId)
				const record: GoalRecord = {
					version: 2,
					id: goalId,
					conversationUlid,
					status: "paused",
					statusReason: "Created",
					objective: { markdown: objectiveMarkdown, revision: 1, updatedAt: now },
					createdAt: now,
					updatedAt: now,
					lastPausedAt: now,
					activeDurationMs: 0,
					accountingSources: {},
					accounting: {},
				}
				await writeGoalRecord(record)
				return structuredClone(record)
			} finally {
				await releaseOwnership()
			}
		})
	}

	async read(goalId: string): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => structuredClone(await readGoalRecord(goalId)))
	}

	/** Historical ownership is used only for exclusion and explicit user-requested deletion. */
	async readOwnedDirectoryIds(goalId: string): Promise<string[]> {
		const parsed: unknown = JSON.parse(await fs.readFile(goalStatePath(goalId), "utf8"))
		const ownership = ownedGoalDirectoryIds(goalId, parsed)
		if (ownership.errors.length > 0) {
			throw new AggregateError(ownership.errors, ownership.errors.map((error) => error.message).join("; "))
		}
		return ownership.directoryIds
	}

	async list(): Promise<GoalRecord[]> {
		const report = await this.scanRecords()
		if (report.failures.length > 0) {
			throw new AggregateError(
				report.failures.map(({ error }) => error),
				"Could not read persisted Goals",
			)
		}
		return report.records
	}

	async update(goalId: string, update: GoalRecordUpdate): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const record = await readGoalRecord(goalId)
			const now = this.clock()
			assertClockTime(now)
			if (now < record.updatedAt) throw new Error(`Goal ${goalId} update time predates its persisted state`)
			const before = lifecycleSnapshot(record)
			await update(record, now)
			assertLifecycleUnchanged(record, before)
			// Older records have no dedicated endpoint; preserve it before advancing updatedAt.
			if (isSettledGoalStatus(record.status)) record.settledAt ??= record.updatedAt
			record.updatedAt = now
			await writeGoalRecord(record)
			return structuredClone(record)
		})
	}

	async transition(goalId: string, transition: GoalStatusTransition, mutate?: GoalRecordUpdate): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const record = await readGoalRecord(goalId)
			if (record.status === transition.status) return structuredClone(record)
			const now = this.clock()
			assertClockTime(now)
			if (now < record.updatedAt) throw new Error(`Goal ${goalId} transition time predates its persisted state`)
			const before = lifecycleSnapshot(record)
			if (mutate) await mutate(record, now)
			assertLifecycleUnchanged(record, before)
			applyGoalStatusTransition(record, transition, now)
			await writeGoalRecord(record)
			return structuredClone(record)
		})
	}

	/** Removes only an unowned Goal record, for creation rollback. */
	async delete(goalId: string): Promise<void> {
		await withGoalLock(goalId, async () => {
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(goalId))
			try {
				await fs.rm(goalStatePath(goalId), { force: true })
			} finally {
				await releaseOwnership()
			}
		})
	}

	/** Discovery is read-only: another process may own any of these Goals. */
	async scanRecords(): Promise<GoalStartupReconciliationReport> {
		const records: GoalRecord[] = []
		const ownedDirectoryIds = new Set<string>()
		const failures: GoalStartupReconciliationFailure[] = []
		for (const goalId of await listTaskDirectoryIds()) {
			try {
				const filePath = goalStatePath(goalId)
				if (!(await fileExistsAtPath(filePath))) continue
				ownedDirectoryIds.add(goalId)
				const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
				const ownership = ownedGoalDirectoryIds(goalId, parsed)
				for (const id of ownership.directoryIds) ownedDirectoryIds.add(id)
				if (ownership.errors.length > 0) {
					throw new AggregateError(ownership.errors, `Goal ${goalId} has invalid child directory ownership`)
				}
				if (isLegacyGoalRecord(parsed)) continue
				assertGoalRecord(parsed, goalId)
				records.push(parsed)
			} catch (error) {
				failures.push({ goalId, error: error instanceof Error ? error : new Error(String(error)) })
			}
		}
		return {
			records: records.sort((left, right) => left.createdAt - right.createdAt),
			ownedDirectoryIds: [...ownedDirectoryIds],
			failures,
		}
	}

	/** Call only while holding this Goal's task-directory execution lock. */
	async recoverInterruptedExecution(goalId: string): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const current = await readGoalRecord(goalId)
			const now = this.clock()
			assertClockTime(now)
			if (now < current.updatedAt) throw new Error(`Goal ${goalId} recovery time predates its persisted state`)
			if (isActiveGoalStatus(current.status)) {
				applyGoalStatusTransition(current, { status: "paused", statusReason: "Recovered interrupted execution" }, now)
				await writeGoalRecord(current)
			}
			return structuredClone(current)
		})
	}
}
