import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracDefaultTool } from "@shared/tools"
import { NewTaskTool } from "../new_task/NewTaskTool"

function createMocks() {
	const card = {
		update: sinon.stub().resolves(),
		appendBody: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({
			action: DiracDefaultTool.NEW_TASK,
			response: "approve",
			value: DiracDefaultTool.NEW_TASK,
		}),
	}
	const state = { consecutiveMistakeCount: 0 }
	const env = {
		ui: {
			createCard: sinon.stub().resolves(card),
			upsertText: sinon.stub().resolves(),
		},
		orchestration: {
			getTaskState: sinon.stub().callsFake((key: keyof typeof state) => state[key]),
			setTaskState: sinon.stub().callsFake((key: keyof typeof state, value: number) => {
				state[key] = value
			}),
			requestTaskReplacement: sinon.stub(),
		},
		config: {
			isSubagentExecution: false,
			autoApprovalSettings: { enableNotifications: false },
			ulid: "ulid-1",
			mode: "act",
			api: { getModel: () => ({ id: "model-1" }) },
			services: {
				stateManager: {
					getApiConfiguration: () => ({ actModeApiProvider: "provider-1", planModeApiProvider: "provider-1" }),
				},
			},
		},
	}

	return { card, env }
}

describe("NewTaskTool", () => {
	afterEach(() => sinon.restore())

	it("creates an expanded completion-sized markdown card with promoted new-task actions", async () => {
		const { card, env } = createMocks()
		const context = "# Current work\n\nContinue from this exact context."

		await new NewTaskTool().processCall({ context }, env as any)

		assert.ok(
			env.ui.createCard.calledWithMatch({
				header: "New Task",
				body: context,
				renderType: "markdown",
				rawInput: { tool: DiracDefaultTool.NEW_TASK },
				collapsed: false,
				maxHeight: 1200,
				do_not_auto_collapse: true,
				actions: [{ label: "Approve New Task", value: DiracDefaultTool.NEW_TASK, primary: true }],
			}),
		)
		assert.ok(card.waitForInteraction.calledOnce)
		assert.ok(card.finalize.calledWith("success"))
		assert.ok(env.orchestration.requestTaskReplacement.calledOnceWithExactly(context, undefined, undefined))
	})

	it("treats composer content as feedback instead of replacing the task", async () => {
		const { card, env } = createMocks()
		card.waitForInteraction.resolves({
			action: DiracDefaultTool.NEW_TASK,
			response: "approve",
			value: DiracDefaultTool.NEW_TASK,
			text: "Change the plan",
			images: ["image-1"],
		})

		await new NewTaskTool().processCall({ context: "Generated context" }, env as any)

		assert.ok(card.finalize.calledWith("cancelled"))
		assert.ok(env.ui.upsertText.calledWith("Change the plan", false, "user"))
		assert.equal(env.orchestration.requestTaskReplacement.called, false)
	})

})
