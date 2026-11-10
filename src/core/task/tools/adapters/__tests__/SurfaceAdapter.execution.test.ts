import assert from "node:assert/strict"
import { describe, it, afterEach } from "mocha"
import sinon from "sinon"
import { setHostCapabilities } from "@/hosts/host-capabilities"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockTaskConfig } from "../../__tests__/helpers/mockTaskConfig"
import type { ToolExecutionScopeContext } from "../../interfaces/ToolExecutionScope"
import { createToolExecutionScope } from "../../runtime/createToolExecutionScope"
import { SurfaceAdapter } from "../SurfaceAdapter"

function execution(executionId: string) {
	const abort = new AbortController()
	const scope: ToolExecutionScopeContext = {
		identity: {
			executionId,
			owner: { rootTaskId: "root", taskId: "root", runId: "run" },
			requestId: "request",
			nativeToolCallId: executionId,
			toolName: "test",
			toolSnapshot: { requestId: "request", inventoryVersion: 1 },
		},
		signal: abort.signal,
		appendOutput: sinon.stub().resolves(),
		waiting: sinon.stub().resolves(),
		resume: sinon.stub().resolves(),
	}
	return { scope, leased: createToolExecutionScope(scope), abort }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

function fixture() {
	setHostCapabilities({})
	const { config } = createMockTaskConfig()
	config.yoloModeToggled = false
	const first = execution("first")
	const second = execution("second")
	const firstConfig = { ...config, execution: first.leased, invocationEffects: { consecutiveMistakeCount: 3 } }
	const secondConfig = { ...config, execution: second.leased, invocationEffects: { consecutiveMistakeCount: 3 } }
	return {
		config, first, second,
		firstAdapter: new SurfaceAdapter(firstConfig),
		secondAdapter: new SurfaceAdapter(secondConfig),
	}
}

describe("SurfaceAdapter execution scope", () => {
	afterEach(() => {
		sinon.restore()
		setHostCapabilities(undefined)
	})

	it("projects invocation identity/output without forking task context or anchor state", async () => {
		const h = fixture()
		assert.equal(h.firstAdapter.execution, h.first.leased)
		assert.equal(h.secondAdapter.execution, h.second.leased)
		await h.firstAdapter.execution!.appendOutput("first output")
		sinon.assert.calledOnceWithExactly(h.first.scope.appendOutput as sinon.SinonStub, "first output")
		sinon.assert.notCalled(h.second.scope.appendOutput as sinon.SinonStub)
		assert.equal(h.firstAdapter.context, h.config.context)
		assert.equal(h.secondAdapter.context, h.config.context)
		await Promise.all([
			h.firstAdapter.context.task.updateEntries("overlap", { first: "a" }),
			h.secondAdapter.context.task.updateEntries("overlap", { second: "b" }),
		])
		await Promise.all([h.firstAdapter.context.save(), h.secondAdapter.context.save()])
		assert.deepEqual(await h.config.context.task.get("overlap"), { first: "a", second: "b" })
		h.firstAdapter.anchors.reconcile("/workspace/execution-scope.ts", ["shared"])
		assert.equal(
			h.firstAdapter.anchors.getDocumentFingerprint("/workspace/execution-scope.ts"),
			h.secondAdapter.anchors.getDocumentFingerprint("/workspace/execution-scope.ts"),
		)
	})

	it("isolates overlapping invocation mistake changes from siblings and task state", () => {
		const h = fixture()
		const initial = h.config.taskState.consecutiveMistakeCount
		h.firstAdapter.orchestration.setTaskState("consecutiveMistakeCount", 4)
		h.secondAdapter.orchestration.setTaskState("consecutiveMistakeCount", 0)
		assert.equal(h.firstAdapter.orchestration.getTaskState("consecutiveMistakeCount"), 4)
		assert.equal(h.secondAdapter.orchestration.getTaskState("consecutiveMistakeCount"), 0)
		assert.equal(h.config.taskState.consecutiveMistakeCount, initial)
	})

	it("combines task and invocation cancellation without cancelling sibling invocations", () => {
		const h = fixture()
		const firstSignal = h.firstAdapter.orchestration.getTaskState("abortSignal")
		const secondSignal = h.secondAdapter.orchestration.getTaskState("abortSignal")
		h.first.abort.abort(new Error("first cancelled"))
		assert.equal(firstSignal.aborted, true)
		assert.equal(secondSignal.aborted, false)
		assert.equal(h.config.taskState.abortSignal.aborted, false)
		const taskAbort = new AbortController()
		const adapter = new SurfaceAdapter({
			...h.config,
			execution: h.second.leased,
			taskState: Object.create(h.config.taskState, { abortSignal: { value: taskAbort.signal } }),
		})
		taskAbort.abort()
		assert.equal(adapter.orchestration.getTaskState("abortSignal").aborted, true)
	})

	for (const ownerRouted of [false, true]) {
		it(`reports isolated permission/input waits and resumes (${ownerRouted ? "owner-routed" : "displayed"})`, async () => {
			const h = fixture()
			Object.defineProperty(h.config.taskMessenger, "routesToOwner", { value: ownerRouted })
			const permission = await h.firstAdapter.ui.createCard({ header: "Permission", requireApproval: true })
			const input = await h.secondAdapter.ui.createManualInteractionCard({ header: "Input", requireFeedback: true })
			const permissionResult = deferred<{ response: DiracAskResponse }>()
			const inputResult = deferred<{ response: DiracAskResponse }>()
			const createCard = h.config.taskMessenger.createCard as sinon.SinonStub
			const permissionProtocol = await createCard.firstCall.returnValue
			const inputProtocol = await createCard.secondCall.returnValue
			permissionProtocol.waitForInteraction.returns(permissionResult.promise)
			inputProtocol.waitForInteraction.returns(inputResult.promise)
			const firstWait = permission.waitForInteraction()
			const secondWait = input.waitForInteraction()
			await new Promise<void>((resolve) => setImmediate(resolve))
			sinon.assert.calledOnceWithExactly(h.first.scope.waiting as sinon.SinonStub, { kind: "waiting_permission", permissionRequestId: permission.id })
			sinon.assert.calledOnceWithExactly(h.second.scope.waiting as sinon.SinonStub, { kind: "waiting_input", inputRequestId: input.id })
			inputResult.resolve({ response: DiracAskResponse.MESSAGE })
			await secondWait
			sinon.assert.notCalled(h.first.scope.resume as sinon.SinonStub)
			sinon.assert.calledOnce(h.second.scope.resume as sinon.SinonStub)
			permissionResult.resolve({ response: DiracAskResponse.APPROVE })
			await firstWait
			sinon.assert.calledOnce(h.first.scope.resume as sinon.SinonStub)
			assert.equal(createCard.firstCall.args[0].executionId, "first")
			assert.equal(createCard.secondCall.args[0].executionId, "second")
		})
	}

	for (const cancel of ["execution", "caller"] as const) {
		it(`forwards ${cancel} cancellation and releases its wait lease`, async () => {
			const h = fixture()
			const card = await h.firstAdapter.ui.createCard({ header: "Permission", requireApproval: true })
			const protocol = await (h.config.taskMessenger.createCard as sinon.SinonStub).firstCall.returnValue
			const entered = deferred<void>()
			protocol.waitForInteraction.callsFake(async (signal: AbortSignal) => {
				entered.resolve()
				await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
			})
			const caller = new AbortController()
			const pending = card.waitForInteraction(caller.signal)
			await entered.promise
			const reason = new Error(`${cancel} cancellation`)
			if (cancel === "execution") h.first.abort.abort(reason)
			else caller.abort(reason)
			await assert.rejects(pending, (error) => error === reason)
			if (cancel === "execution") sinon.assert.notCalled(h.first.scope.resume as sinon.SinonStub)
			else sinon.assert.calledOnce(h.first.scope.resume as sinon.SinonStub)
			assert.equal(h.second.scope.signal.aborted, false)
		})
	}

	it("does not resume when cancellation races with a successful protocol response", async () => {
		const h = fixture()
		const card = await h.firstAdapter.ui.createCard({ header: "Input", requireFeedback: true })
		const protocol = await (h.config.taskMessenger.createCard as sinon.SinonStub).firstCall.returnValue
		protocol.waitForInteraction.callsFake(async () => {
			h.first.abort.abort()
			return { response: DiracAskResponse.MESSAGE }
		})
		await assert.rejects(card.waitForInteraction(), /abort/i)
		sinon.assert.notCalled(h.first.scope.resume as sinon.SinonStub)
	})

	it("bypasses owner wait transitions for automatically approved cards", async () => {
		const h = fixture()
		h.firstAdapter.config.yoloModeToggled = true
		const card = await h.firstAdapter.ui.createCard({ header: "Permission", requireApproval: true, status: CardStatus.WAITING_FOR_INPUT })
		assert.equal((await card.waitForInteraction()).response, DiracAskResponse.APPROVE)
		sinon.assert.notCalled(h.first.scope.waiting as sinon.SinonStub)
		sinon.assert.notCalled(h.first.scope.resume as sinon.SinonStub)
	})
	it("binds tool-owned lifecycle hooks to the execution signal and pinned model", async () => {
		const h = fixture()
		const executeHook = sinon.stub(require("@core/hooks/hook-executor"), "executeHook").resolves({})
		await h.firstAdapter.orchestration.runHook("TaskComplete", {}, { isCancellable: true })
		const options = executeHook.firstCall.args[0]
		assert.equal(options.model.provider, h.firstAdapter.config.providerId)
		assert.equal(options.model.slug, h.firstAdapter.config.model.id || "unknown")
		h.first.abort.abort()
		assert.equal(options.signal.aborted, true)
		assert.equal(h.config.taskState.abortSignal.aborted, false)
	})
	for (const rejectFirst of [false, true]) {
		it(`releases overlapping same-execution card leases without prematurely resuming (${rejectFirst ? "rejected" : "answered"})`, async () => {
			const h = fixture()
			const first = await h.firstAdapter.ui.createCard({ header: "Permission", requireApproval: true })
			const second = await h.firstAdapter.ui.createCard({ header: "Input", requireFeedback: true })
			const createCard = h.config.taskMessenger.createCard as sinon.SinonStub
			const firstProtocol = await createCard.firstCall.returnValue
			const secondProtocol = await createCard.secondCall.returnValue
			let reject!: (reason: Error) => void
			const failure = new Error("interaction failed")
			const firstResult = deferred<{ response: DiracAskResponse }>()
			firstProtocol.waitForInteraction.returns(rejectFirst
				? new Promise((_resolve, rejectWait) => { reject = rejectWait })
				: firstResult.promise)
			const secondResult = deferred<{ response: DiracAskResponse }>()
			secondProtocol.waitForInteraction.returns(secondResult.promise)
			const firstWait = first.waitForInteraction()
			const secondWait = second.waitForInteraction()
			await new Promise<void>((resolve) => setImmediate(resolve))
			sinon.assert.calledOnce(h.first.scope.waiting as sinon.SinonStub)
			if (rejectFirst) {
				reject(failure)
				await assert.rejects(firstWait, (error) => error === failure)
			} else {
				firstResult.resolve({ response: DiracAskResponse.APPROVE })
				await firstWait
			}
			sinon.assert.notCalled(h.first.scope.resume as sinon.SinonStub)
			secondResult.resolve({ response: DiracAskResponse.MESSAGE })
			await secondWait
			sinon.assert.calledOnce(h.first.scope.resume as sinon.SinonStub)
		})
	}
	it("preserves both interaction and owner-resume failures", async () => {
		const h = fixture()
		const card = await h.firstAdapter.ui.createCard({ header: "Input", requireFeedback: true })
		const protocol = await (h.config.taskMessenger.createCard as sinon.SinonStub).firstCall.returnValue
		const interactionError = new Error("interaction failed")
		const releaseError = new Error("resume persistence failed")
		protocol.waitForInteraction.rejects(interactionError)
			; (h.first.scope.resume as sinon.SinonStub).rejects(releaseError)
		await assert.rejects(card.waitForInteraction(), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [interactionError, releaseError])
			return true
		})
	})

	it("passes origin metadata to cards and uses scoped messenger facades for text and hooks", async () => {
		const h = fixture()
		const messengerContext = {
			executionId: h.first.scope.identity.executionId,
			signal: h.first.scope.signal,
			hooksEnabled: true,
			hookModel: { provider: "anthropic", slug: "origin-model" },
		}
		const facade = { upsertText: sinon.stub().resolves(), streamText: sinon.stub().resolves({}) }
		const forInvocation = sinon.stub().returns(facade)
		Object.assign(h.config.taskMessenger, { forInvocation })
		Object.assign(h.firstAdapter.config, { messengerContext })
		const adapter = new SurfaceAdapter(h.firstAdapter.config)
		await adapter.ui.upsertText("origin output")
		await adapter.ui.streamText("markdown")
		sinon.assert.calledOnce(facade.upsertText)
		sinon.assert.calledOnce(facade.streamText)
		sinon.assert.notCalled(h.config.taskMessenger.upsertText as sinon.SinonStub)
		sinon.assert.notCalled(h.config.taskMessenger.streamText as sinon.SinonStub)
		await adapter.ui.createCard({ header: "Origin card" })
		await adapter.ui.createManualInteractionCard({ header: "Origin input", requireFeedback: true })
		const createCard = h.config.taskMessenger.createCard as sinon.SinonStub
		assert.equal(createCard.firstCall.args[1], messengerContext)
		assert.equal(createCard.secondCall.args[1], messengerContext)
		const executeHook = sinon.stub(require("@core/hooks/hook-executor"), "executeHook").resolves({})
		await adapter.orchestration.runHook("TaskComplete", {})
		assert.equal(executeHook.firstCall.args[0].messenger, facade)
		sinon.assert.alwaysCalledWithExactly(forInvocation, messengerContext)
	})
})
