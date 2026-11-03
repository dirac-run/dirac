import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { getSavedPresentationHistory } from "@core/storage/conversationHistory"
import { CardStatus, DiracMessageType, type Card } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { createTaskletPresentationCard, readTaskletPresentation, taskletActivityPreview, type TaskletPresentationData } from "@shared/taskletPresentation"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

const data: TaskletPresentationData = {
	taskletId: "stable-child", title: "Review changes", prompt: "Check correctness", createdAt: 123,
	status: "running", activity: [], communications: [],
	usage: { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0.5, reasoningTokens: 3 },
}

describe("Tasklet root presentation projection", () => {
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

	it("retains one stable informational card across running, waiting, terminal, restoration and reopening", async () => {
		const root = handler()
		await root.upsertTaskletPresentation(data)
		await root.upsertTaskletPresentation({ ...data, status: "waiting", communications: ["Parent question"] })
		let card = (root.getDiracMessages()[0].content as { card: Card }).card
		assert.equal(card.status, CardStatus.WAITING_FOR_INPUT)
		assert.equal(card.requireApproval, undefined)
		assert.equal(card.requireFeedback, undefined)
		assert.equal(card.actions, undefined)
		await root.upsertTaskletPresentation({ ...data, status: "completed", result: "Complete" })
		await root.flushPendingWrites()
		const saved = await getSavedPresentationHistory("root")
		await root.retirePersistence()
		const restored = handler()
		restored.setDiracMessages(saved.messages, saved.lastOffset)
		assert.equal(readTaskletPresentation((restored.getDiracMessages()[0].content as { card: Card }).card)?.result, "Complete")
		await restored.upsertTaskletPresentation({ ...data, status: "running" })
		assert.equal(restored.getDiracMessages().length, 1)
		card = (restored.getDiracMessages()[0].content as { card: Card }).card
		assert.equal(card.id, "tasklet:stable-child")
		assert.equal(card.status, CardStatus.RUNNING)
		assert.equal(restored.getApiConversationHistory().length, 0)
		assert.equal(getApiMetrics(restored.getDiracMessages()).totalCost, 0)
		await restored.upsertTaskletUsage(data.taskletId, data.usage!)
		await restored.upsertTaskletPresentation({ ...data, status: "interrupted" })
		assert.equal(getApiMetrics(restored.getDiracMessages()).totalCost, 0.5)
	})

	it("bounds diagnostic and communication previews without presenting a user approval path", () => {
		const full = `${"detail ".repeat(1000)}FULL-END`
		const card = createTaskletPresentationCard({ ...data, status: "waiting", result: full, prompt: full,
			activity: Array(50).fill(full), communications: Array(50).fill(full) })
		const projection = readTaskletPresentation(card)!
		assert.equal(projection.activity.length, 40)
		assert.equal(projection.communications.length, 40)
		assert.ok(projection.result!.length < full.length)
		assert.match(projection.result!, /inspect tasklet for full contents/)
		assert.match(card.body!, /Waiting for the parent/)
		assert.equal(card.requireApproval, undefined)
		assert.equal(readTaskletPresentation({ ...card, rawInput: {} }), undefined)
		assert.deepEqual(taskletActivityPreview([
			{ id: "activity", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: "Diagnostic only" } },
		]), ["Diagnostic only"])
	})
})
