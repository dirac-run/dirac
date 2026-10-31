import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { repairMissingTaskHistory } from "@core/commands/repairMissingTaskHistory"
import { reconstructTaskHistory, reconstructTaskHistoryItem } from "@core/commands/reconstructTaskHistory"
import { createGoalHistoryItem } from "@core/goal/GoalHistory"
import { GoalStore } from "@core/goal/GoalStore"
import type { StateManager } from "@core/storage/StateManager"
import type { RunHistoryItem, TaskHistoryItem } from "@shared/HistoryItem"
import { HostProvider } from "@/hosts/host-provider"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { ensureTaskDirectoryExists } from "../directoryEnsurers"
import { getTaskDirectoryPath, listTaskDirectoryIds } from "../taskDirectory"
import {
	applyTaskHistoryMutations,
	commitTaskHistoryMutations,
	getTaskHistoryStateFilePath,
	readTaskHistoryFromState,
	writeTaskHistoryToState,
	type TaskHistoryMutation,
} from "../taskHistory"

const ROOT_ID = "1788000000001"

describe("tasklet top-level history containment", () => {
	let storagePath: string
	let childIds: string[]

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-history-containment-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
		await writeMessages(await ensureTaskDirectoryExists(ROOT_ID), "Root Task")
		childIds = [createTaskletId(), createTaskletId()]
		for (const taskletId of childIds) {
			const directory = await ensureTaskDirectoryExists({ kind: "tasklet", rootTaskId: ROOT_ID, taskletId })
			await writeMessages(directory, `Private ${taskletId}`)
		}
		// Even malformed reserved-prefix directories must be ignored before path resolution or Goal inspection.
		for (const id of [createTaskletId(), "tasklet_invalid"]) {
			const directory = path.join(storagePath, "tasks", id)
			await fs.mkdir(directory)
			await writeMessages(directory, "Stray tasklet")
			await fs.writeFile(path.join(directory, "goal.json"), "{invalid-goal")
		}
	})

	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("discovers only immediate non-reserved Task directories and retains lock filtering", async () => {
		await fs.mkdir(path.join(storagePath, "tasks", "legacy-task"))
		await fs.mkdir(path.join(storagePath, "tasks", `${ROOT_ID}.lock`))
		await fs.writeFile(path.join(storagePath, "tasks", "not-a-directory"), "")
		assert.deepEqual((await listTaskDirectoryIds()).sort(), [ROOT_ID, "legacy-task"])
		assert.deepEqual(await new GoalStore().list(), [])
		for (const taskletId of childIds) {
			await assert.rejects(reconstructTaskHistoryItem(taskletId), /Invalid task directory identity/)
		}
	})

	it("startup repair persists only the root and leaves nested children untouched", async () => {
		let history: RunHistoryItem[] = []
		const stateManager = {
			getGlobalStateKey: () => history,
			insertMissingTaskHistoryItems: (items: RunHistoryItem[]) => {
				history = [...history, ...items]
			},
			flushPendingState: () => writeTaskHistoryToState(history),
		} as unknown as StateManager

		assert.deepEqual(await repairMissingTaskHistory(stateManager), {
			status: "completed",
			recovered: 1,
			skipped: 0,
			errors: 0,
		})
		assert.deepEqual(
			(await readTaskHistoryFromState()).map((item) => item.id),
			[ROOT_ID],
		)
		assert.equal((await repairMissingTaskHistory(stateManager)).recovered, 0)
		await assertChildrenIntact()
	})

	it("explicit reconstruction excludes nested and stray tasklets while retaining legacy directory scanning", async () => {
		// Unlike startup inventory, explicit reconstruction historically includes nonstandard IDs and .lock directories.
		await writeMessages(await ensureTaskDirectoryExists("legacy-task"), "Legacy Task")
		await fs.mkdir(path.join(storagePath, "tasks", `${ROOT_ID}.lock`))
		const goal = await new GoalStore().create("1788000000002", "01M0WEC6XTSG2ZX1951ZZC1J7V", "Goal objective")
		await writeMessages(getTaskDirectoryPath(goal.id), "Goal initial message")
		const showMessage = sinon.stub(HostProvider.window, "showMessage").resolves({ selectedOption: "Yes, Reconstruct" })

		assert.deepEqual(await reconstructTaskHistory(), {
			totalTasks: 4,
			reconstructedTasks: 3,
			skippedTasks: 1,
			errors: [],
		})
		assert.equal(showMessage.callCount, 3)
		const history = await readTaskHistoryFromState()
		assert.deepEqual(history.map((item) => item.id).sort(), [ROOT_ID, goal.id, "legacy-task"])
		assert.equal(history.find((item) => item.id === goal.id)?.runKind, "goal")
		await assertChildrenIntact()
	})

	it("corrupt-index recovery reconstructs only the root without prompting or recurring", async () => {
		const filePath = await getTaskHistoryStateFilePath()
		await fs.writeFile(filePath, "{invalid-history")
		const showMessage = sinon.stub(HostProvider.window, "showMessage")

		const history = await readTaskHistoryFromState()
		assert.deepEqual(
			history.map((item) => item.id),
			[ROOT_ID],
		)
		assert.deepEqual(await readTaskHistoryFromState(), history)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), history)
		sinon.assert.notCalled(showMessage)
		const backups = (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith("taskHistory.unreadable."))
		assert.equal(backups.length, 1)
		assert.equal(await fs.readFile(path.join(path.dirname(filePath), backups[0]), "utf8"), "{invalid-history")
		await assertChildrenIntact()
	})

	it("reads and mutation commits omit tasklet summaries without changing ordinary or Goal summaries", async () => {
		const root = historyItem(ROOT_ID)
		const goal = createGoalHistoryItem(
			await new GoalStore().create("1788000000002", "01M0WEC6XTSG2ZX1951ZZC1J7V", "Goal objective"),
			"Goal initial message",
			"/workspace",
		)
		const filePath = await getTaskHistoryStateFilePath()
		await fs.writeFile(
			filePath,
			JSON.stringify([
				root,
				goal,
				historyItem(childIds[0]),
				{ ...historyItem(childIds[1]), runKind: "task" },
				{ ...goal, id: createTaskletId() },
				historyItem("tasklet_invalid"),
			]),
		)

		assert.deepEqual(await readTaskHistoryFromState(), [root, goal])
		const updated = [{ ...root, isFavorited: true }, goal]
		assert.deepEqual(await commitTaskHistoryMutations([{ kind: "setFavorite", id: ROOT_ID, isFavorited: true }]), updated)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), updated)
	})

	it("recovers an index containing only tasklet summaries without returning them", async () => {
		await fs.writeFile(await getTaskHistoryStateFilePath(), JSON.stringify(childIds.map(historyItem)))
		assert.deepEqual(
			(await readTaskHistoryFromState()).map((item) => item.id),
			[ROOT_ID],
		)
	})

	it("rejects tasklet summaries in replacements, upserts, and insert-missing commits atomically", async () => {
		expectLoggerErrors()
		const root = historyItem(ROOT_ID)
		await writeTaskHistoryToState([root])
		const filePath = await getTaskHistoryStateFilePath()
		const original = await fs.readFile(filePath, "utf8")
		const goal = createGoalHistoryItem(
			await new GoalStore().create("1788000000002", "01M0WEC6XTSG2ZX1951ZZC1J7V", "Goal objective"),
			"Goal initial message",
			"/workspace",
		)
		const forbidden: RunHistoryItem[] = [
			historyItem(childIds[0]),
			{ ...historyItem(childIds[1]), runKind: "task" },
			{ ...goal, id: createTaskletId() },
			historyItem("tasklet_invalid"),
		]
		for (const item of forbidden) {
			await assert.rejects(writeTaskHistoryToState([root, item]), /cannot be persisted in top-level history/)
			const mutations: TaskHistoryMutation[] = [
				{ kind: "upsert", item },
				{ kind: "insertMissing", items: [item] },
			]
			for (const mutation of mutations) {
				assert.throws(() => applyTaskHistoryMutations([root], [mutation]), /cannot be persisted in top-level history/)
				await assert.rejects(commitTaskHistoryMutations([mutation]), /cannot be persisted in top-level history/)
			}
			assert.equal(await fs.readFile(filePath, "utf8"), original)
		}
		assert.deepEqual(await readTaskHistoryFromState(), [root])
	})

	async function assertChildrenIntact(): Promise<void> {
		for (const taskletId of childIds) {
			const directory = getTaskDirectoryPath({ kind: "tasklet", rootTaskId: ROOT_ID, taskletId })
			const messages = JSON.parse(await fs.readFile(path.join(directory, "ui_messages.json"), "utf8"))
			assert.equal(messages[0].content.content, `Private ${taskletId}`)
		}
	}
})

async function writeMessages(directory: string, content: string): Promise<void> {
	await fs.writeFile(
		path.join(directory, "ui_messages.json"),
		JSON.stringify([{ id: "message", ts: 1788000000001, content: { type: "markdown", role: "user", content } }]),
	)
}

function historyItem(id: string): TaskHistoryItem {
	return { id, ts: 1788000000001, task: id, tokensIn: 1, tokensOut: 1, totalCost: 0 }
}
