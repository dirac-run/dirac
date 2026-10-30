import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "../../../../TaskState"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { CompletionResponseOperation } from "../CompletionResponseOperation"

function makeEnvironment(legacySettings: Record<string, unknown>, subagentsEnabled: boolean) {
	const state = new TaskState()
	const runSubagent = sinon.stub().rejects(new Error("Completion must not launch a verifier"))
	const commitAttemptCompletion = sinon.stub().resolves({ committed: true })
	const createCard = sinon.stub().resolves({ id: "completion", finalize: sinon.stub().resolves() })
	const saveCheckpoint = sinon.stub().resolves()
	const env = {
		config: {
			...legacySettings,
			subagentsEnabled,
			executionProfile: "standalone",
			isSubagentExecution: false,
			autoApprovalSettings: { enableNotifications: false },
			mode: "act",
		},
		orchestration: {
			setTaskState: (key: string, value: unknown) => {
				; (state as unknown as Record<string, unknown>)[key] = value
			},
			commitCompletionResponse: (response: string) => state.commitCompletionResponse(response),
			commitAttemptCompletion,
			runSubagent,
			saveCheckpoint,
			runHook: sinon.stub().resolves(),
		},
		ui: { createCard },
		logging: { warn: sinon.stub() },
		telemetry: { captureCustomMetadata: sinon.stub(), captureTaskCompleted: sinon.stub() },
	} as unknown as IToolEnvironment
	return { env, state, runSubagent, commitAttemptCompletion, createCard, saveCheckpoint }
}

describe("CompletionResponseOperation", () => {
	for (const legacyValue of [undefined, false, true]) {
		for (const subagentsEnabled of [false, true]) {
			it(`accepts the first completion with legacy setting ${legacyValue} and subagents ${subagentsEnabled}`, async () => {
				const settings = legacyValue === undefined ? {} : { doubleCheckCompletionEnabled: legacyValue }
				const { env, state, runSubagent, commitAttemptCompletion, createCard, saveCheckpoint } = makeEnvironment(
					settings,
					subagentsEnabled,
				)

				assert.equal(await new CompletionResponseOperation().execute("Done", env), "Done")
				assert.ok(commitAttemptCompletion.calledOnceWithExactly("Done"))
				assert.ok(runSubagent.notCalled)
				assert.ok(createCard.calledOnce)
				assert.ok(saveCheckpoint.calledOnce)
				assert.equal(state.completionCommitted, true)
				assert.equal(state.didAttemptCompletion, true)
				assert.equal(state.completionResponse, "Done")
				assert.equal(Object.hasOwn(state, "doubleCheckCompletionPending"), false)
				assert.equal(Object.hasOwn(state, "completionVerificationFailure"), false)
			})
		}
	}

	for (const committed of [false, true]) {
		it(`retains the Goal completion decision (${committed ? "accepted" : "rejected"})`, async () => {
			const { env, state, runSubagent, commitAttemptCompletion, createCard } = makeEnvironment(
				{ doubleCheckCompletionEnabled: true },
				true,
			)
			const commitCompletion = sinon.stub().resolves({ committed, error: "Goal verification required" })
			const goalEnv = { ...env, goal: { commitCompletion } as unknown as IToolEnvironment["goal"] }

			const result = await new CompletionResponseOperation().execute("Done", goalEnv)

			assert.equal(result, committed ? "Done" : "Completion rejected: Goal verification required")
			assert.ok(commitCompletion.calledOnceWithExactly("Done"))
			assert.ok(commitAttemptCompletion.notCalled)
			assert.ok(runSubagent.notCalled)
			assert.equal(createCard.called, committed)
			assert.equal(state.completionCommitted, committed)
			assert.equal(state.completionResponse, committed ? "Done" : undefined)
		})
	}
})
