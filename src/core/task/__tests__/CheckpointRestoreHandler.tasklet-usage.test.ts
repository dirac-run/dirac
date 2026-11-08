import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { getSavedPresentationHistory } from "@core/storage/conversationHistory"
import { MessageStateHandler } from "@core/task/message-state"
import type { TaskMessenger } from "@core/task/TaskMessenger"
import { TaskState } from "@core/task/TaskState"
import { CardStatus, DiracMessageType, type DiracApiReqInfo, type DiracMessage } from "@shared/ExtensionMessage"
import { getApiMetrics, getApiUsageKnowledge, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { getTaskletUsage } from "@shared/taskletUsage"
import { createTaskletPresentationCard, readTaskletPresentation, type TaskletPresentationData } from "@shared/taskletPresentation"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { CheckpointRestoreHandler } from "@integrations/checkpoints/CheckpointRestoreHandler"
import type { CheckpointStorageManager } from "@integrations/checkpoints/CheckpointStorageManager"

import { extendTranscriptPrefix, TranscriptIntegrityError } from "@core/api/TranscriptPrefix"
import { GlobalFileNames } from "@core/storage/fileNames"
function usageMessage(taskletId: string, cost: number): DiracMessage {
	return {
		id: `usage-${taskletId}`,
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: {
				id: `usage-${taskletId}`,
				header: "Tasklet usage",
				status: CardStatus.SUCCESS,
				renderType: "text",
				rawOutput: {
					source: "tasklet",
					taskletId,
					cost,
					tokensIn: cost * 10,
					tokensOut: cost,
					cacheWrites: cost * 2,
					cacheReads: cost * 3,
					reasoningTokens: cost,
				},
			},
		},
	}
}

function presentationData(taskletId: string, status: TaskletPresentationData["status"]): TaskletPresentationData {
	return {
		taskletId, title: "Shared display title", prompt: `Assignment for ${taskletId}`, createdAt: 1, status,
		result: `${taskletId}: ${status}`, communications: [`Parent update: ${status}`], activity: [`Activity: ${status}`],
		usage: { cost: 99, tokensIn: 990, tokensOut: 99, reasoningTokens: 99 },
	}
}

async function seedHistoricalPresentation(messages: MessageStateHandler, data: TaskletPresentationData): Promise<void> {
	const card = createTaskletPresentationCard(data)
	if (messages.findMessageIndexById(card.id) === -1) {
		await messages.addToDiracMessages({ id: card.id, ts: data.createdAt, content: { type: DiracMessageType.CARD, card } })
		return
	}
	await messages.patchCardById(card.id, card)
}

function apiMessage(id: string, cost: number): DiracMessage {
	return { id, ts: 1, content: { type: DiracMessageType.API_STATUS, status: { cost, tokensIn: cost * 10, tokensOut: cost } } }
}

/** Real presentation operation history; provider, filesystem rollback and external hosts are controlled. */
describe("Checkpoint restore preserves separately attributed tasklet usage", () => {
	let directory: string
	let messages: MessageStateHandler
	let state: TaskState
	let sandbox: sinon.SinonSandbox
	let cancel: sinon.SinonStub
	let reset: sinon.SinonStub
	let resetHead: sinon.SinonStub
	let upsertApiStatus: sinon.SinonStub
	let restore: CheckpointRestoreHandler

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-tasklet-usage-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		state = new TaskState()
		messages = new MessageStateHandler({
			taskId: "root",
			ulid: "root-ulid",
			taskState: state,
			updateTaskHistory: async () => [],
		})
		cancel = sandbox.stub().resolves()
		reset = sandbox.stub().resolves()
		resetHead = sandbox.stub().resolves()
		let deletedId = 0
		upsertApiStatus = sandbox.stub().callsFake(async (status: DiracApiReqInfo) => {
			await messages.addToDiracMessages({
				id: `deleted-${++deletedId}`,
				ts: 2,
				content: { type: DiracMessageType.API_STATUS, status },
			})
		})
		restore = new CheckpointRestoreHandler(
			{ taskId: "root", enableCheckpoints: true },
			{
				messageStateHandler: messages,
				taskState: state,
				fileContextTracker: {
					detectFilesEditedAfterMessage: sandbox.stub().resolves([]),
					storePendingFileContextWarning: sandbox.stub().resolves(),
				} as unknown as FileContextTracker,
				createCheckpointTracker: sandbox.stub(),
			},
			{ cancelTask: cancel, resetTransientState: reset, taskMessenger: { upsertApiStatus } as unknown as TaskMessenger },
			{ getTracker: () => ({ resetHead }) } as unknown as CheckpointStorageManager,
		)
	})

	afterEach(async () => {
		await messages.retirePersistence()
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function seedCheckpoint() {
		await messages.addToDiracMessages({
			id: "user",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Assignment" },
		})
		await messages.addToDiracMessages(apiMessage("before", 2))
		await messages.addToDiracMessages(usageMessage("first", 1))
		await seedHistoricalPresentation(messages, presentationData("first", "running"))
		await messages.addToDiracMessages({
			id: "checkpoint",
			ts: 1,
			lastCheckpointHash: "checkpoint-hash",
			content: { type: DiracMessageType.CHECKPOINT },
		})
		await messages.flushPendingWrites()
		const latest = usageMessage("first", 7)
		assert.equal(latest.content.type, "card")
		if (latest.content.type === "card") await messages.patchCardById("usage-first", latest.content.card)
		await messages.addToDiracMessages(usageMessage("second", 11))
		await messages.addToDiracMessages(apiMessage("after", 3))
		await seedHistoricalPresentation(messages, presentationData("first", "completed"))
		await seedHistoricalPresentation(messages, presentationData("second", "waiting"))
		await messages.flushPendingWrites()
	}

	it("branches submitted history rather than weakening generic overwrite", async () => {
		await seedCheckpoint()
		for (const content of ["retained user", "retained assistant", "discarded"]) {
			await messages.addToApiConversationHistory({ role: "user", content })
		}
		const history = messages.getApiConversationHistory()
		await messages.overwriteApiConversationProviderState({ submittedHistoryLength: history.length, historyPrefix: extendTranscriptPrefix(undefined, {}, history) })
		await assert.rejects(messages.overwriteApiConversationHistory(history.slice(0, 2)), TranscriptIntegrityError)
		await messages.patchMessageById("checkpoint", { conversationHistoryIndex: 0 })
		assert.deepEqual(await restore.restoreCheckpoint("checkpoint", "taskAndWorkspace"), {})
		assert.deepEqual(messages.getApiConversationHistory(), history.slice(0, 2))
		assert.ok(messages.getApiConversationProviderState().historyBranchId)
		sinon.assert.calledOnce(resetHead)
	})

	it("preflights unreadable presentation before resetting workspace files", async () => {
		expectLoggerErrors()
		await seedCheckpoint()
		await fs.appendFile(path.join(directory, "tasks", "root", GlobalFileNames.uiMessageOperations), "invalid-json\n")
		const result = await restore.restoreCheckpoint("checkpoint", "taskAndWorkspace")
		assert.ok(result.checkpointManagerErrorMessage)
		sinon.assert.notCalled(resetHead)
		sinon.assert.notCalled(cancel)
	})

	it("preflights retained-history integrity before resetting workspace files", async () => {
		expectLoggerErrors()
		await seedCheckpoint()
		sandbox.stub(messages, "validateApiConversationHistoryBranch").throws(new TranscriptIntegrityError("retained prefix"))
		const result = await restore.restoreCheckpoint("checkpoint", "taskAndWorkspace")
		assert.ok(result.checkpointManagerErrorMessage)
		sinon.assert.notCalled(resetHead)
	})

	for (const restoreType of ["task", "taskAndWorkspace"] as const) {
		it(`${restoreType}: retains current child snapshots instead of folding them into deleted root usage`, async () => {
			await seedCheckpoint()
			assert.deepEqual(await restore.restoreCheckpoint("checkpoint", restoreType), {})
			const saved = (await getSavedPresentationHistory("root")).messages
			const children = saved
				.flatMap((message) => (message.content.type === "card" ? [getTaskletUsage(message.content.card)] : []))
				.filter((usage) => usage !== undefined)
			assert.deepEqual(
				children.map((usage) => [usage.taskletId, usage.cost]),
				[
					["first", 7],
					["second", 11],
				],
			)
			assert.equal(getApiMetrics(saved).totalCost, 23)
			assert.equal(getApiMetrics(saved).totalTokensIn, 230)
			assert.equal(getApiMetrics(saved).totalCacheReads, 54)
			assert.equal(getApiMetrics(saved).totalReasoningTokens, 18)
			assert.equal(getLastApiReqTotalTokens(saved), 22)
			assert.deepEqual(upsertApiStatus.firstCall.args[0], {
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 3,
				usageAvailability: { inputTokens: true, outputTokens: true, cacheWrites: false, cacheReads: false, cost: true, reasoningTokens: false },
				deletedUsageAvailability: { inputTokens: true, outputTokens: true, cacheWrites: false, cacheReads: false, cost: true, reasoningTokens: false },
				deletedMetrics: { tokensIn: 30, tokensOut: 3, cacheWrites: undefined, cacheReads: undefined, reasoningTokens: 0 },
			})
			sinon.assert.calledOnce(cancel)
			sinon.assert.calledOnce(reset)
			assert.equal(resetHead.callCount, restoreType === "taskAndWorkspace" ? 1 : 0)
		})
	}

	it("retains known zero and unknown field availability across repeated checkpoint restoration", async () => {
		const known = { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheReads: true, cacheWrites: true, cost: true }
		await messages.addToDiracMessages({ id: "checkpoint", ts: 1, content: { type: DiracMessageType.CHECKPOINT } })
		await messages.flushPendingWrites()
		await messages.addToDiracMessages({
			id: "unknown-request", ts: 2, content: {
				type: DiracMessageType.API_STATUS, status: {
					tokensIn: 3, tokensOut: 1, cost: 0, reasoningTokens: 0, cacheReads: 0, cacheWrites: 0,
					usageAvailability: { ...known, cost: false },
				}
			}
		})
		await messages.flushPendingWrites()
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.deepEqual(await restore.restoreCheckpoint("checkpoint", "task"), {})
			const saved = (await getSavedPresentationHistory("root")).messages
			assert.deepEqual(getApiUsageKnowledge(saved), { usageObserved: true, usageAvailability: { ...known, cost: false } })
			assert.equal(getApiMetrics(saved).totalTokensIn, 3)
			assert.equal(getApiMetrics(saved).totalCost, 0)
		}
	})

	for (const emptyRequest of [false, true]) {
		it(`does not invent observed usage while archiving ${emptyRequest ? "an unreported request" : "no API messages"}`, async () => {
			const unavailable = { inputTokens: false, outputTokens: false, reasoningTokens: false, cacheReads: false, cacheWrites: false, cost: false }
			await messages.addToDiracMessages({ id: "checkpoint", ts: 1, content: { type: DiracMessageType.CHECKPOINT } })
			await messages.flushPendingWrites()
			if (emptyRequest) {
				await messages.addToDiracMessages({
					id: "unreported", ts: 2, content: {
						type: DiracMessageType.API_STATUS, status: {
							tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, cacheReads: 0, cacheWrites: 0, usageAvailability: unavailable,
						}
					}
				})
				await messages.flushPendingWrites()
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				assert.deepEqual(await restore.restoreCheckpoint("checkpoint", "task"), {})
				const saved = (await getSavedPresentationHistory("root")).messages
				assert.equal(getApiUsageKnowledge(saved).usageObserved, false)
				assert.equal(getApiMetrics(saved).totalTokensIn, 0)
				assert.equal(getApiMetrics(saved).totalCost, 0)
			}
		})
	}

	it("does not count historical tasklet snapshots again on repeated restore", async () => {
		await seedCheckpoint()
		await restore.restoreCheckpoint("checkpoint", "task")
		await restore.restoreCheckpoint("checkpoint", "task")
		const saved = (await getSavedPresentationHistory("root")).messages
		assert.equal(getApiMetrics(saved).totalCost, 23)
		assert.equal(
			saved.filter((message) => message.content.type === "card" && getTaskletUsage(message.content.card)).length,
			2,
		)
		assert.equal(upsertApiStatus.secondCall.args[0].cost, 3)
	})

	for (const restoreType of ["task", "taskAndWorkspace"] as const) {
		it(`${restoreType}: preserves latest presentation per stable child through truncation and repeated restore`, async () => {
			await seedCheckpoint()
			const latest = { ...presentationData("first", "failed"), result: "Latest result under a different card ID" }
			const card = { ...createTaskletPresentationCard(latest), id: "alternate-presentation-first" }
			await messages.addToDiracMessages({ id: card.id, ts: 2, content: { type: DiracMessageType.CARD, card } })
			await messages.flushPendingWrites()
			const before = getApiMetrics(messages.getDiracMessages())
			assert.equal(before.totalCost, 23)

			for (let attempt = 0; attempt < 2; attempt++) {
				// After cutover, a fresh projection must replace the retained alternate identity too.
				const expectedFirst = attempt === 0 ? latest : presentationData("first", "interrupted")
				if (attempt === 1) await seedHistoricalPresentation(messages, expectedFirst)
				assert.deepEqual(await restore.restoreCheckpoint("checkpoint", restoreType), {})
				const saved = (await getSavedPresentationHistory("root")).messages
				const presentations = saved.flatMap((message) => {
					if (message.content.type !== "card") return []
					const data = readTaskletPresentation(message.content.card)
					return data ? [data] : []
				})
				assert.deepEqual(presentations, [expectedFirst, presentationData("second", "waiting")])
				assert.deepEqual(getApiMetrics(saved), before)
				assert.equal(saved.filter((message) => message.content.type === "card" && getTaskletUsage(message.content.card)).length, 2)
				assert.equal(upsertApiStatus.getCall(attempt).args[0].cost, 3)
			}
		})

		it(`${restoreType}: retains live and archived retry cost/reasoning through repeated restoration`, async () => {
			await messages.addToDiracMessages({
				id: "checkpoint", ts: 1, lastCheckpointHash: "checkpoint-hash",
				content: { type: DiracMessageType.CHECKPOINT },
			})
			await messages.addToDiracMessages({
				id: "retried-request", ts: 2,
				content: {
					type: DiracMessageType.API_STATUS,
					status: {
						tokensIn: 30, tokensOut: 5, cost: 0.75, reasoningTokens: 6,
						deletedMetrics: { tokensIn: 20, tokensOut: 3, cost: 0.25, reasoningTokens: 4 },
					},
				},
			})
			await messages.flushPendingWrites()
			const before = getApiMetrics(messages.getDiracMessages())
			assert.equal(before.totalCost, 1)
			assert.equal(before.totalReasoningTokens, 10)

			for (let attempt = 0; attempt < 2; attempt++) {
				assert.deepEqual(await restore.restoreCheckpoint("checkpoint", restoreType), {})
				const saved = getApiMetrics((await getSavedPresentationHistory("root")).messages)
				assert.equal(saved.totalCost, before.totalCost)
				assert.equal(saved.totalReasoningTokens, before.totalReasoningTokens)
				assert.equal(saved.totalTokensIn, before.totalTokensIn)
				assert.equal(saved.totalTokensOut, before.totalTokensOut)
				assert.equal(upsertApiStatus.getCall(attempt).args[0].cost, 1)
				assert.equal(upsertApiStatus.getCall(attempt).args[0].deletedMetrics.reasoningTokens, 10)
			}
		})
	}

	it("keeps ordinary deleted root accounting unchanged when no tasklet snapshots exist", async () => {
		await messages.addToDiracMessages({ id: "checkpoint", ts: 1, content: { type: DiracMessageType.CHECKPOINT } })
		await messages.addToDiracMessages(apiMessage("after", 3))
		await messages.flushPendingWrites()
		await restore.restoreCheckpoint("checkpoint", "task")
		assert.equal(upsertApiStatus.firstCall.args[0].cost, 3)
		assert.equal(getApiMetrics((await getSavedPresentationHistory("root")).messages).totalCost, 3)
	})

	it("does not alter presentation or accounting during workspace-only restore", async () => {
		await seedCheckpoint()
		const before = structuredClone(messages.getDiracMessages())
		await restore.restoreCheckpoint("checkpoint", "workspace")
		assert.deepEqual(
			messages.getDiracMessages().map((message) => message.content),
			before.map((message) => message.content),
		)
		sinon.assert.notCalled(upsertApiStatus)
		sinon.assert.calledOnce(resetHead)
	})
})
