import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { WriteToFileTool } from "./WriteToFileTool"

describe("WriteToFileTool: text typed on the waiting card", () => {
	it("rethrows ToolSkippedByUserMessage so the coordinator skips the cards and forwards the text", async () => {
		const skip = new ToolSkippedByUserMessage("use the other heading")
		const permissionCard = { requiresUserInteraction: true, waitForInteraction: sinon.stub().rejects(skip) }
		const writingCard = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
		const createCard = sinon.stub()
		createCard.onFirstCall().resolves(writingCard)
		createCard.onSecondCall().resolves(permissionCard)
		const hideReview = sinon.stub().resolves()
		const env = {
			config: {
				isSubagentExecution: false,
				permissionDecisionBinding: undefined,
				taskState: { consecutiveMistakeCount: 0 },
				callbacks: { shouldAutoApproveToolWithPath: sinon.stub().resolves(false) },
				model: { id: "m", info: {} },
				providerId: "p",
			},
			orchestration: { setTaskState: sinon.stub() },
			ui: { createCard, upsertText: sinon.stub().resolves() },
			editor: { showReview: sinon.stub().resolves(), scrollToFirstDiff: sinon.stub().resolves(), hideReview },
		}
		const tool = new WriteToFileTool() as any
		sinon.stub(tool, "validateAndResolve").resolves({
			absolutePath: "/workspace/notes.md",
			displayPath: "notes.md",
			fileExists: true,
			originalContent: "old",
		})
		sinon.stub(tool, "preprocessContent").returns("new")

		await assert.rejects(tool.processCall({ path: "notes.md", content: "new" }, env), (error) => error === skip)
		sinon.assert.notCalled(writingCard.finalize)
		sinon.assert.calledOnce(hideReview)
	})
})
