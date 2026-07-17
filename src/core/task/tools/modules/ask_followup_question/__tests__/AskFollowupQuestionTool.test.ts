import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AskFollowupQuestionTool } from "../AskFollowupQuestionTool"

function createEnvironment(interaction: {
	response: DiracAskResponse
	text?: string
	value?: string
}) {
	const card = {
		update: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves(interaction),
	}
	const env = {
		ui: {
			createCard: sinon.stub().resolves(card),
			upsertText: sinon.stub().resolves(),
		},
		orchestration: {
			getTaskState: sinon.stub().returns(0),
			setTaskState: sinon.stub(),
			getHistory: sinon.stub().returns([]),
			updateMessage: sinon.stub().resolves(),
		},
		config: {
			isSubagentExecution: true,
			autoApprovalSettings: { enableNotifications: false },
			yoloModeToggled: false,
			mode: "act",
			ulid: "test-task",
			api: { getModel: sinon.stub().returns({ id: "test-model" }) },
			services: {
				stateManager: {
					getApiConfiguration: sinon.stub().returns({ actModeApiProvider: "anthropic" }),
				},
			},
		},
	}
	return { env: env as any, card }
}

describe("AskFollowupQuestionTool", () => {
	it("uses accepted free text as the answer", async () => {
		const { env, card } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			text: "custom answer",
		})
		const result = await new AskFollowupQuestionTool().processCall(
			{ question: "Choose", options: '["Option A"]' },
			env,
		)

		assert.match(String(result), /<answer>\ncustom answer\n<\/answer>/)
		assert.ok(card.finalize.calledWith(CardStatus.SUCCESS))
	})

	it("uses the selected option when no text was supplied", async () => {
		const { env, card } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			value: "Option A",
		})
		const result = await new AskFollowupQuestionTool().processCall(
			{ question: "Choose", options: '["Option A"]' },
			env,
		)

		assert.match(String(result), /<answer>\nOption A\n<\/answer>/)
		assert.ok(card.finalize.calledWith(CardStatus.SUCCESS))
	})

	it("prefers explicit text when both text and an option are supplied", async () => {
		const { env } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			text: "specific detail",
			value: "Option A",
		})
		const result = await new AskFollowupQuestionTool().processCall(
			{ question: "Choose", options: '["Option A"]' },
			env,
		)

		assert.match(String(result), /<answer>\nspecific detail\n<\/answer>/)
	})

	it("finalizes decline as skipped instead of success", async () => {
		const { env, card } = createEnvironment({ response: DiracAskResponse.REJECT })
		const result = await new AskFollowupQuestionTool().processCall(
			{ question: "Choose", options: "[]" },
			env,
		)

		assert.match(String(result), /declined/i)
		assert.ok(card.finalize.calledOnceWith(CardStatus.SKIPPED))
		assert.ok(card.update.calledWithMatch({ outcome: "declined" }))
	})

})
