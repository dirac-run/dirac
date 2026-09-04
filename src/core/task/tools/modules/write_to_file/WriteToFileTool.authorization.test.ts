import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { WriteToFileTool } from "./WriteToFileTool"

describe("WriteToFileTool mutation authorization", () => {
	it("revalidates auto-approved writes before entering any editor write boundary", async () => {
		const assertMutationAuthorized = sinon.stub().throws(new Error("Plan Mode revoked mutation"))
		const editor = {
			open: sinon.stub().resolves(),
			update: sinon.stub().resolves(),
			saveChanges: sinon.stub().resolves({ content: "saved" }),
			applyAndSaveSilently: sinon.stub().resolves({ content: "saved" }),
		}
		const env = {
			config: {
				backgroundEditEnabled: false,
				callbacks: { assertMutationAuthorized },
				model: { id: "request-model", info: {} },
				providerId: "anthropic",
				ulid: "task-ulid",
			},
			editor,
		} as any
		const tool = new WriteToFileTool()

		await assert.rejects(
			(tool as any).awaitApprovalThenWriteFile(
				env,
				"/workspace/file.ts",
				"file.ts",
				"new content",
				false,
				"",
				"auto_approve",
				false,
			),
			/Plan Mode revoked mutation/,
		)

		sinon.assert.calledOnceWithExactly(assertMutationAuthorized, "write_to_file")
		sinon.assert.notCalled(editor.open)
		sinon.assert.notCalled(editor.update)
		sinon.assert.notCalled(editor.saveChanges)
		sinon.assert.notCalled(editor.applyAndSaveSilently)
	})
})
