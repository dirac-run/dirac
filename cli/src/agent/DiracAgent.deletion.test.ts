import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GoalHistoryItem } from "@shared/HistoryItem"
import { ArchitectureStorage } from "@/core/architecture/ArchitectureStorage"
import { serializeArchitectureWrite } from "@/core/architecture/architectureOperations"
import { GoalStore } from "@/core/goal/GoalStore"
import * as atomicWrite from "@/core/storage/atomicWrite"
import { acquireTaskLock } from "@/core/task/TaskLockUtils"
import { HostProvider } from "@/hosts/host-provider"
import { DiracAgent } from "./DiracAgent.js"

const mocks = vi.hoisted(() => ({
	taskHistory: [] as Array<{ id: string; ulid?: string; runKind?: "task" | "goal" }>,
	removeTaskHistoryItems: vi.fn(),
	flushPendingState: vi.fn(async () => undefined),
	withTaskHistoryInventoryLock: vi.fn(async (action: () => Promise<void>) => action()),
	deleteTasksForSession: vi.fn(),
	deleteSessionUpdates: vi.fn(),
	deletePinnedSessionMessages: vi.fn(),
	deleteSessionRuntimeConfig: vi.fn(),
	getSessionWorktree: vi.fn(() => undefined),
}))

vi.mock("@/core/controller", () => ({ Controller: vi.fn() }))
vi.mock("@/core/storage/disk", () => ({ setRuntimeHooksDir: vi.fn() }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalStateKey: (key: string) => (key === "taskHistory" ? mocks.taskHistory : undefined),
			removeTaskHistoryItems: mocks.removeTaskHistoryItems,
			flushPendingState: mocks.flushPendingState,
		}),
	},
}))
vi.mock("@/core/storage/taskHistory", () => ({ withTaskHistoryInventoryLock: mocks.withTaskHistoryInventoryLock }))
vi.mock("../acp/acp-session-tasks.js", () => ({ deleteTasksForSession: mocks.deleteTasksForSession }))
vi.mock("../acp/acp-session-updates.js", () => ({ deleteSessionUpdates: mocks.deleteSessionUpdates }))
vi.mock("../acp/acp-session-pins.js", () => ({ deletePinnedSessionMessages: mocks.deletePinnedSessionMessages }))
vi.mock("../acp/acp-session-runtime-config.js", () => ({ deleteSessionRuntimeConfig: mocks.deleteSessionRuntimeConfig }))
vi.mock("../acp/acp-session-worktrees.js", () => ({ getSessionWorktree: mocks.getSessionWorktree }))

const diagram = JSON.stringify({
	title: "CLI deletion",
	summary: "Task-local architecture",
	nodes: [{ id: "agent", kind: "component", label: "Agent" }],
	edges: [],
})

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("DiracAgent session deletion", () => {
	let root: string
	let agent: DiracAgent

	function taskDirectory(taskId: string): string {
		return path.join(root, "tasks", taskId)
	}

	async function createStorage(taskId: string): Promise<ArchitectureStorage> {
		await fs.mkdir(taskDirectory(taskId), { recursive: true })
		return new ArchitectureStorage(taskId, taskDirectory(taskId))
	}

	async function createLegacyGoal(goalId: string, sessionId: string, childIds: string[]): Promise<void> {
		const historyItem: GoalHistoryItem = {
			id: goalId,
			ulid: sessionId,
			runKind: "goal",
			conversationUlid: sessionId,
			ts: 1,
			task: "Legacy Goal",
			initialDisplayText: "Legacy Goal",
			objectivePreview: "Legacy Goal",
			objectiveRevision: 1,
			status: "paused",
			createdAt: 1,
			updatedAt: 1,
			activeDurationMs: 0,
			accounting: {},
		}
		mocks.taskHistory.push(historyItem)
		await fs.mkdir(taskDirectory(goalId), { recursive: true })
		await fs.writeFile(
			path.join(taskDirectory(goalId), "goal.json"),
			JSON.stringify({
				version: 1,
				id: goalId,
				conversationUlid: sessionId,
				status: "paused",
				objective: { markdown: "Legacy Goal", revision: 1, updatedAt: 1 },
				createdAt: 1,
				updatedAt: 1,
				lastPausedAt: 1,
				activeDurationMs: 0,
				wakeSequence: 0,
				eventSequence: 0,
				events: [],
				children: childIds.map((id, index) => ({
					id,
					title: id,
					role: index === 0 ? "task" : "verification",
					status: "completed",
					createdAt: 1,
					lastActivityAt: 1,
					endedAt: 1,
					deliveredResponseCursor: 0,
				})),
				accountingSources: {},
				accounting: {},
			}),
		)
	}

	function expectSessionMetadataDeleted(sessionId: string): void {
		expect(mocks.deleteTasksForSession).toHaveBeenCalledWith(sessionId)
		expect(mocks.deleteSessionUpdates).toHaveBeenCalledWith(sessionId)
		expect(mocks.deletePinnedSessionMessages).toHaveBeenCalledWith(sessionId)
		expect(mocks.deleteSessionRuntimeConfig).toHaveBeenCalledWith(root, sessionId)
	}

	function expectSessionMetadataRetained(): void {
		expect(mocks.deleteTasksForSession).not.toHaveBeenCalled()
		expect(mocks.deleteSessionUpdates).not.toHaveBeenCalled()
		expect(mocks.deletePinnedSessionMessages).not.toHaveBeenCalled()
		expect(mocks.deleteSessionRuntimeConfig).not.toHaveBeenCalled()
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		mocks.taskHistory.splice(0)
		root = await fs.mkdtemp(path.join(tmpdir(), "dirac-cli-deletion-"))
		vi.spyOn(HostProvider, "get").mockReturnValue({ globalStorageFsPath: root } as ReturnType<typeof HostProvider.get>)
		agent = new DiracAgent({ cwd: root })
		Object.assign(agent, { ctx: { DATA_DIR: root } })
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("deletes every session task and review sidecar, invalidating old and new board writers only for those tasks", async () => {
		mocks.taskHistory.push(
			{ id: "first", ulid: "session" },
			{ id: "replacement", ulid: "session" },
			{ id: "other", ulid: "other-session" },
		)
		const first = await createStorage("first")
		const replacement = await createStorage("replacement")
		const other = await createStorage("other")
		for (const storage of [first, replacement, other]) await storage.upsertDiagram("cli", diagram)
		await first.mutateReview({
			identity: { taskId: "first", name: "cli", version: 1 },
			operation: "add_comment",
			comment: { id: "comment", target: { kind: "diagram" }, text: "Keep the deletion boundary" },
		})

		await expect(agent.deleteSession({ sessionId: "session" })).resolves.toEqual({})

		expect(await fs.readdir(path.join(root, "tasks"))).toEqual(["other"])
		for (const storage of [first, replacement, new ArchitectureStorage("first", taskDirectory("first"))]) {
			await expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
		}
		await expect(other.upsertDiagram("cli", diagram)).resolves.toEqual({ name: "cli", version: 2 })
		expect(mocks.withTaskHistoryInventoryLock).toHaveBeenCalledOnce()
		expect(mocks.removeTaskHistoryItems).toHaveBeenCalledWith(["first", "replacement"])
		expect(mocks.flushPendingState).toHaveBeenCalledOnce()
		expectSessionMetadataDeleted("session")
	})

	it("cascades a version 1 Goal session into its private child directories without loading the Goal runtime", async () => {
		const childIds = ["private-task", "private-verification"]
		await createLegacyGoal("legacy-goal", "session", childIds)
		mocks.taskHistory.push({ id: "replacement", ulid: "session" }, { id: "other", ulid: "other-session" })
		const directoryIds = ["legacy-goal", "replacement", ...childIds]
		const ownedStorage = await Promise.all(directoryIds.map(createStorage))
		const other = await createStorage("other")
		for (const storage of [...ownedStorage, other]) await storage.upsertDiagram("cli", diagram)
		await ownedStorage[2].mutateReview({
			identity: { taskId: childIds[0], name: "cli", version: 1 },
			operation: "add_comment",
			comment: { id: "private-comment", target: { kind: "diagram" }, text: "Private child review" },
		})
		const readGoal = vi
			.spyOn(GoalStore.prototype, "read")
			.mockRejectedValue(new Error("Do not load or convert Goals for deletion"))
		const releaseWorktree = vi.spyOn(agent as any, "releaseOwnedSessionWorktree").mockImplementation(async () => {
			for (const directoryId of directoryIds) {
				expect((await fs.stat(taskDirectory(directoryId))).isDirectory()).toBe(true)
				await expect(acquireTaskLock(taskDirectory(directoryId))).rejects.toThrow("another Dirac instance")
			}
		})

		await expect(agent.deleteSession({ sessionId: "session" })).resolves.toEqual({})

		expect(releaseWorktree).toHaveBeenCalledWith("session")
		expect(readGoal).not.toHaveBeenCalled()
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual(["other"])
		for (const storage of ownedStorage) {
			await expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
		}
		await expect(other.upsertDiagram("cli", diagram)).resolves.toEqual({ name: "cli", version: 2 })
		expect(mocks.removeTaskHistoryItems).toHaveBeenCalledWith(["legacy-goal", "replacement"])
		expect(mocks.flushPendingState).toHaveBeenCalledOnce()
		expectSessionMetadataDeleted("session")
	})

	it("retains a version 1 Goal, all session roots, and metadata when a private child lock is held", async () => {
		const childIds = ["private-first", "private-locked"]
		await createLegacyGoal("legacy-goal", "session", childIds)
		mocks.taskHistory.push({ id: "replacement", ulid: "session" })
		const directoryIds = ["legacy-goal", "replacement", ...childIds]
		const storage = await Promise.all(directoryIds.map(createStorage))
		for (const entry of storage) await entry.upsertDiagram("cli", diagram)
		const goalPath = path.join(taskDirectory("legacy-goal"), "goal.json")
		const originalGoal = await fs.readFile(goalPath, "utf8")
		const readGoal = vi
			.spyOn(GoalStore.prototype, "read")
			.mockRejectedValue(new Error("Do not load or convert Goals for deletion"))
		const release = await acquireTaskLock(taskDirectory("private-locked"))
		try {
			await expect(agent.deleteSession({ sessionId: "session" })).rejects.toThrow("another Dirac instance")

			expect(await fs.readdir(path.join(root, "tasks"))).toEqual([
				"legacy-goal",
				"private-first",
				"private-locked",
				"private-locked.lock",
				"replacement",
			])
			expect(await fs.readFile(goalPath, "utf8")).toBe(originalGoal)
			expect(readGoal).not.toHaveBeenCalled()
			expect(mocks.getSessionWorktree).not.toHaveBeenCalled()
			expect(mocks.removeTaskHistoryItems).not.toHaveBeenCalled()
			expect(mocks.flushPendingState).not.toHaveBeenCalled()
			expectSessionMetadataRetained()
			for (const entry of storage) {
				await expect(entry.upsertDiagram("cli", diagram)).resolves.toEqual({ name: "cli", version: 2 })
			}
			// A later private-child lock failure releases both session roots and earlier child locks.
			for (const directoryId of ["legacy-goal", "replacement", "private-first"]) {
				const releaseEarlier = await acquireTaskLock(taskDirectory(directoryId))
				await releaseEarlier()
			}
		} finally {
			await release()
		}
		await expect(agent.deleteSession({ sessionId: "session" })).resolves.toEqual({})
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual([])
		expectSessionMetadataDeleted("session")
	})

	it("invalidates stalled and queued board writes before removal settles without waiting for the board queue", async () => {
		mocks.taskHistory.push({ id: "task", ulid: "session" })
		const storage = await createStorage("task")
		await storage.upsertDiagram("cli", diagram)
		const writeStarted = deferred()
		const releaseWrite = deferred()
		const removalStarted = deferred()
		const releaseRemoval = deferred()
		const originalWrite = atomicWrite.atomicWriteFile
		vi.spyOn(atomicWrite, "atomicWriteFile").mockImplementation(async (file, content) => {
			writeStarted.resolve()
			await releaseWrite.promise
			return originalWrite(file, content)
		})
		const originalRm = fs.rm.bind(fs)
		vi.spyOn(fs, "rm").mockImplementation(async (directory, options) => {
			if (directory === taskDirectory("task")) {
				removalStarted.resolve()
				await releaseRemoval.promise
			}
			return originalRm(directory, options)
		})

		try {
			const active = expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
			await writeStarted.promise
			const queued = expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
			const review = expect(
				storage.mutateReview({
					identity: { taskId: "task", name: "cli", version: 1 },
					operation: "add_comment",
					comment: { id: "late", target: { kind: "diagram" }, text: "Late comment" },
				}),
			).rejects.toThrow("owning task was deleted")
			const deleting = agent.deleteSession({ sessionId: "session" })
			await removalStarted.promise
			await Promise.all([active, queued, review])
			expect((await fs.stat(taskDirectory("task"))).isDirectory()).toBe(true)
			releaseRemoval.resolve()
			await expect(deleting).resolves.toEqual({})
			expectSessionMetadataDeleted("session")
		} finally {
			releaseRemoval.resolve()
			releaseWrite.resolve()
			await serializeArchitectureWrite(path.join(taskDirectory("task"), "architecture", "cli"), async () => undefined)
		}
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual([])
	})

	it("does not let a late architecture-directory creation recreate a deleted task", async () => {
		mocks.taskHistory.push({ id: "task", ulid: "session" })
		const storage = await createStorage("task")
		const started = deferred()
		const release = deferred()
		const originalMkdir = fs.mkdir.bind(fs)
		vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
			if (directory === path.join(taskDirectory("task"), "architecture")) {
				started.resolve()
				await release.promise
			}
			return originalMkdir(directory, options)
		})

		try {
			const active = expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
			await started.promise
			await expect(agent.deleteSession({ sessionId: "session" })).resolves.toEqual({})
			await active
		} finally {
			release.resolve()
			await serializeArchitectureWrite(path.join(taskDirectory("task"), "architecture", "cli"), async () => undefined)
		}
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual([])
	})

	it("propagates the original removal error without deleting history or session metadata", async () => {
		mocks.taskHistory.push({ id: "task", ulid: "session" })
		const storage = await createStorage("task")
		await storage.upsertDiagram("cli", diagram)
		const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
		vi.spyOn(fs, "rm").mockRejectedValueOnce(error)

		await expect(agent.deleteSession({ sessionId: "session" })).rejects.toBe(error)

		expect((await fs.stat(taskDirectory("task"))).isDirectory()).toBe(true)
		await expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow("owning task was deleted")
		expect(mocks.removeTaskHistoryItems).not.toHaveBeenCalled()
		expect(mocks.flushPendingState).not.toHaveBeenCalled()
		expectSessionMetadataRetained()
	})

	it("retains force-removal behavior for a legacy session whose task directory is already missing", async () => {
		mocks.taskHistory.push({ id: "legacy-session" })

		await expect(agent.deleteSession({ sessionId: "legacy-session" })).resolves.toEqual({})

		expect(mocks.removeTaskHistoryItems).toHaveBeenCalledWith(["legacy-session"])
		expectSessionMetadataDeleted("legacy-session")
		const storage = new ArchitectureStorage("legacy-session", taskDirectory("legacy-session"))
		await expect(storage.upsertDiagram("cli", diagram)).rejects.toThrow()
		await expect(fs.stat(taskDirectory("legacy-session"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("keeps persisted diagrams and board writers usable when closing rather than deleting a session", async () => {
		mocks.taskHistory.push({ id: "task", ulid: "session" })
		const storage = await createStorage("task")
		await storage.upsertDiagram("cli", diagram)

		await expect(agent.closeSession({ sessionId: "session" })).resolves.toEqual({})

		await expect(storage.upsertDiagram("cli", diagram)).resolves.toEqual({ name: "cli", version: 2 })
		expect(mocks.removeTaskHistoryItems).not.toHaveBeenCalled()
		expectSessionMetadataRetained()
	})

	it("acquires all task locks before deleting any session storage or releasing its worktree", async () => {
		mocks.taskHistory.push({ id: "first", ulid: "session" }, { id: "locked", ulid: "session" })
		await createStorage("first")
		await createStorage("locked")
		const nested = path.join(taskDirectory("locked"), "tasklets", "child")
		await fs.mkdir(nested, { recursive: true })
		await fs.writeFile(path.join(nested, "tasklet.json"), "owned")
		const release = await acquireTaskLock(taskDirectory("locked"))
		try {
			await expect(agent.deleteSession({ sessionId: "session" })).rejects.toThrow("another Dirac instance")
			expect(await fs.readdir(path.join(root, "tasks"))).toEqual(["first", "locked", "locked.lock"])
			expect(await fs.readFile(path.join(nested, "tasklet.json"), "utf8")).toBe("owned")
			expect(mocks.getSessionWorktree).not.toHaveBeenCalled()
			expect(mocks.removeTaskHistoryItems).not.toHaveBeenCalled()
			expectSessionMetadataRetained()
			// Failure to acquire a later lock must release every earlier acquisition.
			const releaseFirst = await acquireTaskLock(taskDirectory("first"))
			await releaseFirst()
		} finally {
			await release()
		}
		await expect(agent.deleteSession({ sessionId: "session" })).resolves.toEqual({})
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual([])
	})

	it("waits for local session shutdown before deleting contained tasklet storage", async () => {
		mocks.taskHistory.push({ id: "root", ulid: "session" })
		const nested = path.join(taskDirectory("root"), "tasklets", "child")
		await fs.mkdir(nested, { recursive: true })
		const shutdown = deferred()
		const started = deferred()
		vi.spyOn(agent as any, "releaseSessionResources").mockImplementation(async () => {
			started.resolve()
			await shutdown.promise
			await fs.writeFile(path.join(nested, "tasklet.json"), "settled")
		})
		const deleting = agent.deleteSession({ sessionId: "session" })
		await started.promise
		expect((await fs.stat(nested)).isDirectory()).toBe(true)
		expect(mocks.removeTaskHistoryItems).not.toHaveBeenCalled()
		shutdown.resolve()
		await expect(deleting).resolves.toEqual({})
		await expect(fs.stat(taskDirectory("root"))).rejects.toMatchObject({ code: "ENOENT" })
		expectSessionMetadataDeleted("session")
	})
})
