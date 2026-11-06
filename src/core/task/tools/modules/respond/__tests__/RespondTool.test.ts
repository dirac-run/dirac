import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ResponseOperation } from "@shared/responseTool"
import { CompletionResponseOperation } from "../CompletionResponseOperation"
import { RespondTool } from "../RespondTool"
import { ResponseArgumentsError } from "../ResponseArgumentsValidator"

function environment(mode: "plan" | "act") {
	let consecutiveMistakeCount = 0
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	return {
		config: {
			mode,
			yoloModeToggled: true,
			autoApprovalSettings: { enableNotifications: false },
		},
		ui: { upsertText: sinon.stub().resolves(), createCard: sinon.stub().resolves(card) },
		telemetry: { captureCustomMetadata: sinon.stub() },
		responseObserver: { recordResponse: sinon.stub().resolves() },
		orchestration: {
			getTaskState: () => consecutiveMistakeCount,
			setTaskState: (_key: string, value: number) => {
				consecutiveMistakeCount = value
			},
			switchToActMode: sinon.stub().resolves(true),
		},
		card,
	} as any
}

describe("respond tool dispatch", () => {
	afterEach(() => sinon.restore())

	it("dispatches every validated operation to its distinct lifecycle", async () => {
		const completion = sinon.stub(CompletionResponseOperation.prototype, "execute").resolves("completed")
		const tool = new RespondTool()
		const act = environment("act")
		const plan = environment("plan")

		await tool.processCall({ operation: ResponseOperation.PROGRESS, text: "Working" }, act)
		assert.ok(act.ui.upsertText.calledWithExactly("Working", false, "assistant"))

		await tool.processCall({ operation: ResponseOperation.QUESTION, text: "Which one?" }, act)
		assert.match(act.ui.upsertText.lastCall.args[0], /Auto-responding to question/)

		await tool.processCall({ operation: ResponseOperation.PLAN, text: "The plan" }, plan)
		assert.ok(plan.ui.createCard.calledOnce)
		assert.ok(plan.orchestration.switchToActMode.calledOnce)
		assert.ok(plan.card.finalize.calledOnce)

		assert.equal(await tool.processCall({ operation: ResponseOperation.COMPLETE, text: "Done" }, act), "completed")
		assert.ok(completion.calledOnceWithExactly("Done", act))

		assert.ok(
			act.telemetry.captureCustomMetadata.calledWithExactly({
				operation: ResponseOperation.PROGRESS,
				textLength: 7,
				mode: "act",
			}),
		)
		assert.ok(
			act.telemetry.captureCustomMetadata.calledWithExactly({
				operation: ResponseOperation.QUESTION,
				textLength: 10,
				mode: "act",
				optionCount: 0,
			}),
		)
		assert.ok(
			plan.telemetry.captureCustomMetadata.calledWithExactly({
				operation: ResponseOperation.PLAN,
				textLength: 8,
				mode: "plan",
			}),
		)
		assert.ok(
			act.telemetry.captureCustomMetadata.calledWithExactly({
				operation: ResponseOperation.COMPLETE,
				textLength: 4,
				mode: "act",
			}),
		)
	})

	it("does not publish a completion attempt rejected by queued-input or lifecycle guards", async () => {
		const act = environment("act")
		const completion = sinon
			.stub(CompletionResponseOperation.prototype, "execute")
			.resolves("New guidance must be read before completing")
		const tool = new RespondTool()
		assert.match(await tool.processCall({ operation: ResponseOperation.COMPLETE, text: "Obsolete result" }, act), /guidance/)
		sinon.assert.calledOnce(completion)
		sinon.assert.notCalled(act.responseObserver.recordResponse)
	})

	it("propagates invalid arguments so the coordinator records a failed invocation", async () => {
		const tool = new RespondTool()
		const act = environment("act")

		await assert.rejects(
			tool.processCall({ operation: ResponseOperation.PLAN, text: "Wrong mode" }, act),
			ResponseArgumentsError,
		)
	})
})
