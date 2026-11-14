import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardHeader, isTaskCompletionCard } from "./cardIdentity"
import { CardKind } from "./ExtensionMessage"
import {
	isCompletionResponseCall,
	isPlanResponseCard,
	isQuestionResponseCard,
	LegacyResponseTool,
	RESPOND_TOOL_NAME,
	ResponseCardHeader,
	ResponseOperation,
	responseCardInput,
	responseOperationFromCard,
	responseOperationFromToolCall,
} from "./responseTool"

describe("live response tool identity", () => {
	it("classifies only current respond calls", () => {
		for (const operation of Object.values(ResponseOperation)) {
			const call = { name: RESPOND_TOOL_NAME, params: { operation, text: "Current response" } }
			assert.equal(responseOperationFromToolCall(call), operation)
			assert.equal(isCompletionResponseCall(call), operation === ResponseOperation.COMPLETE)
		}
	})

	it("does not classify retired tool names even with current response arguments", () => {
		for (const name of Object.values(LegacyResponseTool)) {
			const call = { name, params: { operation: ResponseOperation.COMPLETE, text: "Not a response tool" } }
			assert.equal(responseOperationFromToolCall(call), undefined)
			assert.equal(isCompletionResponseCall(call), false)
		}
	})

	it("does not classify unknown operations or unrelated tools", () => {
		assert.equal(responseOperationFromToolCall({ name: RESPOND_TOOL_NAME, params: { operation: "unknown" } }), undefined)
		assert.equal(
			responseOperationFromToolCall({ name: "custom_tool", params: { operation: ResponseOperation.PLAN } }),
			undefined,
		)
	})
})

describe("response card identity", () => {
	it("classifies current response cards from semantic metadata", () => {
		const question = {
			header: "Localized question title",
			toolName: RESPOND_TOOL_NAME,
			rawInput: responseCardInput(ResponseOperation.QUESTION, "Choose", ["A", "B"]),
		} as any
		const plan = {
			header: "Localized plan title",
			toolName: RESPOND_TOOL_NAME,
			rawInput: responseCardInput(ResponseOperation.PLAN, "Plan"),
		} as any

		assert.equal(isQuestionResponseCard(question), true)
		assert.equal(isPlanResponseCard(question), false)
		assert.equal(isPlanResponseCard(plan), true)
		assert.equal(isQuestionResponseCard(plan), false)
	})

	it("does not classify unrelated cards by display text", () => {
		const card = {
			header: ResponseCardHeader.QUESTION,
			toolName: "unrelated_tool",
			rawInput: { tool: "unrelated_tool", operation: ResponseOperation.QUESTION },
		} as any

		assert.equal(isQuestionResponseCard(card), false)
	})

	it("recognizes retired tool names only as read-only historical card metadata", () => {
		const historicalOperations = [
			[LegacyResponseTool.PROGRESS, ResponseOperation.PROGRESS],
			[LegacyResponseTool.COMPLETE, ResponseOperation.COMPLETE],
			[LegacyResponseTool.PLAN, ResponseOperation.PLAN],
			[LegacyResponseTool.QUESTION, ResponseOperation.QUESTION],
		] as const
		for (const [name, operation] of historicalOperations) {
			for (const card of [{ toolName: name }, { rawInput: { tool: name } }]) {
				const original = structuredClone(card)
				assert.equal(responseOperationFromCard(card as any), operation)
				assert.equal(isPlanResponseCard(card as any), operation === ResponseOperation.PLAN)
				assert.equal(isQuestionResponseCard(card as any), operation === ResponseOperation.QUESTION)
				assert.deepEqual(card, original)
			}
		}
	})

	it("keeps historical plan cards readable", () => {
		const card = { header: ResponseCardHeader.PROPOSED_PLAN } as any
		assert.equal(isPlanResponseCard(card), true)
	})

	it("keeps current and historical completion cards readable", () => {
		assert.equal(isTaskCompletionCard({ kind: CardKind.TASK_COMPLETION, header: "Localized" } as any), true)
		assert.equal(isTaskCompletionCard({ header: CardHeader.TASK_COMPLETED } as any), true)
		assert.equal(isTaskCompletionCard({ header: CardHeader.LEGACY_TASK_COMPLETION } as any), true)
	})
})
