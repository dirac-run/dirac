import { strict as assert } from "node:assert"
import { CardKind, CardStatus } from "@shared/ExtensionMessage"
import { RESPOND_TOOL_NAME, ResponseOperation } from "@shared/responseTool"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CompletionResponseOperation } from "../CompletionResponseOperation"

describe("completion response operation steering arbitration", () => {
	it("skips every completion-only side effect when steering supersedes completion", async () => {
		const createCard = sinon.stub()
		const saveCheckpoint = sinon.stub()
		const runHook = sinon.stub()
		const commitAttemptCompletion = sinon.stub().resolves({ committed: false, error: "steered" })
		const state = {
			consecutiveMistakeCount: 0,
			doubleCheckCompletionPending: false,
		}
		const env = {
			config: {
				executionProfile: "standalone",
				doubleCheckCompletionEnabled: false,
				isSubagentExecution: false,
				autoApprovalSettings: { enableNotifications: false },
			},
			ui: { createCard },
			orchestration: {
				getTaskState: (key: keyof typeof state) => state[key],
				setTaskState: (key: keyof typeof state, value: number | boolean) => {
					state[key] = value as never
				},
				commitCompletionResponse: (response: string) => {
					;(state as Record<string, unknown>).completionResponse = response
				},
				commitAttemptCompletion,
				saveCheckpoint,
				runHook,
			},
		} as any

		const result = await new CompletionResponseOperation().execute("Done", env)

		assert.equal(result, "Completion rejected: steered")
		assert.equal(commitAttemptCompletion.calledOnce, true)
		assert.equal(createCard.notCalled, true)
		assert.equal(saveCheckpoint.notCalled, true)
		assert.equal(runHook.notCalled, true)
	})
	it("keeps completion committed when presentation fails after arbitration", async () => {
		const state = {
			consecutiveMistakeCount: 0,
			doubleCheckCompletionPending: false,
			completionCommitted: false,
			didAttemptCompletion: false,
		}
		const env = {
			config: {
				executionProfile: "standalone",
				doubleCheckCompletionEnabled: false,
				isSubagentExecution: false,
				autoApprovalSettings: { enableNotifications: false },
			},
			ui: { createCard: sinon.stub().rejects(new Error("card failed")) },
			logging: { warn: sinon.stub() },
			telemetry: { captureCustomMetadata: sinon.stub() },
			orchestration: {
				getTaskState: (key: keyof typeof state) => state[key],
				setTaskState: (key: keyof typeof state, value: number | boolean) => {
					state[key] = value as never
				},
				commitAttemptCompletion: sinon.stub().callsFake(async () => {
					state.completionCommitted = true
					state.didAttemptCompletion = true
					return { committed: true }
				}),
				commitCompletionResponse: (response: string) => {
					;(state as Record<string, unknown>).completionResponse = response
				},
				runHook: sinon.stub(),
			},
		} as any

		assert.equal(await new CompletionResponseOperation().execute("Done", env), "Done")
		assert.equal((env.orchestration.commitAttemptCompletion as sinon.SinonStub).calledOnce, true)
	})

	it("commits one completion card, checkpoint, hook, notification, and telemetry lifecycle", async () => {
		const card = { id: "completion-card", finalize: sinon.stub().resolves() }
		const createCard = sinon.stub().resolves(card)
		const runHook = sinon.stub().resolves({})
		const saveCheckpoint = sinon.stub().resolves()
		const showNotification = sinon.stub()
		const captureTaskCompleted = sinon.stub()
		const captureCustomMetadata = sinon.stub()
		const state = { doubleCheckCompletionPending: false }
		const env = {
			config: {
				executionProfile: "standalone",
				doubleCheckCompletionEnabled: false,
				isSubagentExecution: false,
				autoApprovalSettings: { enableNotifications: true },
				taskId: "task",
				ulid: "ulid",
				mode: "act",
			},
			ui: { createCard },
			system: { showNotification },
			logging: { warn: sinon.stub() },
			telemetry: { captureTaskCompleted, captureCustomMetadata },
			orchestration: {
				getTaskState: (key: keyof typeof state) => state[key],
				setTaskState: (key: keyof typeof state, value: boolean) => (state[key] = value),
				commitCompletionResponse: (response: string) => {
					;(state as Record<string, unknown>).completionResponse = response
				},
				commitAttemptCompletion: sinon.stub().resolves({ committed: true }),
				saveCheckpoint,
				runHook,
			},
		} as any

		await new CompletionResponseOperation().execute("Done", env)

		assert.ok(createCard.calledOnce)
		assert.ok(
			createCard.calledWithMatch({
				kind: CardKind.TASK_COMPLETION,
				rawInput: { tool: RESPOND_TOOL_NAME, operation: ResponseOperation.COMPLETE, text: "Done" },
			}),
		)
		assert.ok(card.finalize.calledOnceWithExactly(CardStatus.SUCCESS, true))
		assert.ok(saveCheckpoint.calledOnceWithExactly(true, "completion-card"))
		assert.equal(runHook.callCount, 2)
		assert.equal(runHook.firstCall.args[0], "TaskComplete")
		assert.equal(runHook.secondCall.args[0], "Notification")
		assert.ok(showNotification.calledOnce)
		assert.ok(captureTaskCompleted.calledOnce)
		assert.ok(captureCustomMetadata.calledWith({ operation: ResponseOperation.COMPLETE, mode: "act" }))
	})
})
