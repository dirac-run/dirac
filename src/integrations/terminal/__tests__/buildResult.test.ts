import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { type BuildResultInput, buildResult } from "../buildResult"

describe("buildResult", () => {
	const baseInput = {
		userRejected: false,
		result: "",
		completed: false,
		outputLines: [],
	} as BuildResultInput

	it("returns cancelled result when userRejected and no feedback", () => {
		const input = { ...baseInput, userRejected: true, result: "some output" }
		const result = buildResult(input)

		assert.ok(result.userRejected)
		assert.equal(result.completed, false)
		assert.ok((result.result as string).toLowerCase().includes("cancelled"))
		assert.ok((result.result as string).includes("some output"))
	})

	it("returns cancelled result with no output", () => {
		const input = { ...baseInput, userRejected: true, result: "" }
		const result = buildResult(input)

		assert.ok(result.userRejected)
		assert.ok((result.result as string).toLowerCase().includes("cancelled"))
	})

	it("returns feedback result with user feedback text", () => {
		const input = {
			...baseInput,
			userRejected: true,
			result: "partial output",
			completed: false,
			userFeedbackText: "keep going but slow down",
		}
		const result = buildResult(input)

		assert.ok(result.userRejected)
		assert.equal(result.completed, false)
		assert.ok((result.result as string).includes("still running"))
		assert.ok((result.result as string).includes("feedback"))
		assert.ok((result.result as string).includes("keep going but slow down"))
	})

	it("returns success result when completed with exit code 0", () => {
		const input = { ...baseInput, completed: true, exitCode: 0, result: "success output" }
		const result = buildResult(input)

		assert.equal(result.userRejected, false)
		assert.ok(result.completed)
		assert.ok((result.result as string).includes("successfully"))
		assert.ok((result.result as string).includes("exit code 0"))
		assert.ok((result.result as string).includes("success output"))
	})

	it("returns failure result when completed with non-zero exit code", () => {
		const input = { ...baseInput, completed: true, exitCode: 1, result: "error output" }
		const result = buildResult(input)

		assert.equal(result.userRejected, false)
		assert.ok(result.completed)
		assert.ok((result.result as string).includes("failed with exit code 1"))
	})

	it("returns signal termination result when completed with signal", () => {
		const input = { ...baseInput, completed: true, exitCode: undefined, signal: "SIGKILL" as NodeJS.Signals }
		const result = buildResult(input)

		assert.equal(result.userRejected, false)
		assert.ok(result.completed)
		assert.ok((result.result as string).includes("terminated by signal SIGKILL"))
	})

	it("returns running status when not completed", () => {
		const input = { ...baseInput, completed: false, result: "partial" }
		const result = buildResult(input)

		assert.equal(result.userRejected, false)
		assert.equal(result.completed, false)
		assert.ok((result.result as string).includes("still running"))
	})

	it("includes log file path in result", () => {
		const input = { ...baseInput, completed: true, exitCode: 0, logFilePath: "/tmp/output.txt" }
		const result = buildResult(input)

		assert.ok((result.result as string).includes("Full output saved to: /tmp/output.txt"))
	})

	it("includes partial output in running status", () => {
		const input = { ...baseInput, completed: false, result: "some lines here" }
		const result = buildResult(input)

		assert.ok((result.result as string).includes("Here's the output so far"))
		assert.ok((result.result as string).includes("some lines here"))
	})
})
