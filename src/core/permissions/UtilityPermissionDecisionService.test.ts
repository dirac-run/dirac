import assert from "node:assert/strict"
import type { ApiStream, ApiStreamChunk } from "@core/api/transform/stream"
import { UtilityModelCancelledError, type UtilityModelRequest } from "@core/utility-model/UtilityModelRunner"
import sinon from "sinon"
import {
    UTILITY_PERMISSION_SYSTEM_PROMPT,
    UtilityPermissionDecisionService,
    type UtilityPermissionRequest,
    type UtilityPermissionRequestRunner,
} from "./UtilityPermissionDecisionService"

const REQUEST: UtilityPermissionRequest = {
	toolCall: {
		name: "write_to_file",
		arguments: { path: "src/index.ts", content: "export {}\n" },
	},
	permission: { header: "Permission Request" },
	runtime: {
		cwd: "/repo",
		mode: "act",
		isSubagent: false,
	},
}

function stream(...chunks: ApiStreamChunk[]): ApiStream {
	return (async function* () {
		for (const chunk of chunks) yield chunk
	})()
}

function stalledStream(): ApiStream {
	return (async function* () {
		await new Promise<void>(() => { })
		yield { type: "text", text: "unreachable" }
	})()
}

function runnerReturning(output: string): {
	runner: UtilityPermissionRequestRunner
	run: sinon.SinonStub<[UtilityModelRequest], ApiStream>
} {
	const run = sinon.stub<[UtilityModelRequest], ApiStream>().returns(stream({ type: "text", text: output }))
	return { runner: { run }, run }
}

describe("UtilityPermissionDecisionService", () => {
	it("sends a cache-stable system prompt, verbatim policy, and separate structured request", async () => {
		const policy = "Allow edits in this repo.\nNever allow network calls."
		const { runner, run } = runnerReturning('{"decision":"approve","reason":"Allowed by the file-edit rule."}')
		const service = new UtilityPermissionDecisionService(runner, policy)

		await service.decide(REQUEST)

		const modelRequest = run.firstCall.args[0]
		assert.equal(modelRequest.systemPrompt, UTILITY_PERMISSION_SYSTEM_PROMPT)
		assert.deepEqual(modelRequest.messages, [
			{ role: "user", content: policy },
			{ role: "user", content: JSON.stringify(REQUEST) },
		])
		assert.equal(JSON.stringify(modelRequest).includes("matched_policy_text"), false)
	})

	for (const decision of ["approve", "escalate"] as const) {
		it(`parses the ${decision} decision`, async () => {
			const { runner } = runnerReturning(JSON.stringify({ decision, reason: `Reason for ${decision}.` }))
			const service = new UtilityPermissionDecisionService(runner, "policy")

			assert.deepEqual(await service.decide(REQUEST), { decision, reason: `Reason for ${decision}.` })
		})
	}

	for (const output of [
		"not json",
		"{}",
		'{"decision":"approve","reason":"ok","matched_policy_text":"Allow edits"}',
		'{"decision":"yes","reason":"legacy outcome"}',
		'{"decision":"escalate","reason":""}',
	]) {
		it(`falls back to escalate for invalid output: ${output}`, async () => {
			const { runner } = runnerReturning(output)
			const onFailure = sinon.spy()
			const service = new UtilityPermissionDecisionService(runner, "policy", onFailure)

			assert.deepEqual(await service.decide(REQUEST), {
				decision: "escalate",
				reason: "The Utility model could not make a reliable permission decision.",
			})
			sinon.assert.calledOnce(onFailure)
		})
	}

	it("escalates without calling the provider when the request is too large", async () => {
		const { runner, run } = runnerReturning('{"decision":"approve","reason":"Allowed."}')
		const onFailure = sinon.spy()
		const service = new UtilityPermissionDecisionService(runner, "policy", onFailure)
		const request = structuredClone(REQUEST)
		request.toolCall.arguments.content = "x".repeat(129 * 1024)

		assert.equal((await service.decide(request)).decision, "escalate")
		sinon.assert.notCalled(run)
		sinon.assert.calledOnce(onFailure)
	})

	it("escalates when provider output exceeds its bound", async () => {
		const { runner } = runnerReturning("x".repeat(9 * 1024))
		const service = new UtilityPermissionDecisionService(runner, "policy")

		assert.equal((await service.decide(REQUEST)).decision, "escalate")
	})

	it("falls back to escalate when the provider fails", async () => {
		const failure = new Error("provider failed")
		const run = sinon.stub<[UtilityModelRequest], ApiStream>().throws(failure)
		const onFailure = sinon.spy()
		const service = new UtilityPermissionDecisionService({ run }, "policy", onFailure)

		assert.equal((await service.decide(REQUEST)).decision, "escalate")
		sinon.assert.calledWithExactly(onFailure, failure)
	})

	it("falls back to escalate when the model returns a tool call", async () => {
		const run = sinon.stub<[UtilityModelRequest], ApiStream>().returns(
			stream({
				type: "tool_calls",
				tool_call: { function: { name: "execute_command", arguments: "{}" } },
			}),
		)
		const service = new UtilityPermissionDecisionService({ run }, "policy")

		assert.equal((await service.decide(REQUEST)).decision, "escalate")
	})

	it("falls back to escalate when the Utility decision times out", async () => {
		const run = sinon.stub<[UtilityModelRequest], ApiStream>().returns(stalledStream())
		const service = new UtilityPermissionDecisionService({ run }, "policy", undefined, 1)

		assert.equal((await service.decide(REQUEST)).decision, "escalate")
	})

	it("propagates parent-task cancellation", async () => {
		const controller = new AbortController()
		controller.abort()
		const run = sinon.stub<[UtilityModelRequest], ApiStream>().returns(stream())
		const service = new UtilityPermissionDecisionService({ run }, "policy")

		await assert.rejects(service.decide(REQUEST, controller.signal), UtilityModelCancelledError)
	})
})
