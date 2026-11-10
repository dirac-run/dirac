import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { getSavedPresentationHistory, readSavedPresentationHistory } from "@core/storage/conversationHistory"
import { GlobalFileNames } from "@core/storage/fileNames"
import { DiracMessageType, type Card } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { createTaskletPresentationCard, readTaskletPresentation, type TaskletPresentationData } from "@shared/taskletPresentation"
import { taskletReceiptRowTitle } from "@shared/taskletReceipt"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

const data: TaskletPresentationData = {
	taskletId: "Planck 2", title: "Review changes", prompt: "Check correctness", createdAt: 123,
	status: "completed", result: "Complete", activity: [], communications: [],
	usage: { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0.5, reasoningTokens: 3 },
}

describe("Historical tasklet presentation and passive saved reads", () => {
	let directory: string
	let handlers: MessageStateHandler[]
	function handler() {
		const result = new MessageStateHandler({
			taskId: "root", ulid: "root-conversation", taskState: new TaskState(), updateTaskHistory: async () => [],
		})
		handlers.push(result)
		return result
	}
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-presentation-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		handlers = []
	})
	afterEach(async () => {
		await Promise.all(handlers.map((entry) => entry.retirePersistence()))
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("formats saved custom/default roles consistently without inventing a legacy role", () => {
		for (const role of ["Reviewer", "default", undefined]) {
			const identity = { taskletId: "Feynman", title: "Review changes", role }
			const expected = `Feynman${role ? ` (${role})` : ""} — Review changes`
			const card = createTaskletPresentationCard({ ...data, ...identity })
			assert.equal(card.header, expected)
			assert.equal(taskletReceiptRowTitle(identity), expected)
			assert.equal(readTaskletPresentation(card)?.role, role)
		}
	})

	it("keeps authored preview content and uses a concise waiting status", () => {
		const text = "  Detailed finding\n```ts\nconst answer = 42\n```\n"
		const card = createTaskletPresentationCard({ ...data, status: "waiting", result: text, communications: [text] })
		assert.match(card.body!, /Waiting for Dirac\./)
		assert.doesNotMatch(card.body!, /no user approval/)
		assert.equal(readTaskletPresentation(card)?.result, text)
		assert.deepEqual(readTaskletPresentation(card)?.communications, [text])
	})

	it("reads legacy cards without restoring a live projector or double-counting their usage", async () => {
		const root = handler()
		const card = createTaskletPresentationCard(data)
		await root.addToDiracMessages({ id: card.id, ts: data.createdAt, content: { type: DiracMessageType.CARD, card } })
		await root.flushPendingWrites()
		const saved = await getSavedPresentationHistory("root")
		await root.retirePersistence()
		const restored = handler()
		restored.setDiracMessages(saved.messages, saved.lastOffset)
		const historical = (restored.getDiracMessages()[0].content as { card: Card }).card
		assert.equal(readTaskletPresentation(historical)?.result, "Complete")
		assert.equal(historical.requireApproval, undefined)
		assert.equal(historical.header, "Planck 2 — Review changes")
		assert.match(historical.body!, /Planck 2 — Review changes/)
		assert.equal(historical.requireFeedback, undefined)
		assert.equal(historical.actions, undefined)
		assert.equal("upsertTaskletPresentation" in restored, false)
		assert.equal(restored.getApiConversationHistory().length, 0)
		assert.equal(getApiMetrics(restored.getDiracMessages()).totalCost, 0)
		await restored.upsertTaskletUsage(data.taskletId, data.usage!)
		assert.equal(getApiMetrics(restored.getDiracMessages()).totalCost, 0.5)
	})

	it("does not create missing task storage during passive reads", async () => {
		assert.deepEqual(await readSavedPresentationHistory("missing"), { messages: [], lastOffset: -1 })
		assert.deepEqual(await fs.readdir(directory), [])
	})

	it("reads legacy transcripts without migrating or backing up files", async () => {
		const taskDirectory = path.join(directory, "tasks", "root")
		await fs.mkdir(taskDirectory, { recursive: true })
		const file = path.join(taskDirectory, "claude_messages.json")
		const messages = [{ id: "old", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: "Old message" } }]
		const contents = JSON.stringify(messages)
		await fs.writeFile(file, contents)
		assert.deepEqual(await readSavedPresentationHistory("root"), { messages, lastOffset: -1 })
		assert.deepEqual(await fs.readdir(taskDirectory), ["claude_messages.json"])
		assert.equal(await fs.readFile(file, "utf8"), contents)
	})

	it("rejects partially unreadable legacy transcripts without making recovery writes", async () => {
		const taskDirectory = path.join(directory, "tasks", "root")
		await fs.mkdir(taskDirectory, { recursive: true })
		const contents = JSON.stringify([
			{ id: "valid", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: "Retained" } },
			{ invalid: true },
		])
		const file = path.join(taskDirectory, GlobalFileNames.uiMessages)
		await fs.writeFile(file, contents)
		await assert.rejects(readSavedPresentationHistory("root"), /unreadable messages/)
		assert.deepEqual(await fs.readdir(taskDirectory), [GlobalFileNames.uiMessages])
		assert.equal(await fs.readFile(file, "utf8"), contents)
	})
})
