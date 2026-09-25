import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolSkippedByUserMessage } from "../../../types/ToolSkippedByUserMessage"
import { EditFileTool } from "../EditFileTool"

describe("EditFileTool: text typed on the waiting card", () => {
	it("rethrows ToolSkippedByUserMessage unwrapped, after hiding the review", async () => {
		const skip = new ToolSkippedByUserMessage("leave the intro alone")
		const card = { id: "c1", update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
		const hideReview = sinon.stub().resolves()
		const env = {
			context: { ensureAnchorState: sinon.stub().resolves() },
			editor: { hideReview },
		}
		const tool = new EditFileTool() as any
		sinon.stub(tool.validator, "validateFiles").returns([{ path: "notes.md", edits: [] }])
		sinon.stub(tool.batchPreparer, "prepare").callsFake(async (_files: unknown, _env: unknown, cards: any) => {
			cards["/workspace/notes.md"] = card
			return { preparedBatches: [{}], results: [], totalRequestedEdits: 1, totalResolvedEdits: 1, totalFailedEdits: 0 }
		})
		sinon.stub(tool.approvalFlow, "handle").rejects(skip)

		await assert.rejects(tool.processCall({ files: [] }, env), (error) => error === skip)
		sinon.assert.notCalled(card.finalize)
		sinon.assert.calledOnce(hideReview)
	})
})
