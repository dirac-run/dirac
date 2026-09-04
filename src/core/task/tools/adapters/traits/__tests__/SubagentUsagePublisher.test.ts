import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { getSavedDiracMessages } from "@core/storage/disk"
import { reconstructTaskHistoryItem } from "@core/commands/reconstructTaskHistory"
import { MessageStateHandler } from "@core/task/message-state"
import { TaskState } from "@core/task/TaskState"
import { createEmptySubagentRunStats } from "@core/task/tools/subagent/SubagentRunHelpers"
import { HostProvider } from "@hosts/host-provider"
import { DiracMessageType } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { SubagentUsagePublisher } from "../SubagentUsagePublisher"

const stats = (totalCost: number) => ({
	...createEmptySubagentRunStats(),
	inputTokens: 100,
	outputTokens: 20,
	cacheReadTokens: 10,
	totalCost,
})

describe("SubagentUsagePublisher", () => {
	let directory: string
	let messages: MessageStateHandler
	let historyCost: number | undefined

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-subagent-usage-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		messages = new MessageStateHandler({
			taskId: "task-1",
			ulid: "conversation-1",
			taskState: new TaskState(),
			updateTaskHistory: async (item) => {
				assert.ok("totalCost" in item)
				historyCost = item.totalCost
				return [item]
			},
		})
		await messages.addToDiracMessages({
			id: "main",
			ts: 1,
			content: { type: DiracMessageType.API_STATUS, status: { tokensIn: 10, tokensOut: 5, cost: 0.25 } },
		})
	})

	afterEach(async () => {
		await messages.flushPendingWrites()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("replaces parallel run snapshots and preserves totals in persisted and reconstructed history", async () => {
		const first = new SubagentUsagePublisher(messages, async () => {}, "first")
		const second = new SubagentUsagePublisher(messages, async () => {}, "second")
		await Promise.all([first.update(stats(0.5)), second.update(stats(1))])
		assert.equal(getApiMetrics(messages.getDiracMessages()).totalCost, 1.75)
		await first.update(stats(0.75))
		await Promise.all([first.finish(stats(1)), second.finish(stats(2))])
		await first.update(stats(0.5)) // Late observer delivery must not overwrite terminal usage.
		assert.equal(messages.getDiracMessages().length, 3)
		assert.equal(getApiMetrics(messages.getDiracMessages()).totalCost, 3.25)
		assert.equal(getLastApiReqTotalTokens(messages.getDiracMessages()), 15)

		await messages.flushTaskHistory()
		assert.equal(historyCost, 3.25)
		const saved = await getSavedDiracMessages("task-1")
		assert.equal(getApiMetrics(saved).totalCost, 3.25)
		const reconstructed = await reconstructTaskHistoryItem("task-1")
		assert.ok(reconstructed && "totalCost" in reconstructed)
		assert.equal(reconstructed.totalCost, 3.25)
	})

	it("persists usage even when UI publication fails", async () => {
		let failPublication = true
		const publisher = new SubagentUsagePublisher(
			messages,
			async () => {
				if (failPublication) throw new Error("UI unavailable")
			},
			"agent",
		)
		await assert.rejects(publisher.update(stats(0.5)), /UI unavailable/)
		assert.equal(getApiMetrics(messages.getDiracMessages()).totalCost, 0.75)
		failPublication = false
		await publisher.finish(stats(1))
		assert.equal(getApiMetrics(messages.getDiracMessages()).totalCost, 1.25)
	})

	it("finalizes accounting without waiting for a stalled UI publication", async () => {
		let resumePublication!: () => void
		const publication = new Promise<void>((resolve) => {
			resumePublication = resolve
		})
		const publisher = new SubagentUsagePublisher(messages, () => publication, "agent")
		const updating = publisher.update(stats(0.5))
		await publisher.finish(stats(1))
		assert.equal(getApiMetrics(messages.getDiracMessages()).totalCost, 1.25)
		resumePublication()
		await updating
	})

	it("recomputes history for structured-only patches regardless of title or body", async () => {
		const publisher = new SubagentUsagePublisher(messages, async () => {}, "agent")
		await publisher.finish(stats(1))
		const record = messages.getDiracMessages()[1]
		assert.equal(record.content.type, DiracMessageType.CARD)
		if (record.content.type !== DiracMessageType.CARD) throw new Error("Expected usage card")
		await messages.patchCardById(record.content.card.id, {
			header: "Localized label",
			body: "Not JSON",
		})
		await messages.patchCardById(record.content.card.id, {
			rawOutput: { ...record.content.card.rawOutput, cost: 2 },
		})
		await messages.flushTaskHistory()
		assert.equal(historyCost, 2.25)
	})
})
