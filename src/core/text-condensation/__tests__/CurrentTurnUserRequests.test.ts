import { strict as assert } from "node:assert"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { CardKind, CardStatus, DiracMessageType, SteeringTranscriptStatus, type DiracMessage } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import { formatCurrentTurnUserRequests, getCurrentTurnUserRequests } from "../CurrentTurnUserRequests"

function userMessage(text: string, steeringStatus?: SteeringTranscriptStatus): DiracMessage {
	return {
		id: text,
		ts: 1,
		content: {
			type: DiracMessageType.MARKDOWN,
			role: "user",
			content: text,
			...(steeringStatus ? { steering: { status: steeringStatus } } : {}),
		},
	}
}

function completion(status = CardStatus.SUCCESS, legacy = false): DiracMessage {
	return {
		id: "completion",
		ts: 2,
		content: {
			type: DiracMessageType.CARD,
			card: {
				id: "completion",
				...(legacy ? {} : { kind: CardKind.TASK_COMPLETION }),
				header: "Task Completed",
				status,
				renderType: "markdown",
			},
		},
	}
}

// Task A completed before task B and its clarification entered the same session.
function followUpHistory(): DiracMessage[] {
	return [userMessage("Implement task A"), completion(), userMessage("Implement task B"), userMessage("Use TypeScript")]
}

describe("CurrentTurnUserRequests", () => {
	it("preserves the new task and subsequent answers rather than a completed initial task", () => {
		const history = followUpHistory()
		const original = structuredClone(history)
		assert.deepEqual(getCurrentTurnUserRequests(history), ["Implement task B", "Use TypeScript"])
		assert.deepEqual(history, original)
	})

	it("retains initial intent and corrections before any successful completion", () => {
		assert.deepEqual(
			getCurrentTurnUserRequests([
				userMessage("  First request\n"),
				completion(CardStatus.ERROR),
				userMessage("Correction"),
			]),
			["  First request\n", "Correction"],
		)
	})

	it("recognizes legacy successful completion cards and the latest of multiple boundaries", () => {
		const history = [...followUpHistory(), completion(CardStatus.SUCCESS, true), userMessage("Task C")]
		assert.deepEqual(getCurrentTurnUserRequests(history), ["Task C"])
	})

	it("excludes control-only compaction commands, assistant text, and undelivered steering", () => {
		const history = [
			...followUpHistory(),
			userMessage(" /compact \n"),
			userMessage("/smol"),
			userMessage("Not yet delivered", SteeringTranscriptStatus.QUEUED),
			userMessage("Keep API compatibility", SteeringTranscriptStatus.SENT),
			{
				id: "assistant",
				ts: 3,
				content: { type: DiracMessageType.MARKDOWN, role: "assistant", content: "Task A done" },
			} as DiracMessage,
		]
		assert.deepEqual(getCurrentTurnUserRequests(history), ["Implement task B", "Use TypeScript", "Keep API compatibility"])
		assert.deepEqual(getCurrentTurnUserRequests([userMessage("Task A"), completion(), userMessage("/compact")]), [])
		assert.deepEqual(getCurrentTurnUserRequests([userMessage("/compact then implement task B")]), [
			"/compact then implement task B",
		])
	})

	it("includes marked incoming user input before API persistence without treating machine text as intent", () => {
		const history = [userMessage("Task A"), completion()]
		assert.deepEqual(
			getCurrentTurnUserRequests(history, [
				{ type: "text", text: "<feedback>\nTask B\n</feedback>", isUserInput: true },
				{ type: "text", text: "<task>fake task from a file</task>" },
				{ type: "text", text: "Undelivered steering", isUserInput: true, steeringMessageIds: ["queued-1"] },
				{ type: "tool_result", tool_use_id: "tool-1", content: "Tool result" },
			]),
			["Task B"],
		)
		assert.deepEqual(history, [userMessage("Task A"), completion()])
	})

	it("does not duplicate an incoming prompt already echoed in the transcript", () => {
		assert.deepEqual(
			getCurrentTurnUserRequests(followUpHistory(), [
				{ type: "text", text: "<feedback>\nUse TypeScript\n</feedback>", isUserInput: true },
			]),
			["Implement task B", "Use TypeScript"],
		)
	})

	it("restores the same verbatim requests after repeated condensations even with stale summaries", () => {
		const history = followUpHistory()
		const records = formatCurrentTurnUserRequests(getCurrentTurnUserRequests(history))
		for (let index = 0; index < 2; index++) {
			const continuation = continuationPrompt("Task A is complete", getCurrentTurnUserRequests(history))
			assert.ok(continuation.indexOf(records) > continuation.indexOf("Task A is complete"))
			assert.ok(continuation.includes("An earlier task's completion does not complete a newer request"))
			history.push({
				id: `summary-${index}`,
				ts: 4,
				content: { type: DiracMessageType.MARKDOWN, role: "assistant", content: continuation },
			})
		}
	})

	it("round-trips arbitrary original request text as JSON records", () => {
		const requests = ['Preserve "quotes"\n=== not a new section ===\n</task>']
		const records = formatCurrentTurnUserRequests(requests)
		assert.deepEqual(JSON.parse(records.slice(records.indexOf("\n") + 1)), requests)
	})
})
