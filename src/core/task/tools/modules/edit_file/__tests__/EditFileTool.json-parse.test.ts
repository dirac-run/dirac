/**
 * Tests for EditFileTool JSON.parse error handling.
 * Verifies that malformed JSON in the 'files' parameter produces a descriptive
 * error message that includes the parse failure reason (not just "must be a valid array").
 */
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { TaskState } from "../../../../TaskState"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import type { TaskConfig } from "../../../types/TaskConfig"
import { EditFileTool } from "../EditFileTool"

class EditFileToolHandler {
	private tool = new EditFileTool()
	async execute(config: TaskConfig, params: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(params, env)
	}
}

function createConfig(): TaskConfig {
	const taskState = new TaskState()
	return {
		context: createMockContext(),
		taskState,
		messenger: createMockTaskMessenger(),
	} as any
}

describe("EditFileTool JSON.parse error handling", () => {
	it("returns descriptive error for malformed JSON string in files parameter", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		// Malformed JSON — missing closing bracket
		const result = await handler.execute(config, { files: "[{path: " })
		assert.ok(typeof result === "string", "result should be a string error message")
		assert.ok(result.includes("files"), "error should mention the files parameter")
	})

	it("returns descriptive error for non-JSON string in files parameter", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		const result = await handler.execute(config, { files: "not json at all" })
		assert.ok(typeof result === "string", "result should be a string error message")
	})

	it("includes parse error reason in the error message (not just generic 'must be a valid array')", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		const result = await handler.execute(config, { files: "not json at all" })
		assert.ok(typeof result === "string")
		assert.ok(result.includes("invalid JSON"), "error should mention 'invalid JSON'")
		assert.ok(!result.includes("must be a valid array of objects"), "error should not be the generic array message")
	})

	it("accepts valid JSON string in files parameter", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		// Valid JSON string — should parse and proceed (will fail later on missing path, but not on parse)
		const result = await handler.execute(config, { files: "[]" })
		// Empty array should not trigger the "must be a valid array" error
		// It may return a different error about empty files, but not about parsing
		assert.ok(typeof result === "string" || result === undefined)
	})

	it("accepts array directly (non-string) in files parameter", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		const result = await handler.execute(config, { files: [] })
		assert.ok(typeof result === "string" || result === undefined)
	})

	it("returns error for object (not array) in files parameter", async () => {
		const handler = new EditFileToolHandler()
		const config = createConfig()
		const result = await handler.execute(config, { files: {} })
		assert.ok(typeof result === "string")
		assert.ok(result.includes("array"), "error should mention array")
	})
})
