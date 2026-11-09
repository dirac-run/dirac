import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { requestQuestionResponse } from "../QuestionResponseOperation"
import { RESPOND_TOOL_NAME, ResponseOperation } from "@shared/responseTool"

function createEnvironment(
	interaction: {
		response: DiracAskResponse
		text?: string
		value?: string
		images?: string[]
		files?: string[]
	},
	config: { enableNotifications?: boolean; yoloModeToggled?: boolean; executionProfile?: "standalone" | "tasklet" } = {},
) {
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
			autoApprovalSettings: { enableNotifications: config.enableNotifications ?? false },
			yoloModeToggled: config.yoloModeToggled ?? false,
			executionProfile: config.executionProfile ?? "standalone",
			mode: "act",
			ulid: "test-task",
			providerId: "anthropic",
			model: { id: "test-model", info: {} },
			services: {},
		},
		telemetry: {
			captureCustomMetadata: sinon.stub(),
			captureOptionSelected: sinon.stub(),
			captureOptionsIgnored: sinon.stub(),
			captureToolUsage: sinon.stub(),
		},
		system: { showNotification: sinon.stub() },
		workspace: { formatAttachedFiles: sinon.stub().resolves("attached files") },
	}
	return { env: env as any, card }
}

describe("question response operation", () => {
	it("uses accepted free text as the answer", async () => {
		const { env, card } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			text: "custom answer",
		})
		const result = await requestQuestionResponse("Choose", ["Option A", "Option B"], env)

		assert.match(String(result), /<answer>\ncustom answer\n<\/answer>/)
		assert.ok(card.finalize.calledWith(CardStatus.SUCCESS))
		assert.ok(env.ui.upsertText.calledOnceWith("custom answer", false, "user"))
	})

	it("uses the selected option when no text was supplied", async () => {
		const { env, card } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			value: "Option A",
		})
		const result = await requestQuestionResponse("Choose", ["Option A", "Option B"], env)

		assert.match(String(result), /<answer>\nOption A\n<\/answer>/)
		assert.ok(card.finalize.calledWith(CardStatus.SUCCESS))
		assert.ok(env.ui.upsertText.calledOnceWith("Option A", false, "user"))
		sinon.assert.callOrder(card.finalize, env.ui.upsertText)
		assert.ok(
			card.update.calledWithMatch({
				header: "Answered",
				rawOutput: { answer: "Option A", selectedChoice: "Option A" },
				requireFeedback: false,
				actions: [],
			}),
		)
	})

	it("prefers the clicked choice when the message input also contains text", async () => {
		const { env } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			text: "specific detail",
			value: "Option A",
		})
		const result = await requestQuestionResponse("Choose", ["Option A", "Option B"], env)

		assert.match(String(result), /<answer>\nOption A\n<\/answer>/)
		assert.ok(env.ui.upsertText.calledOnceWith("Option A", false, "user"))
	})

	it("finalizes decline as skipped instead of success", async () => {
		const { env, card } = createEnvironment({ response: DiracAskResponse.REJECT })
		const result = await requestQuestionResponse("Choose", [], env)

		assert.match(String(result), /declined/i)
		assert.ok(card.finalize.calledOnceWith(CardStatus.SKIPPED))
		assert.ok(card.update.calledWithMatch({ outcome: "declined" }))
		assert.ok(env.ui.upsertText.notCalled)
		assert.ok(env.telemetry.captureCustomMetadata.calledOnceWithExactly({ answerType: "declined" }))
	})

	it("emits semantic card metadata, notification, attachment, and telemetry effects", async () => {
		const { env } = createEnvironment(
			{
				response: DiracAskResponse.APPROVE,
				value: "Option B",
				images: ["data:image/png;base64,AA=="],
				files: ["file.txt"],
			},
			{ enableNotifications: true },
		)

		await requestQuestionResponse("Choose", ["Option A", "Option B"], env)

		assert.ok(
			env.ui.createCard.calledWithMatch({
				rawInput: {
					tool: RESPOND_TOOL_NAME,
					operation: ResponseOperation.QUESTION,
					text: "Choose",
					options: ["Option A", "Option B"],
				},
			}),
		)
		assert.ok(env.system.showNotification.calledOnce)
		assert.ok(env.workspace.formatAttachedFiles.calledOnceWithExactly(["file.txt"]))
		assert.ok(env.telemetry.captureOptionSelected.calledOnceWithExactly(2, "act"))
		assert.ok(env.telemetry.captureToolUsage.notCalled)
		assert.ok(env.telemetry.captureCustomMetadata.calledWithExactly({ answerType: "choice" }))
	})

	it("attributes a child's accepted answer to Dirac without emitting a user-authored message", async () => {
		const { env, card } = createEnvironment(
			{ response: DiracAskResponse.APPROVE, value: "Option A", images: ["data:image/png;base64,AA=="], files: ["file.txt"] },
			{ executionProfile: "tasklet", enableNotifications: true, yoloModeToggled: true },
		)
		const result = await requestQuestionResponse("Choose", ["Option A", "Option B"], env)

		assert.match(JSON.stringify(result), /Dirac answered:/)
		assert.ok(card.update.calledWithMatch({ body: "Choose\n\n---\n\n**Dirac's answer:** Option A" }))
		assert.ok(card.finalize.calledOnceWith(CardStatus.SUCCESS))
		sinon.assert.notCalled(env.ui.upsertText)
		sinon.assert.notCalled(env.system.showNotification)
		assert.ok(env.workspace.formatAttachedFiles.calledOnceWithExactly(["file.txt"]))
	})

	it("attributes a child's declined question to Dirac", async () => {
		const { env, card } = createEnvironment(
			{ response: DiracAskResponse.REJECT }, { executionProfile: "tasklet" },
		)
		const result = await requestQuestionResponse("Choose", [], env)

		assert.match(String(result), /Dirac declined to answer/)
		assert.doesNotMatch(String(result), /user/i)
		assert.ok(card.update.calledWithMatch({ body: "Choose\n\n*Dirac declined to answer.*" }))
		assert.ok(card.finalize.calledOnceWith(CardStatus.SKIPPED))
		sinon.assert.notCalled(env.ui.upsertText)
	})

	it("returns attachment-only answers without inventing text", async () => {
		const { env } = createEnvironment({
			response: DiracAskResponse.APPROVE,
			images: ["data:image/png;base64,AA=="],
			files: ["file.txt"],
		})

		const result = await requestQuestionResponse("Attach the evidence", [], env)

		const serializedResult = JSON.stringify(result)
		assert.doesNotMatch(serializedResult, /undefined/)
		assert.match(serializedResult, /<answer>\\n\\n<\/answer>/)
		assert.ok(env.workspace.formatAttachedFiles.calledOnceWithExactly(["file.txt"]))
	})

	it("returns the autonomous-mode instruction without creating an interaction card", async () => {
		const { env } = createEnvironment(
			{ response: DiracAskResponse.APPROVE },
			{ yoloModeToggled: true },
		)

		const result = await requestQuestionResponse("Where is it?", [], env)

		assert.match(String(result), /User input is not available/)
		assert.ok(env.ui.createCard.notCalled)
		assert.ok(env.telemetry.captureCustomMetadata.calledOnceWithExactly({ answerType: "unavailable" }))
	})
})
