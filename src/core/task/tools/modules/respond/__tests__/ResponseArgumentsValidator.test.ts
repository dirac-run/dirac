import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { LegacyResponseParameter, ResponseOperation } from "@shared/responseTool"
import { validateResponseArguments } from "../ResponseArgumentsValidator"

function environment(mode: "plan" | "act" = "act") {
	let consecutiveMistakeCount = 0
	return {
		config: { mode },
		orchestration: {
			getTaskState: () => consecutiveMistakeCount,
			setTaskState: (_key: string, value: number) => {
				consecutiveMistakeCount = value
			},
		},
	} as any
}

describe("response arguments validator", () => {
	it("accepts every operation and normalizes nullable options", () => {
		assert.deepEqual(validateResponseArguments({ operation: ResponseOperation.PROGRESS, text: "Update" }, environment()), {
			operation: ResponseOperation.PROGRESS,
			text: "Update",
		})
		assert.deepEqual(
			validateResponseArguments(
				{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A", "B"] },
				environment(),
			),
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A", "B"] },
		)
		assert.deepEqual(validateResponseArguments({ operation: ResponseOperation.PLAN, text: "Plan" }, environment("plan")), {
			operation: ResponseOperation.PLAN,
			text: "Plan",
		})
		assert.deepEqual(validateResponseArguments({ operation: ResponseOperation.COMPLETE, text: "Done" }, environment()), {
			operation: ResponseOperation.COMPLETE,
			text: "Done",
		})
		assert.equal(
			validateResponseArguments({ operation: ResponseOperation.QUESTION, text: "Choose", options: null }, environment())
				.options,
			undefined,
		)
	})

	it("rejects malformed common fields", () => {
		for (const args of [
			undefined,
			{},
			{ operation: "unknown", text: "Text" },
			{ operation: "progress", text: "  " },
			{ operation: ResponseOperation.COMPLETE, text: "Done", result: "legacy" },
			{ operation: ResponseOperation.COMPLETE, text: "Done", [LegacyResponseParameter.NEEDS_MORE_EXPLORATION]: true },
		]) {
			assert.throws(() => validateResponseArguments(args, environment()))
		}
	})

	it("rejects branch-invalid and malformed options", () => {
		const invalid = [
			{ operation: ResponseOperation.PROGRESS, text: "Update", options: ["A", "B"] },
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A"] },
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A", "B", "C", "D", "E", "F"] },
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A", "A"] },
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["A", " "] },
			{ operation: ResponseOperation.QUESTION, text: "Choose", options: ["Continue", "Switch to Act Mode"] },
		]
		for (const args of invalid) assert.throws(() => validateResponseArguments(args, environment()))
	})

	it("enforces Plan and Act response modes", () => {
		assert.throws(() => validateResponseArguments({ operation: ResponseOperation.PLAN, text: "Plan" }, environment("act")))
		assert.throws(() =>
			validateResponseArguments({ operation: ResponseOperation.COMPLETE, text: "Done" }, environment("plan")),
		)
	})
})
