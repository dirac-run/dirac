import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { GetFunctionTool } from "../GetFunctionTool"
import { createMockContext } from "../../../__tests__/helpers/mockTaskConfig"

function createEnv() {
	const context = createMockContext()
	return {
		config: { isSubagentExecution: true },
		context,
		workspace: {
			resolvePath: sinon.stub().resolves({ absolutePath: "/tmp/example.ts", displayPath: "example.ts" }),
		},
		ast: {
			getFunctions: sinon
				.stub()
				.callsFake(
					async (_absolutePath: string, relPath: string, _functionNames: string[], includeAnchors?: boolean) => ({
						formattedContent: includeAnchors
							? `${relPath}::target\n[Function Hash: abc123ef]\nAnchor§function target() {\nBody§    return 1\nClose§}`
							: `${relPath}::target\n[Function Hash: abc123ef]\nfunction target() {\n    return 1\n}`,
						foundNames: ["target"],
					}),
				),
		},
		orchestration: {
			getTaskState: sinon.stub().returns(0),
			setTaskState: sinon.stub(),
		},
		telemetry: {
			captureCustomMetadata: sinon.stub(),
		},
		ui: {
			upsertText: sinon.stub().resolves(),
		},
	} as any
}

describe("GetFunctionTool include_anchors visibility and cache", () => {
	it("keeps plain and anchored cache entries separate", async () => {
		const tool = new GetFunctionTool()
		const env = createEnv()

		const plainResult = (await tool.processCall({ paths: ["example.ts"], function_names: ["target"] }, env)) as string
		assert.ok(plainResult.includes("function target()"))
		assert.ok(!plainResult.includes("Anchor§function target()"))

		const anchoredResult = (await tool.processCall(
			{ paths: ["example.ts"], function_names: ["target"], include_anchors: true },
			env,
		)) as string
		assert.ok(anchoredResult.includes("Anchor§function target()"))
		assert.ok(anchoredResult.includes("Body§    return 1"))

		const repeatedAnchoredResult = (await tool.processCall(
			{ paths: ["example.ts"], function_names: ["target"], include_anchors: true },
			env,
		)) as string
		assert.ok(repeatedAnchoredResult.includes("no changes have been made to the function since your last read"))
	})
})
