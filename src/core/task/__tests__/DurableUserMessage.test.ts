import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as history from "@core/storage/conversationHistory"
import * as disk from "@core/storage/disk"
import { GlobalFileNames } from "@core/storage/fileNames"
import { appendOperationRecords } from "@core/storage/operationLog"
import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import type { PresentationOperation } from "@shared/PresentationOperation"
import sinon from "sinon"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

const message = (id: string, role: "user" | "assistant" = "assistant"): DiracMessage => ({
	id,
	ts: 1,
	content: { type: DiracMessageType.MARKDOWN, role, content: id },
})

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function responsive<T>(action: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			action,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("State lock blocked on disk")), 500)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

describe("Durable user input message-state isolation", () => {
	let root: string
	let handler: MessageStateHandler
	let append: sinon.SinonStub
	const write = async (_address: unknown, operations: readonly unknown[]) =>
		appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations)
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-input-"))
		sinon.stub(disk, "ensureTaskDirectoryExists").resolves(root)
		append = sinon.stub(disk, "appendPresentationOperations").callsFake(write)
		sinon.stub(disk, "appendApiConversationOperations").resolves(0)
		handler = new MessageStateHandler({
			taskId: "task",
			ulid: "task",
			taskState: new TaskState(),
			updateTaskHistory: async () => [],
		})
	})
	afterEach(async () => {
		await handler.retirePersistence()
		sinon.restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	for (const outcome of ["success", "failure", "committed-rejection"] as const) {
		it(`keeps adds, patches, deletes and snapshots responsive during ${outcome}, preserving replay order`, async () => {
			await handler.addToDiracMessages(message("before"))
			await handler.addToDiracMessages(message("deleted"))
			await handler.flushPendingWrites()
			const entered = deferred()
			const release = deferred()
			append.callsFake(async (id, operations) => {
				if (
					!operations.some(
						(operation: PresentationOperation) => operation.type === "create" && operation.message.id === "input",
					)
				)
					return write(id, operations)
				entered.resolve()
				await release.promise
				if (outcome !== "failure") await write(id, operations)
				if (outcome !== "success") throw new Error("append failed")
				return 0
			})
			const sending = handler.appendDurableUserMessage(message("input", "user"), () => {})
			const settled = sending.then(
				() => undefined,
				(error: Error) => error,
			)
			await entered.promise
			try {
				await responsive(handler.addToDiracMessages(message("after")))
				await responsive(handler.appendMarkdownById("before", " updated"))
				await responsive(handler.deleteDiracMessage(handler.findMessageIndexById("deleted")))
				const snapshot = await responsive(handler.capturePresentationSnapshot())
				assert.deepEqual(
					snapshot.messages.map((item) => item.id),
					["before", "after"],
				)
				handler.acknowledgePresentationOperations(snapshot.offset)
				const generation = snapshot.generation
				release.resolve()
				const error = await settled
				assert.equal(error?.message, outcome === "failure" ? "append failed" : undefined)
				assert.ok(handler.getPresentationStateGeneration() > generation)
				await handler.flushPendingWrites()
				const saved = await history.readPresentationHistory(root)
				assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(handler.getDiracMessages())))
				assert.deepEqual(
					saved.messages.map((item) => item.id),
					outcome === "failure" ? ["before", "after"] : ["before", "input", "after"],
				)
			} finally {
				release.resolve()
				await settled
			}
		})
	}

	it("blocks later persistence after an unreadable ambiguous append, then reconciles without duplicating input", async () => {
		append.callsFake(async (id, operations) => {
			await write(id, operations)
			if (
				operations.some(
					(operation: PresentationOperation) => operation.type === "create" && operation.message.id === "input",
				)
			)
				throw new Error("acknowledgement lost")
			return 0
		})
		const read = sinon.stub(history, "readPresentationHistory").rejects(new Error("read unavailable"))
		await assert.rejects(
			handler.appendDurableUserMessage(message("input", "user"), () => {}),
			/read unavailable/,
		)
		await responsive(handler.addToDiracMessages(message("after")))
		const calls = append.callCount
		await assert.rejects(handler.flushPendingWrites(), /read unavailable/)
		assert.equal(append.callCount, calls)
		read.restore()
		await handler.flushPendingWrites()
		const saved = await history.readPresentationHistory(root)
		assert.deepEqual(
			saved.messages.map((item) => item.id),
			["input", "after"],
		)
		assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(handler.getDiracMessages())))
	})

	it("repairs a partially appended predecessor batch without losing concurrent ordinary output", async () => {
		append.onFirstCall().callsFake(async () => {
			await handler.addToDiracMessages(message("predecessor"))
			return 0
		})
		append.onSecondCall().callsFake(async (id, operations) => {
			await write(id, operations.slice(0, -1))
			await handler.addToDiracMessages(message("concurrent"))
			throw new Error("partial write")
		})
		await assert.rejects(
			handler.appendDurableUserMessage(message("input", "user"), () => {}),
			/partial write/,
		)
		await handler.flushPendingWrites()
		const saved = await history.readPresentationHistory(root)
		assert.deepEqual(
			saved.messages.map((item) => item.id),
			["predecessor", "concurrent"],
		)
		assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(handler.getDiracMessages())))
	})

	for (const change of ["replace", "retire"] as const) {
		it(`does not resurrect input after ${change} during a stalled append`, async () => {
			const entered = deferred()
			const release = deferred()
			append.callsFake(async (id, operations) => {
				if (operations.length) {
					entered.resolve()
					await release.promise
				}
				return write(id, operations)
			})
			const sending = handler.appendDurableUserMessage(message("input", "user"), () => {})
			const rejected = assert.rejects(sending, /changed/)
			await entered.promise
			let retired: Promise<void> | undefined
			if (change === "replace") handler.setDiracMessages([message("replacement")])
			else retired = handler.retirePersistence()
			await responsive(handler.capturePresentationSnapshot())
			release.resolve()
			await rejected
			await retired
			assert.equal(handler.getMessageById("input"), undefined)
			assert.equal((await history.readPresentationHistory(root)).messages[0].id, "input")
		})
	}
})
