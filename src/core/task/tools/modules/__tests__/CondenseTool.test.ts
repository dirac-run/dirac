import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { CondenseTool } from "../condense/CondenseTool"

function createMocks(source: "automatic" | "user" = "automatic") {
	const card = {
		update: sinon.stub().resolves(),
		appendBody: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
	}
	const state: Record<string, unknown> = {
		consecutiveMistakeCount: 0,
		pendingCondenseSource: source === "automatic" ? "automatic" : undefined,
		lastAutoCondenseTriggerIndex: 4,
	}
	const env = {
		ui: { createCard: sinon.stub().resolves(card) },
		orchestration: {
			getTaskState: sinon.stub().callsFake((key: string) => state[key]),
			setTaskState: sinon.stub().callsFake((key: string, value: unknown) => {
				state[key] = value
			}),
			getNextTruncationRange: sinon.stub().returns([1, 6]),
			setTruncationRange: sinon.stub(),
			resetTransientState: sinon.stub().resolves(),
			runHook: sinon.stub().resolves({}),
		},
		config: {
			isSubagentExecution: false,
			autoApprovalSettings: { enableNotifications: false },
			ulid: "ulid-1",
			mode: "act",
			api: { getModel: () => ({ id: "model-1" }) },
			taskState: state,
			messageState: {
				getDiracMessages: sinon.stub().returns([]),
				saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
			},
			services: {
				stateManager: {
					getApiConfiguration: () => ({ actModeApiProvider: "provider-1", planModeApiProvider: "provider-1" }),
				},
				contextManager: {
					getContextTelemetryData: sinon.stub().returns({ tokensUsed: 750, maxContextWindow: 1000 }),
				},
			},
		},
	}
	return { card, env, state }
}

describe("CondenseTool", () => {
	afterEach(() => sinon.restore())

	it("automatically condenses without waiting for user approval", async () => {
		const { card, env, state } = createMocks("automatic")

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(card.waitForInteraction.callCount, 0)
		assert.deepEqual(env.orchestration.setTruncationRange.firstCall.args[0], [1, 6])
		assert.equal(state.skipNextAutoCondenseCheck, true)
		assert.match(result, /Please continue the conversation/)
	})

	it("runs the hook before applying an approved user condense", async () => {
		const { card, env } = createMocks("user")

		await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(card.waitForInteraction.callCount, 1)
		assert.ok(env.orchestration.runHook.calledBefore(env.orchestration.setTruncationRange))
		assert.ok(card.finalize.calledWith("success"))
	})

	it("does not compact when the user rejects the summary", async () => {
		const { card, env } = createMocks("user")
		card.waitForInteraction.resolves({ action: DiracAskResponse.REJECT, text: "include the latest changes" })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(env.orchestration.runHook.callCount, 0)
		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.match(result, /include the latest changes/)
	})

	it("does not mutate truncation state when the hook cancels", async () => {
		const { env } = createMocks("automatic")
		env.orchestration.runHook.resolves({ cancel: true })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.match(result, /cancelled by PreCompact hook/)
	})

	it("includes hook context modifications in the continuation", async () => {
		const { env } = createMocks("automatic")
		env.orchestration.runHook.resolves({ contextModification: "retain deployment constraints" })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.match(result, /retain deployment constraints/)
	})
})
