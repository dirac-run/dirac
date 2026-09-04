import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { CardStatus, DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import {
	appendApiConversationOperations,
	appendPresentationOperations,
	createApiConversationBaseline,
	createPresentationBaseline,
	getPresentationHistoryAtMessage,
	getSavedApiConversationState,
	getSavedPresentationHistory,
} from "../conversationHistory"

describe("incremental conversation history", () => {
	let storageDirectory: string

	before(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-incremental-history-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	after(async () => {
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("loads a presentation baseline plus its tail and retains cold checkpoint replay", async () => {
		const taskId = "presentation-baseline"
		const card = cardMessage("card-a", "before")
		const checkpoint: DiracMessage = {
			id: "checkpoint-c",
			ts: 2,
			content: { type: DiracMessageType.CHECKPOINT },
		}
		await appendPresentationOperations(taskId, [
			{ offset: 0, type: "create", message: card },
			{ offset: 1, type: "create", message: checkpoint },
			{ offset: 2, type: "patch_card", id: card.id, patch: { header: "after" } },
		])

		const current = await getSavedPresentationHistory(taskId)
		assert.equal(current.messages[0].content.type, DiracMessageType.CARD)
		assert.equal(current.messages[0].content.card.header, "after")
		assert.equal(current.lastOffset, 2)
		const checkpointState = await getPresentationHistoryAtMessage(taskId, checkpoint.id)
		assert.equal(checkpointState[0].content.type, DiracMessageType.CARD)
		assert.equal((checkpointState[0].content as any).card.header, "before")

		await appendPresentationOperations(taskId, [{ offset: 3, type: "reset", messages: checkpointState }])
		const resetState = await getSavedPresentationHistory(taskId)
		assert.equal(resetState.lastOffset, 3)
		assert.equal((resetState.messages[0].content as any).card.header, "before")

		await createPresentationBaseline(taskId, resetState.messages, resetState.lastOffset)
		await appendPresentationOperations(taskId, [
			{ offset: 4, type: "patch_card", id: card.id, patch: { status: CardStatus.SUCCESS } },
		])
		const restored = await getSavedPresentationHistory(taskId)
		assert.equal(restored.lastOffset, 4)
		assert.equal((restored.messages[0].content as any).card.header, "before")
		assert.equal((restored.messages[0].content as any).card.status, CardStatus.SUCCESS)
		assert.equal(((await getPresentationHistoryAtMessage(taskId, checkpoint.id))[0].content as any).card.header, "before")
	})

	it("loads an API conversation baseline plus only its active tail", async () => {
		const taskId = "api-baseline"
		await appendApiConversationOperations(taskId, [
			{ offset: 0, type: "append_message", message: { role: "user", content: "question" } },
			{ offset: 1, type: "append_user_content", content: { type: "text", text: "detail" } },
		])
		const current = await getSavedApiConversationState(taskId)
		await createApiConversationBaseline(taskId, current.messages, current.lastOffset)
		await appendApiConversationOperations(taskId, [
			{ offset: 2, type: "append_message", message: { role: "assistant", content: "answer" } },
		])

		const restored = await getSavedApiConversationState(taskId)
		assert.equal(restored.lastOffset, 2)
		assert.equal(restored.messages.length, 2)
		assert.equal(restored.messages[1].content, "answer")
	})

	it("restores API and presentation payloads containing Unicode line boundaries", async () => {
		const taskId = "unicode-line-boundaries"
		const payload = "before\u2028middle\u2029after"
		const card = cardMessage("unicode-card", "Unicode payload")
		if (card.content.type !== DiracMessageType.CARD) throw new Error("Expected card")
		card.content.card.body = payload

		await appendPresentationOperations(taskId, [{ offset: 0, type: "create", message: card }])
		await appendApiConversationOperations(taskId, [
			{ offset: 0, type: "append_message", message: { role: "assistant", content: payload } },
		])

		const presentation = await getSavedPresentationHistory(taskId)
		const apiConversation = await getSavedApiConversationState(taskId)
		assert.equal(presentation.lastOffset, 0)
		assert.equal(presentation.messages[0].content.type, DiracMessageType.CARD)
		if (presentation.messages[0].content.type !== DiracMessageType.CARD) throw new Error("Expected card")
		assert.equal(presentation.messages[0].content.card.body, payload)
		assert.equal(apiConversation.lastOffset, 0)
		assert.equal(apiConversation.messages[0].content, payload)
	})

	it("replays field deletion without repeating unchanged API request text", async () => {
		const taskId = "api-status-field-deletion"
		const apiStatus: DiracMessage = {
			id: "api-status",
			ts: 1,
			content: {
				type: DiracMessageType.API_STATUS,
				status: {
					request: "large request remains unchanged",
					retryStatus: { attempt: 1, maxAttempts: 3, delaySec: 2 },
				},
			},
		}
		await appendPresentationOperations(taskId, [
			{ offset: 0, type: "create", message: apiStatus },
			{
				offset: 1,
				type: "patch_api_status",
				id: apiStatus.id,
				patch: { cost: 0.25 },
				deletions: ["retryStatus"],
			},
		])

		const restored = await getSavedPresentationHistory(taskId)
		const restoredStatus = restored.messages[0]
		assert.equal(restoredStatus.content.type, DiracMessageType.API_STATUS)
		if (restoredStatus.content.type !== DiracMessageType.API_STATUS) throw new Error("Expected API status")
		assert.equal(restoredStatus.content.status.request, "large request remains unchanged")
		assert.equal(restoredStatus.content.status.retryStatus, undefined)
		assert.equal(restoredStatus.content.status.cost, 0.25)
	})

	it("recovers the canonical replacement branch from interleaved stale cancellation writes", async () => {
		const taskId = "presentation-cancellation-fork"
		const base: DiracMessage = {
			id: "base",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "base" },
		}
		const staleStatus: DiracMessage = {
			id: "stale-api",
			ts: 2,
			content: { type: DiracMessageType.API_STATUS, status: { request: "cancelled request" } },
		}
		const checkpoint: DiracMessage = {
			id: "canonical-checkpoint",
			ts: 3,
			content: { type: DiracMessageType.CHECKPOINT },
		}
		const canonicalMessage: DiracMessage = {
			id: "canonical-message",
			ts: 4,
			content: { type: DiracMessageType.MARKDOWN, content: "replacement" },
		}
		const staleCard = cardMessage("stale-retry", "API Error (Retrying)")

		await appendPresentationOperations(taskId, [
			{ offset: 0, type: "create", message: base },
			{ offset: 1, type: "create", message: staleStatus },
			{ offset: 2, type: "reset", messages: [base] },
			{ offset: 3, type: "create", message: checkpoint },
			{ offset: 4, type: "create", message: canonicalMessage },
			{ offset: 2, type: "patch_api_status", id: staleStatus.id, patch: { cancelReason: "user_cancelled" } },
			{ offset: 3, type: "patch_api_status", id: staleStatus.id, patch: { cost: 0 } },
			{ offset: 4, type: "create", message: staleCard },
			{ offset: 5, type: "patch_card", id: staleCard.id, patch: { status: CardStatus.CANCELLED } },
			{ offset: 5, type: "append_markdown", id: canonicalMessage.id, text: " branch" },
			{ offset: 6, type: "patch_message", id: checkpoint.id, patch: { isCheckpointCheckedOut: true } },
		])

		const restored = await getSavedPresentationHistory(taskId)
		assert.equal(restored.lastOffset, 6)
		assert.deepEqual(
			restored.messages.map((message) => message.id),
			[base.id, checkpoint.id, canonicalMessage.id],
		)
		assert.equal(restored.messages[2].content.type, DiracMessageType.MARKDOWN)
		if (restored.messages[2].content.type !== DiracMessageType.MARKDOWN) throw new Error("Expected markdown")
		assert.equal(restored.messages[2].content.content, "replacement branch")
		assert.deepEqual(
			(await getPresentationHistoryAtMessage(taskId, checkpoint.id)).map((message) => message.id),
			[base.id, checkpoint.id],
		)
	})

	it("ignores a validated stale cancellation tail at end of file", async () => {
		const taskId = "presentation-stale-tail"
		const staleStatus: DiracMessage = {
			id: "tail-api",
			ts: 1,
			content: { type: DiracMessageType.API_STATUS, status: { request: "cancelled request" } },
		}
		await appendPresentationOperations(taskId, [
			{ offset: 0, type: "create", message: staleStatus },
			{ offset: 1, type: "reset", messages: [] },
			{ offset: 1, type: "patch_api_status", id: staleStatus.id, patch: { cancelReason: "user_cancelled" } },
			{ offset: 2, type: "patch_api_status", id: staleStatus.id, patch: { cost: 0 } },
		])

		const restored = await getSavedPresentationHistory(taskId)
		assert.equal(restored.lastOffset, 1)
		assert.deepEqual(restored.messages, [])
	})

	it("rejects an invalid stale-branch signature instead of masking corruption", async () => {
		const taskId = "presentation-invalid-fork"
		const canonicalMessage: DiracMessage = {
			id: "canonical",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "canonical" },
		}
		await appendPresentationOperations(taskId, [
			{ offset: 0, type: "reset", messages: [] },
			{ offset: 1, type: "create", message: canonicalMessage },
			{ offset: 0, type: "patch_message", id: "absent-before-reset", patch: { ts: 2 } },
			{ offset: 2, type: "patch_message", id: "absent-before-reset", patch: { ts: 3 } },
		])

		await assert.rejects(getSavedPresentationHistory(taskId), /Failed to apply operation record/)
	})

})

function cardMessage(id: string, header: string): DiracMessage {
	return {
		id,
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: { id, header, status: CardStatus.RUNNING, renderType: "text", body: "large body" },
		},
	}
}
