import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { GetFileSkeletonTool } from "../index"
import { createMockContext } from "../../../__tests__/helpers/mockTaskConfig"

function createEnv(includeAnchors?: boolean) {
	const context = createMockContext()
	return {
		config: { isSubagentExecution: true },
		context,
		workspace: {
			resolvePath: sinon.stub().resolves({ absolutePath: "/tmp/example.ts", displayPath: "example.ts" }),
		},
		ast: {
			getSkeleton: sinon
				.stub()
				.callsFake(async (_absolutePath: string, opts?: { showCallGraph?: boolean; includeAnchors?: boolean }) => {
					if (opts?.includeAnchors) {
						return "Anchor§function target() {\nBody§    return 1\nClose§}"
					}
					return "function target() {\n    return 1\n}"
				}),
		},
		orchestration: {
			getTaskState: sinon.stub().returns(0),
			setTaskState: sinon.stub(),
		},
	} as any
}

describe("GetFileSkeletonTool include_anchors visibility", () => {
	it("defaults to plain output (no anchor prefixes)", async () => {
		const tool = new GetFileSkeletonTool()
		const env = createEnv()

		const result = await tool.processCall({ paths: ["example.ts"] }, env)

		assert.ok(result.includes("function target() {"))
		assert.ok(!result.includes("Anchor§function target() {"))
		assert.ok(!result.includes("Stable Anchors are provided"))
	})

	it("returns anchored output when include_anchors=true", async () => {
		const tool = new GetFileSkeletonTool()
		const env = createEnv()

		const result = await tool.processCall({ paths: ["example.ts"], include_anchors: true }, env)

		assert.ok(result.includes("Stable Anchors are provided with each line."))
		assert.ok(result.includes("Anchor§function target() {"))
		assert.ok(result.includes("Body§    return 1"))
	})

	it("passes includeAnchors flag to ast.getSkeleton", async () => {
		const tool = new GetFileSkeletonTool()
		const env = createEnv()

		await tool.processCall({ paths: ["example.ts"] }, env)
		sinon.assert.calledWith(env.ast.getSkeleton, "/tmp/example.ts", { showCallGraph: true, includeAnchors: false })

		await tool.processCall({ paths: ["example.ts"], include_anchors: true }, env)
		sinon.assert.calledWith(env.ast.getSkeleton, "/tmp/example.ts", { showCallGraph: true, includeAnchors: true })
	})
})
