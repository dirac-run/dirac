import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	getSavedApiConversationProviderState,
	getSavedApiConversationState,
	getSavedPresentationHistory,
} from "@core/storage/conversationHistory"
import { GlobalFileNames } from "@core/storage/fileNames"
import * as operationLog from "@core/storage/operationLog"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { type DiracMessage, DiracMessageType } from "@/shared/ExtensionMessage"
import { createTaskletFixtureId as createTaskletId } from "@/test/taskletFixtures"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

const message = (id: string, text = id): DiracMessage => ({
	id,
	ts: 1,
	conversationHistoryIndex: -1,
	content: { type: DiracMessageType.MARKDOWN, role: "user", content: text },
})

describe("Root-qualified MessageStateHandler persistence", () => {
	let temporaryDirectory: string
	let addresses: TaskStorageAddress[]
	let handlers: MessageStateHandler[]

	function createHandler(address: TaskStorageAddress, updateTaskHistory = sinon.stub().resolves([])): MessageStateHandler {
		const handler = new MessageStateHandler({
			taskId: address.kind === "task" ? address.taskId : address.taskletId,
			// Exercise existing root callers that do not supply a storage address.
			storageAddress: address.kind === "tasklet" ? address : undefined,
			ulid: "test-ulid",
			taskState: new TaskState(),
			updateTaskHistory,
		})
		handlers.push(handler)
		return handler
	}

	beforeEach(async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-message-state-"))
		setVscodeHostProviderMock({ globalStorageFsPath: temporaryDirectory })
		addresses = [
			{ kind: "task", taskId: "root" },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
		]
		handlers = []
	})

	afterEach(async () => {
		await Promise.all(handlers.map((handler) => handler.retirePersistence()))
		sinon.restore()
		HostProvider.reset()
		await fs.rm(temporaryDirectory, { recursive: true, force: true })
	})

	it("concurrently flushes and restores three independent handlers, then continues their offsets", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				const handler = createHandler(address)
				await handler.addToDiracMessages(message("shared-id", `execution-${index}`))
				await handler.addToApiConversationHistory({ role: "user", content: `api-${index}` })
				await handler.appendMarkdownById("shared-id", " appended")
				await handler.appendToLastApiConversationUserMessage({ type: "text", text: `extra-${index}` })
				await handler.overwriteApiConversationProviderState({ deliveredSteeringMessageIds: [`provider-${index}`] })
				await handler.recordDeliveredSteeringMessageIds([`steering-${index}`])
				await handler.flushPendingWrites()
				await handler.retirePersistence()

				const presentation = await getSavedPresentationHistory(address)
				const api = await getSavedApiConversationState(address)
				const provider = await getSavedApiConversationProviderState(address)
				assert.deepEqual(presentation.messages, [message("shared-id", `execution-${index} appended`)])
				assert.deepEqual(api.messages, [
					{
						role: "user",
						content: [
							{ type: "text", text: `api-${index}` },
							{ type: "text", text: `extra-${index}` },
						],
					},
				])
				assert.deepEqual(provider, { deliveredSteeringMessageIds: [`provider-${index}`, `steering-${index}`] })

				const restored = createHandler(address)
				restored.setDiracMessages(presentation.messages, presentation.lastOffset)
				restored.setApiConversationHistory(api.messages, api.lastOffset)
				restored.setApiConversationProviderState(provider)
				await restored.appendMarkdownById("shared-id", " restored")
				await restored.addToApiConversationHistory({ role: "assistant", content: `reply-${index}` })
				await restored.flushPendingWrites()
				assert.deepEqual((await getSavedPresentationHistory(address)).messages, restored.getDiracMessages())
				assert.deepEqual((await getSavedApiConversationState(address)).messages, restored.getApiConversationHistory())
				assert.equal((await getSavedPresentationHistory(address)).lastOffset, presentation.lastOffset + 1)
				assert.equal((await getSavedApiConversationState(address)).lastOffset, api.lastOffset + 1)
			}),
		)
		assert.deepEqual(await fs.readdir(path.join(temporaryDirectory, "tasks")), ["root"])
	})

	it("writes compaction baselines and subsequent resets only to the addressed execution", async () => {
		// Force the existing threshold decision; baseline writes, archive rotation and replay use real files.
		sinon.stub(operationLog, "operationLogExceedsBaselineThreshold").resolves(true)
		await Promise.all(
			addresses.map(async (address, index) => {
				const handler = createHandler(address)
				await handler.addToDiracMessages(message("shared-id", `baseline-${index}`))
				await handler.addToApiConversationHistory({ role: "user", content: `baseline-${index}` })
				await handler.flushPendingWrites()
				for (const file of [GlobalFileNames.uiMessagesBaseline, GlobalFileNames.apiConversationHistoryBaseline]) {
					await fs.access(path.join(getTaskDirectoryPath(address), file))
				}
				await handler.overwriteDiracMessages([message("replacement", `replacement-${index}`)])
				await handler.overwriteApiConversationHistory([{ role: "user", content: `replacement-${index}` }])
				assert.deepEqual((await getSavedPresentationHistory(address)).messages, handler.getDiracMessages())
				assert.deepEqual((await getSavedApiConversationState(address)).messages, handler.getApiConversationHistory())
			}),
		)
	})

	it("surfaces a tasklet flush failure, preserves sibling writes, and retries the affected queue", async () => {
		const active = addresses.map((address) => createHandler(address))
		await Promise.all(active.map((handler, index) => handler.addToDiracMessages(message("shared-id", `initial-${index}`))))
		await Promise.all(active.map((handler) => handler.flushPendingWrites()))
		const failedPath = path.join(getTaskDirectoryPath(addresses[1]), GlobalFileNames.uiMessageOperations)
		const appendFile = fs.appendFile.bind(fs)
		const failure = new Error("injected tasklet append failure")
		const stub = sinon.stub(fs, "appendFile").callsFake(async (file, data, options) => {
			if (file === failedPath) throw failure
			return appendFile(file, data, options)
		})
		await Promise.all(active.map((handler) => handler.appendMarkdownById("shared-id", " next")))
		const results = await Promise.allSettled(active.map((handler) => handler.flushPendingWrites()))
		assert.deepEqual(
			results.map((result) => result.status),
			["fulfilled", "rejected", "fulfilled"],
		)
		assert.equal((results[1] as PromiseRejectedResult).reason, failure)
		assert.deepEqual((await getSavedPresentationHistory(addresses[1])).messages, [message("shared-id", "initial-1")])
		for (const index of [0, 2]) {
			assert.deepEqual((await getSavedPresentationHistory(addresses[index])).messages, [
				message("shared-id", `initial-${index} next`),
			])
		}
		stub.restore()
		await active[1].flushPendingWrites()
		assert.deepEqual((await getSavedPresentationHistory(addresses[1])).messages, [message("shared-id", "initial-1 next")])
	})

	it("reconciles an ambiguous durable input append within the affected tasklet only", async () => {
		const active = addresses.map((address) => createHandler(address))
		const failedPath = path.join(getTaskDirectoryPath(addresses[1]), GlobalFileNames.uiMessageOperations)
		const appendFile = fs.appendFile.bind(fs)
		sinon.stub(fs, "appendFile").callsFake(async (file, data, options) => {
			await appendFile(file, data, options)
			if (file === failedPath) throw new Error("acknowledgement lost")
		})
		await Promise.all(
			active.map((handler, index) => handler.appendDurableUserMessage(message("input", `input-${index}`), () => {})),
		)
		for (const [index, address] of addresses.entries()) {
			assert.deepEqual(
				(await getSavedPresentationHistory(address)).messages,
				JSON.parse(JSON.stringify(active[index].getDiracMessages())),
			)
			assert.equal(active[index].getDiracMessages().length, 1)
		}
	})

	it("flushes contained conversations without publishing ordinary Task inventory entries", async () => {
		const updateTaskHistory = sinon.stub().resolves([])
		const handler = createHandler(addresses[1], updateTaskHistory)
		await handler.addToDiracMessages(message("contained"))
		await handler.flushTaskHistory()
		await handler.saveDiracMessagesAndUpdateHistory()
		assert.deepEqual((await getSavedPresentationHistory(addresses[1])).messages, [message("contained")])
		sinon.assert.notCalled(updateTaskHistory)
	})
})
