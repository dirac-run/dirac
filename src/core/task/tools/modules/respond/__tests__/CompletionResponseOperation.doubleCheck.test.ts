import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DiracMessageType, SubagentExecutionStatus, type DiracMessage } from "@shared/ExtensionMessage"
import { TaskState } from "../../../../TaskState"
import { CompletionResponseOperation } from "../CompletionResponseOperation"

function markdown(content: string, role: "user" | "assistant"): DiracMessage {
	return {
		id: `${role}-${content}`,
		ts: 1,
		content: { type: DiracMessageType.MARKDOWN, content, role },
	}
}

function taskFromPrompt(prompt: string): string {
	const match = /<initial_task>\n([\s\S]*?)\n<\/initial_task>/.exec(prompt)
	assert.ok(match)
	return match[1]
}

function makeEnvironment(options: {
	subagentsEnabled?: boolean
	initialTask?: string
	history?: DiracMessage[]
	workspaceFingerprint?: sinon.SinonStub
	runSubagent?: sinon.SinonStub
}) {
	const state = new TaskState()
	state.initialTask = options.initialTask
	const history = options.history ?? []
	const runSubagent =
		options.runSubagent ??
		sinon.stub().resolves({
			status: SubagentExecutionStatus.COMPLETED,
			result: "VERIFICATION: FAILED\nThe candidate is incomplete.",
		})
	const fingerprintWorkspace = options.workspaceFingerprint ?? sinon.stub().resolves("workspace-fingerprint")
	const commitAttemptCompletion = sinon.stub().resolves({ committed: true })
	const env = {
		config: {
			doubleCheckCompletionEnabled: true,
			subagentsEnabled: options.subagentsEnabled ?? true,
			isSubagentExecution: true,
			executionProfile: "goal_child",
			mode: "act",
			autoApprovalSettings: { enableNotifications: false },
			taskState: {},
		},
		orchestration: {
			getTaskState: (key: keyof TaskState) => state[key],
			setTaskState: (key: keyof TaskState, value: TaskState[keyof TaskState]) => {
				;(state as any)[key] = value
			},
			getHistory: () => history,
			runSubagent,
			commitAttemptCompletion,
		},
		workspace: { fingerprintWorkspace },
		logging: { warn: sinon.stub() },
		telemetry: { captureCustomMetadata: sinon.stub() },
	} as any
	return { env, state, runSubagent, fingerprintWorkspace, commitAttemptCompletion }
}

describe("CompletionResponseOperation double-check completion", () => {
	it("includes raw CLI task Markdown in the subagent verifier prompt", async () => {
		const { env, runSubagent } = makeEnvironment({
			history: [markdown("Build the requested SATB score.", "user")],
		})

		await new CompletionResponseOperation().execute("Done", env)

		assert.equal(taskFromPrompt(runSubagent.firstCall.args[0]), "Build the requested SATB score.")
	})

	it("supports task-wrapped canonical input", async () => {
		const { env, runSubagent } = makeEnvironment({ initialTask: "<task>\nRecover the cipher.\n</task>" })

		await new CompletionResponseOperation().execute("Done", env)

		assert.equal(taskFromPrompt(runSubagent.firstCall.args[0]), "Recover the cipher.")
	})

	it("does not mistake later user feedback for the initial task", async () => {
		const { env, runSubagent } = makeEnvironment({
			history: [
				markdown("Implement the solver.", "user"),
				markdown("Working on it.", "assistant"),
				markdown("Also change the acceptance threshold.", "user"),
			],
		})

		await new CompletionResponseOperation().execute("Done", env)

		const prompt = runSubagent.firstCall.args[0]
		assert.equal(taskFromPrompt(prompt), "Implement the solver.")
		assert.equal(prompt.includes("Also change the acceptance threshold."), false)
	})

	it("truncates long tasks identically in same-agent verification", async () => {
		const { env, runSubagent } = makeEnvironment({
			subagentsEnabled: false,
			initialTask: "x".repeat(8_001),
		})

		const response = await new CompletionResponseOperation().execute("Done", env)

		assert.equal(taskFromPrompt(response), `${"x".repeat(8_000)}\n...[truncated]`)
		assert.equal(runSubagent.called, false)
	})

	it("fails closed when initial-task context is unavailable", async () => {
		const { env, state, runSubagent, commitAttemptCompletion } = makeEnvironment({
			history: [markdown("Assistant output", "assistant")],
		})

		const response = await new CompletionResponseOperation().execute("Done", env)

		assert.match(response, /initial task context is unavailable/)
		assert.equal(runSubagent.called, false)
		assert.equal(commitAttemptCompletion.called, false)
		assert.equal(state.doubleCheckCompletionPending, false)
	})

	it("uses the same initial-task extraction for same-agent and subagent verification", async () => {
		const history = [markdown("<task>\nUse the real fixture.\n</task>", "user")]
		const sameAgent = makeEnvironment({ subagentsEnabled: false, history })
		const subagent = makeEnvironment({ history })

		const sameAgentPrompt = await new CompletionResponseOperation().execute("Done", sameAgent.env)
		await new CompletionResponseOperation().execute("Done", subagent.env)

		assert.equal(taskFromPrompt(sameAgentPrompt), taskFromPrompt(subagent.runSubagent.firstCall.args[0]))
	})

	it("does not sample another verifier for an unchanged failed candidate", async () => {
		const { env, state, runSubagent, fingerprintWorkspace } = makeEnvironment({ initialTask: "Do the task." })
		const operation = new CompletionResponseOperation()

		await operation.execute("Done", env)
		const retryResponse = await operation.execute("Done", env)

		assert.equal(runSubagent.callCount, 1)
		assert.equal(fingerprintWorkspace.callCount, 2)
		assert.match(retryResponse, /workspace artifacts are unchanged/)
		assert.equal(state.completionVerificationFailure?.reports.length, 1)
	})

	it("re-verifies a changed candidate and preserves prior verifier failures", async () => {
		const runSubagent = sinon.stub()
		runSubagent.onFirstCall().resolves({
			status: SubagentExecutionStatus.COMPLETED,
			result: "VERIFICATION: FAILED\nThreshold was not tested.",
		})
		runSubagent.onSecondCall().resolves({
			status: SubagentExecutionStatus.COMPLETED,
			result: "VERIFICATION: FAILED\nOutput format is still wrong.",
		})
		const fingerprintWorkspace = sinon.stub()
		fingerprintWorkspace.onFirstCall().resolves("workspace-before")
		fingerprintWorkspace.onSecondCall().resolves("workspace-after")
		fingerprintWorkspace.onThirdCall().resolves("workspace-after")
		const { env, state } = makeEnvironment({
			initialTask: "Meet the numerical threshold.",
			runSubagent,
			workspaceFingerprint: fingerprintWorkspace,
		})
		const operation = new CompletionResponseOperation()

		await operation.execute("Done", env)
		await operation.execute("Done", env)

		assert.equal(runSubagent.callCount, 2)
		assert.match(runSubagent.secondCall.args[0], /Threshold was not tested/)
		assert.match(runSubagent.secondCall.args[0], /Explicitly verify that every prior failure has been addressed/)
		assert.deepEqual(state.completionVerificationFailure?.reports, [
			"VERIFICATION: FAILED\nThreshold was not tested.",
			"VERIFICATION: FAILED\nOutput format is still wrong.",
		])
	})

	it("blocks retries when a rejected candidate cannot be fingerprinted", async () => {
		const fingerprintWorkspace = sinon.stub().rejects(new Error("unreadable workspace"))
		const { env, state, runSubagent } = makeEnvironment({
			initialTask: "Do the task.",
			workspaceFingerprint: fingerprintWorkspace,
		})
		const operation = new CompletionResponseOperation()

		const firstResponse = await operation.execute("Done", env)
		const retryResponse = await operation.execute("Done", env)

		assert.match(firstResponse, /further verification is blocked/)
		assert.match(retryResponse, /remains failed/)
		assert.equal(runSubagent.callCount, 1)
		assert.equal(state.completionVerificationFailure?.candidateFingerprint, undefined)
	})
})
