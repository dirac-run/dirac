import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ToolExecutionScopeContext } from "../interfaces/ToolExecutionScope"
import { createToolExecutionScope } from "./createToolExecutionScope"

function fixture() {
	const abort = new AbortController()
	const context: ToolExecutionScopeContext = {
		identity: {
			executionId: "execution", owner: { rootTaskId: "root", taskId: "task", runId: "run" },
			requestId: "request", nativeToolCallId: "call", toolName: "test",
			toolSnapshot: { requestId: "request", inventoryVersion: 1 },
		},
		signal: abort.signal,
		appendOutput: sinon.stub().resolves(),
		waiting: sinon.stub().resolves(),
		resume: sinon.stub().resolves(),
	}
	return { context, abort, scope: createToolExecutionScope(context) }
}

const permission = { kind: "waiting_permission", permissionRequestId: "permission" } as const
const input = { kind: "waiting_input", inputRequestId: "input" } as const

describe("createToolExecutionScope wait leases", () => {
	for (const reverse of [false, true]) {
		it(`keeps one owner wait until both overlapping leases release (${reverse ? "reverse" : "forward"})`, async () => {
			const h = fixture()
			const leases = await Promise.all([h.scope.beginWait(permission), h.scope.beginWait(input)])
			sinon.assert.calledOnceWithExactly(h.context.waiting as sinon.SinonStub, permission)
			if (reverse) leases.reverse()
			await leases[0].release()
			sinon.assert.notCalled(h.context.resume as sinon.SinonStub)
			if (reverse) sinon.assert.calledOnce(h.context.waiting as sinon.SinonStub)
			else sinon.assert.calledWithExactly(h.context.waiting as sinon.SinonStub, input)
			await leases[1].release()
			sinon.assert.calledOnce(h.context.resume as sinon.SinonStub)
			await Promise.all(leases.map((lease) => lease.release()))
			sinon.assert.calledOnce(h.context.resume as sinon.SinonStub)
		})
	}

	it("serializes a new wait arriving during the final owner resume", async () => {
		const h = fixture()
		let resumed!: () => void
		const resume = new Promise<void>((done) => { resumed = done })
			; (h.context.resume as sinon.SinonStub).returns(resume)
		const first = await h.scope.beginWait(permission)
		const release = first.release()
		const second = h.scope.beginWait(input)
		await new Promise<void>((resolve) => setImmediate(resolve))
		sinon.assert.calledOnce(h.context.waiting as sinon.SinonStub)
		resumed()
		await release
		const lease = await second
		sinon.assert.calledTwice(h.context.waiting as sinon.SinonStub)
		await lease.release()
		sinon.assert.calledTwice(h.context.resume as sinon.SinonStub)
	})

	it("retains no lease after a failed owner wait transition", async () => {
		const h = fixture()
		const failure = new Error("wait persistence failed")
			; (h.context.waiting as sinon.SinonStub).onFirstCall().rejects(failure)
		await assert.rejects(h.scope.beginWait(permission), (error) => error === failure)
		const lease = await h.scope.beginWait(input)
		sinon.assert.calledTwice(h.context.waiting as sinon.SinonStub)
		await lease.release()
		sinon.assert.calledOnce(h.context.resume as sinon.SinonStub)
	})

	it("retains the final lease for a failed owner resume retry", async () => {
		const h = fixture()
		const failure = new Error("resume persistence failed")
			; (h.context.resume as sinon.SinonStub).onFirstCall().rejects(failure)
		const lease = await h.scope.beginWait(permission)
		await assert.rejects(lease.release(), (error) => error === failure)
		await lease.release()
		sinon.assert.calledTwice(h.context.resume as sinon.SinonStub)
	})

	it("never resumes the owner after execution cancellation", async () => {
		const h = fixture()
		const leases = await Promise.all([h.scope.beginWait(permission), h.scope.beginWait(input)])
		h.abort.abort()
		await Promise.all(leases.map((lease) => lease.release()))
		sinon.assert.notCalled(h.context.resume as sinon.SinonStub)
		await assert.rejects(h.scope.beginWait(permission), /abort/i)
	})
})
