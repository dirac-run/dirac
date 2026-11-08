import { extendTranscriptPrefix, TranscriptIntegrityError } from "@core/api/TranscriptPrefix"
import type { DiracStorageMessage } from "@shared/messages/content"
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { HostProvider } from "@/hosts/host-provider"
import { DiracMessageType } from "@shared/ExtensionMessage"
import { TaskState } from "../TaskState"
import { MessageStateHandler } from "../message-state"
import sinon from "sinon"
import * as operationLog from "@core/storage/operationLog"
import { createApiConversationBaseline, getSavedApiConversationState, getSavedApiConversationProviderState, saveApiConversationProviderState } from "@core/storage/conversationHistory"

describe("MessageStateHandler task history", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-message-history-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("isolates saved messages and rejects changes to submitted history", async () => {
		const handler = new MessageStateHandler({
			taskId: "sealed-task", ulid: "sealed-conversation", taskState: new TaskState(),
			updateTaskHistory: async (item) => [item],
		})
		try {
			const message: DiracStorageMessage = { role: "user", content: [{ type: "text", text: "original" }] }
			await handler.addToApiConversationHistory(message)
			message.content = "external edit"
			const history = handler.getApiConversationHistory()
			handler.setApiConversationProviderState({
				submittedHistoryLength: history.length,
				historyPrefix: extendTranscriptPrefix(undefined, {}, history),
			})
			history[0].content = "edited snapshot"
			assert.deepEqual(handler.getApiConversationHistory()[0].content, [{ type: "text", text: "original" }])
			await assert.rejects(handler.appendToLastApiConversationUserMessage({ type: "text", text: "late" }), TranscriptIntegrityError)
			await assert.rejects(handler.overwriteApiConversationHistory(history), TranscriptIntegrityError)
			await assert.rejects(handler.overwriteApiConversationHistory([]), TranscriptIntegrityError)
			assert.throws(() => handler.setApiConversationHistory([]), TranscriptIntegrityError)
			await handler.addToApiConversationHistory({ role: "user", content: "new tail" })
			await handler.appendToLastApiConversationUserMessage({ type: "text", text: "pending addition" })
			assert.equal(handler.getApiConversationHistory().length, 2)
		} finally {
			await handler.flushPendingWrites()
		}
	})

	it("commits checkpoint history and provider lineage together and survives a stale provider file and baseline archival", async () => {
		const handler = new MessageStateHandler({
			taskId: "branch-task", ulid: "branch-conversation", taskState: new TaskState(), updateTaskHistory: async () => [],
		})
		try {
			await handler.addToApiConversationHistory({ role: "user", content: "retained" })
			await handler.addToApiConversationHistory({ role: "assistant", content: "removed" })
			const history = handler.getApiConversationHistory()
			const oldState = { submittedHistoryLength: 2, historyPrefix: extendTranscriptPrefix(undefined, {}, history), transcript: extendTranscriptPrefix(undefined, {}, history) }
			await handler.overwriteApiConversationProviderState(oldState)
			await assert.rejects(handler.branchApiConversationHistory([{ role: "user", content: "edited" }]), TranscriptIntegrityError)
			await handler.branchApiConversationHistory(history.slice(0, 1))
			const branch = handler.getApiConversationProviderState()
			assert.equal(branch.previousTranscriptId, oldState.transcript.id)
			assert.ok(branch.historyBranchId)
			assert.equal(branch.checkpoint, undefined)
			assert.equal(branch.transcriptInstructions, undefined)
			assert.deepEqual((await getSavedApiConversationState("branch-task")).messages, history.slice(0, 1))
			assert.deepEqual(await getSavedApiConversationProviderState("branch-task"), branch)
			await assert.rejects(handler.overwriteApiConversationProviderState(oldState), TranscriptIntegrityError)
			await assert.rejects(handler.overwriteApiConversationHistory([]), TranscriptIntegrityError)
			await handler.addToApiConversationHistory({ role: "user", content: "new branch tail" })
			const newer = { ...branch, transcriptInstructions: { systemPrompt: "new", latestInstructions: "new", runtimeContext: "context" } }
			await handler.overwriteApiConversationProviderState(newer)
			assert.deepEqual(await getSavedApiConversationProviderState("branch-task"), newer)
			const saved = await getSavedApiConversationState("branch-task")
			await createApiConversationBaseline("branch-task", saved.messages, saved.lastOffset)
			assert.deepEqual((await getSavedApiConversationState("branch-task")).messages, handler.getApiConversationHistory())
			assert.deepEqual(await getSavedApiConversationProviderState("branch-task"), newer)
			// A late old-generation disk file cannot replace the archived branch authority.
			await saveApiConversationProviderState("branch-task", oldState)
			assert.deepEqual(await getSavedApiConversationProviderState("branch-task"), branch)
		} finally {
			await handler.retirePersistence()
		}
	})

	for (const committed of [false, true]) {
		it(`reconciles a ${committed ? "complete" : "partial"} branch frame after an append error`, async () => {
			const handler = new MessageStateHandler({
				taskId: "failed-branch", ulid: "failed-branch", taskState: new TaskState(), updateTaskHistory: async () => [],
			})
			const sandbox = sinon.createSandbox()
			try {
				await handler.addToApiConversationHistory({ role: "user", content: "retained" })
				await handler.addToApiConversationHistory({ role: "assistant", content: "discarded" })
				const history = handler.getApiConversationHistory()
				const oldState = { historyPrefix: extendTranscriptPrefix(undefined, {}, history), submittedHistoryLength: history.length }
				await handler.overwriteApiConversationProviderState(oldState)
				const append = operationLog.appendOperationRecords
				const failure = new Error("injected append failure")
				sandbox.stub(operationLog, "appendOperationRecords").callsFake(async (filePath, records) => {
					if (records.length === 0) return append(filePath, records)
					if (committed) await append(filePath, records)
					else await fs.appendFile(filePath, operationLog.encodeOperationRecords(records).slice(0, 25))
					throw failure
				})
				await assert.rejects(handler.branchApiConversationHistory(history.slice(0, 1)), (error) => error === failure)
				const expected = committed ? history.slice(0, 1) : history
				assert.deepEqual(handler.getApiConversationHistory(), expected)
				assert.deepEqual((await getSavedApiConversationState("failed-branch")).messages, expected)
				assert.deepEqual(await getSavedApiConversationProviderState("failed-branch"), JSON.parse(JSON.stringify(handler.getApiConversationProviderState())))
				sandbox.restore()
				// A subsequent append discards only an incomplete frame and can still branch.
				await handler.branchApiConversationHistory(history.slice(0, 1))
				assert.deepEqual((await getSavedApiConversationState("failed-branch")).messages, history.slice(0, 1))
			} finally {
				sandbox.restore()
				await handler.retirePersistence()
			}
		})
	}

	it("measures the complete task directory at the history boundary", async () => {
		let historyItem: { size?: number } | undefined
		const handler = new MessageStateHandler({
			taskId: "task-1",
			ulid: "conversation-1",
			taskState: new TaskState(),
			updateTaskHistory: async (item) => {
				historyItem = item
				return [item]
			},
		})
		await handler.addToDiracMessages({
			id: "task",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "task", role: "user" },
		})
		const taskDirectory = path.join(storageDirectory, "tasks", "task-1")
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(path.join(taskDirectory, "non-log-artifact.bin"), Buffer.alloc(4_096))

		await handler.flushTaskHistory()

		assert.ok((historyItem?.size ?? 0) >= 4_096)
	})
})
