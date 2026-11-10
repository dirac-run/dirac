import assert from "node:assert/strict"
import sinon from "sinon"
import pWaitFor from "p-wait-for"
import { HookFactory } from "@core/hooks/hook-factory"
import { executeHook } from "@core/hooks/hook-executor"
import { HookExecutionError } from "@core/hooks/HookError"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { HookManager } from "../HookManager"
import { TaskState } from "../TaskState"
import type { HookExecution } from "../types/HookExecution"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => { resolve = settle })
	return { promise, resolve }
}

describe("HookManager cancellation", () => {
	afterEach(() => sinon.restore())

	function createManager() {
		const taskState = new TaskState()
		const manager = new HookManager({
			taskState,
			withStateLock: async (operation: () => unknown) => operation(),
			messageStateHandler: { findMessageIndexById: () => -1 },
			taskMessenger: { upsertText: sinon.stub().resolves() },
		} as any)
		return { manager, taskState }
	}

	function execution(messageId: string, completion = Promise.resolve()): HookExecution {
		return { runId: messageId, hookName: "TaskStart", messageId, abortController: new AbortController(), completion }
	}

	it("tracks concurrent hooks and clears only the requested run", async () => {
		const { manager, taskState } = createManager()
		const first = execution("first")
		const second = execution("second")
		await Promise.all([manager.setActiveHookExecution(first), manager.setActiveHookExecution(second)])

		assert.equal(await manager.getActiveHookExecution("first"), first)
		assert.equal(await manager.getActiveHookExecution("second"), second)
		await manager.clearActiveHookExecution("first")
		await manager.clearActiveHookExecution("first")

		assert.equal(taskState.activeHookExecutions.size, 1)
		assert.equal(await manager.getActiveHookExecution("first"), undefined)
		assert.equal(await manager.getActiveHookExecution("second"), second)
		assert.equal(second.abortController.signal.aborted, false)
	})

	it("cancels only the requested hook, leaving its sibling running", async () => {
		const { manager } = createManager()
		const first = execution("first")
		const second = execution("second")
		await manager.setActiveHookExecution(first)
		await manager.setActiveHookExecution(second)

		assert.equal(await manager.cancelHookExecution("first"), true)
		assert.equal(first.abortController.signal.aborted, true)
		assert.equal(second.abortController.signal.aborted, false)
		assert.equal(await manager.getActiveHookExecution("second"), second)
		assert.equal(await manager.cancelHookExecution("missing"), false)
	})

	it("signals every hook before waiting for all cleanup to finish", async () => {
		const { manager } = createManager()
		const firstCleanup = deferred<void>()
		const secondCleanup = deferred<void>()
		const first = execution("first", firstCleanup.promise)
		const second = execution("second", secondCleanup.promise)
		await manager.setActiveHookExecution(first)
		await manager.setActiveHookExecution(second)
		let settled = false
		const cancellation = manager.cancelAllHookExecutions().then(() => { settled = true })
		await pWaitFor(() => first.abortController.signal.aborted && second.abortController.signal.aborted, { interval: 1 })
		assert.equal(settled, false)

		await manager.clearActiveHookExecution("first")
		firstCleanup.resolve()
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(settled, false)
		await manager.clearActiveHookExecution("second")
		secondCleanup.resolve()
		await cancellation
		assert.equal(settled, true)
	})

	it("aborts late registrations while retaining ownership until cleanup", async () => {
		const { manager, taskState } = createManager()
		taskState.abort = true
		const late = execution("late")

		await manager.setActiveHookExecution(late)

		assert.equal(late.abortController.signal.aborted, true)
		assert.equal(await manager.getActiveHookExecution("late"), late)
		await manager.clearActiveHookExecution("late")
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	it("owns TaskCancel during abort and still joins explicit cancellation and cleanup", async () => {
		const { manager, taskState } = createManager()
		taskState.abort = true
		const cleanup = deferred<void>()
		const cancel = { ...execution("cancel", cleanup.promise), hookName: "TaskCancel" }
		await manager.setActiveHookExecution(cancel)
		assert.equal(cancel.abortController.signal.aborted, false)
		let settled = false
		const pending = manager.cancelAllHookExecutions().then(() => { settled = true })
		await pWaitFor(() => cancel.abortController.signal.aborted, { interval: 1 })
		assert.equal(settled, false)
		await manager.clearActiveHookExecution(cancel.runId)
		cleanup.resolve()
		await pending
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	function stubFactory() {
		sinon.stub(HookFactory.prototype, "hasHook").resolves(true)
		sinon.stub(HookFactory.prototype, "getHookInfo").resolves({ scriptPaths: ["TaskStart"] })
		return sinon.stub(HookFactory.prototype, "createWithStreaming")
	}

	function options(manager: HookManager, messageId: string) {
		return {
			hookName: "TaskStart" as const,
			hookInput: { taskStart: { taskMetadata: { taskId: "task", ulid: "ulid", initialTask: "task" } } },
			isCancellable: true,
			messenger: { createCard: async () => ({ id: messageId }) } as any,
			setActiveHookExecution: manager.setActiveHookExecution.bind(manager),
			clearActiveHookExecution: manager.clearActiveHookExecution.bind(manager),
			messageStateHandler: { findMessageIndexById: () => -1 } as any,
			taskId: "task",
			hooksEnabled: true,
		}
	}

	it("joins cancellation of a TaskStart runner whose card is still being created", async () => {
		const { manager, taskState } = createManager()
		const factory = stubFactory()
		const card = deferred<{ id: string }>()
		const createCard = sinon.stub().returns(card.promise)
		factory.resolves({
			run: async () => {
				if (factory.firstCall.args[2]?.aborted) throw HookExecutionError.cancellation("hook")
				return { cancel: false, contextModification: "", errorMessage: "" }
			}
		} as any)

		const pending = executeHook({ ...options(manager, "hook"), messenger: { createCard } as any })
		await pWaitFor(() => createCard.calledOnce, { interval: 1 })
		taskState.abort = true
		let cancelled = false
		const cancellation = manager.cancelAllHookExecutions().then(() => { cancelled = true })
		const startingHook = [...taskState.activeHookExecutions.values()][0]
		assert.equal(startingHook.messageId, undefined)
		await pWaitFor(() => startingHook.abortController.signal.aborted, { interval: 1 })
		assert.equal(cancelled, false)
		card.resolve({ id: "hook" })

		assert.deepEqual(await pending, { cancel: true, wasCancelled: true })
		await cancellation
		assert.equal(cancelled, true)
		assert.equal(factory.firstCall.args[2]?.aborted, true)
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	for (const outcome of ["success", "noop", "cancel", "error"] as const) {
		it(`releases only its own run after ${outcome}, including early returns`, async () => {
			const { manager } = createManager()
			const sibling = execution("sibling")
			await manager.setActiveHookExecution(sibling)
			if (outcome === "error") expectLoggerErrors()
			stubFactory().resolves({
				run: async () => {
					if (outcome === "error") throw new Error("Hook failed")
					return { cancel: outcome === "cancel", contextModification: outcome === "success" ? "context" : "", errorMessage: "" }
				}
			} as any)
			const clear = sinon.spy(manager, "clearActiveHookExecution")
			const register = sinon.spy(manager, "setActiveHookExecution")
			await executeHook(options(manager, "hook"))

			const runId = register.firstCall.args[0].runId
			sinon.assert.calledOnceWithExactly(clear, runId)
			assert.equal(await manager.getActiveHookExecution(runId), undefined)
			assert.equal(await manager.getActiveHookExecution("sibling"), sibling)
			assert.equal(sibling.abortController.signal.aborted, false)
		})
	}

	it("joins cancellation while hook discovery is still pending", async () => {
		const { manager, taskState } = createManager()
		const discovery = deferred<boolean>()
		const hasHook = sinon.stub(HookFactory.prototype, "hasHook").returns(discovery.promise)
		const pending = executeHook(options(manager, "hook"))
		await pWaitFor(() => hasHook.calledOnce, { interval: 1 })
		const startingHook = [...taskState.activeHookExecutions.values()][0]
		let cancelled = false
		const cancellation = manager.cancelAllHookExecutions().then(() => { cancelled = true })
		await pWaitFor(() => startingHook.abortController.signal.aborted, { interval: 1 })
		assert.equal(cancelled, false)
		discovery.resolve(false)
		await pending
		await cancellation
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	it("completing one concurrent runner leaves its sibling cancellable", async () => {
		const { manager, taskState } = createManager()
		const firstRun = deferred<{ cancel: boolean; contextModification: string; errorMessage: string }>()
		const factory = stubFactory()
		factory.onFirstCall().resolves({ run: () => firstRun.promise } as any)
		factory.onSecondCall().callsFake(async (_name, _stream, signal) => ({
			run: () => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(HookExecutionError.cancellation("hook")), { once: true })),
		}) as any)
		const first = executeHook(options(manager, "first-card"))
		await pWaitFor(() => factory.calledOnce, { interval: 1 })
		const second = executeHook(options(manager, "second-card"))
		await pWaitFor(() => factory.calledTwice, { interval: 1 })
		const sibling = [...taskState.activeHookExecutions.values()].find((run) => run.messageId === "second-card")!
		firstRun.resolve({ cancel: false, contextModification: "", errorMessage: "" })
		await first
		assert.equal(taskState.activeHookExecutions.size, 1)
		assert.equal(await manager.getActiveHookExecution(sibling.runId), sibling)
		assert.equal(sibling.abortController.signal.aborted, false)
		await manager.cancelHookExecution(sibling.runId)
		assert.deepEqual(await second, { cancel: true, wasCancelled: true })
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	it("cancels an owned Notification by its operation signal without cancelling its sibling", async () => {
		const { manager, taskState } = createManager()
		const firstOwner = new AbortController()
		const secondOwner = new AbortController()
		const firstCleanup = deferred<void>()
		const secondCleanup = deferred<void>()
		const removeFirstListener = sinon.spy(firstOwner.signal, "removeEventListener")
		const removeSecondListener = sinon.spy(secondOwner.signal, "removeEventListener")
		const factory = stubFactory()
		let started = 0
		factory.callsFake(async (_name, _stream, signal) => {
			const cleanup = started++ === 0 ? firstCleanup : secondCleanup
			return {
				run: async () => {
					await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
					await cleanup.promise
					throw HookExecutionError.cancellation("hook")
				}
			} as any
		})
		const notification = (messageId: string, signal: AbortSignal) => executeHook({
			...options(manager, messageId),
			hookName: "Notification",
			hookInput: { notification: { event: "user_attention", source: "card_interaction", message: messageId, waitingForUserInput: true } },
			isCancellable: false,
			signal,
		})
		const first = notification("first-card", firstOwner.signal)
		await pWaitFor(() => factory.calledOnce, { interval: 1 })
		const second = notification("second-card", secondOwner.signal)
		await pWaitFor(() => factory.calledTwice, { interval: 1 })
		const firstRun = [...taskState.activeHookExecutions.values()].find((run) => run.messageId === "first-card")!
		const secondRun = [...taskState.activeHookExecutions.values()].find((run) => run.messageId === "second-card")!
		let firstCompleted = false
		void firstRun.completion.then(() => { firstCompleted = true })
		firstOwner.abort()
		assert.equal(firstRun.abortController.signal.aborted, true)
		assert.equal(secondRun.abortController.signal.aborted, false)
		assert.equal(firstCompleted, false)
		assert.equal(taskState.activeHookExecutions.size, 2)
		firstCleanup.resolve()
		assert.deepEqual(await first, { cancel: true, wasCancelled: true })
		assert.equal(firstCompleted, true)
		assert.equal(taskState.activeHookExecutions.size, 1)
		sinon.assert.calledOnceWithExactly(removeFirstListener, "abort", sinon.match.func)

		let allCompleted = false
		const shutdown = manager.cancelAllHookExecutions().then(() => { allCompleted = true })
		await pWaitFor(() => secondRun.abortController.signal.aborted, { interval: 1 })
		assert.equal(allCompleted, false)
		secondCleanup.resolve()
		assert.deepEqual(await second, { cancel: true, wasCancelled: true })
		await shutdown
		assert.equal(taskState.activeHookExecutions.size, 0)
		sinon.assert.calledOnceWithExactly(removeSecondListener, "abort", sinon.match.func)
	})

	it("does not turn a settled execution error into cleanup failure when cancellation races", async () => {
		const { manager, taskState } = createManager()
		const started = deferred<void>()
		const executionError = HookExecutionError.execution("global-hook", 1)
		stubFactory().callsFake(async (_name, _stream, signal) => ({
			run: async () => {
				started.resolve()
				await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
				// A combined runner can return an earlier sibling's failure after joining cancellation.
				throw executionError
			},
		}) as any)
		const pending = executeHook(options(manager, "hook"))
		await started.promise
		const owned = [...taskState.activeHookExecutions.values()][0]
		const [result] = await Promise.all([pending, manager.cancelAllHookExecutions()])

		assert.deepEqual(result, { cancel: true, wasCancelled: true })
		await owned.completion
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	it("joins all siblings before surfacing cancelled-hook cleanup failure", async () => {
		const { manager, taskState } = createManager()
		const slowCleanup = deferred<void>()
		const failure = new HookCleanupError([new Error("publication failed")], "output cleanup failed")
		let started = 0
		const factory = stubFactory()
		factory.callsFake(async (_name, _stream, signal) => {
			const first = started++ === 0
			return {
				run: async () => {
					await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
					if (first) throw failure
					await slowCleanup.promise
					throw HookExecutionError.cancellation("hook")
				}
			} as any
		})
		const first = executeHook(options(manager, "first"))
		const firstFailure = assert.rejects(first, (error) => error === failure)
		const second = executeHook(options(manager, "second"))
		await pWaitFor(() => factory.calledTwice, { interval: 1 })
		let settled = false
		const shutdown = manager.cancelAllHookExecutions().finally(() => { settled = true })
		const shutdownFailure = assert.rejects(shutdown, /Hook cleanup failed/)
		await firstFailure
		assert.equal(settled, false)
		assert.equal(taskState.activeHookExecutions.size, 1)
		slowCleanup.resolve()
		await second
		await shutdownFailure
		assert.equal(taskState.activeHookExecutions.size, 0)
	})

	it("rejects owned completion when cancellation status publication fails", async () => {
		const { manager } = createManager()
		const owner = new AbortController()
		const statusFailure = new Error("status publication failed")
		stubFactory().resolves({
			run: async () => {
				owner.abort()
				throw HookExecutionError.cancellation("hook")
			}
		} as any)
		const registered = sinon.spy(manager, "setActiveHookExecution")
		const pending = executeHook({
			...options(manager, "hook"), signal: owner.signal,
			messageStateHandler: {
				findMessageIndexById: () => 0,
				getDiracMessages: () => [{ content: { type: "card", card: {} } }],
				updateDiracMessage: async () => { throw statusFailure },
			} as any,
		})
		await assert.rejects(pending, (error) => error === statusFailure)
		await assert.rejects(registered.firstCall.args[0].completion, (error) => error === statusFailure)
	})

	it("settles completion only after asynchronous cleanup, even when cleanup fails", async () => {
		const { manager } = createManager()
		stubFactory().resolves({ run: async () => ({ cancel: true, contextModification: "", errorMessage: "" }) } as any)
		const cleanup = deferred<void>()
		let tracked!: HookExecution
		let completed = false
		const clear = sinon.stub().callsFake(async (messageId: string) => {
			await cleanup.promise
			await manager.clearActiveHookExecution(messageId)
			throw new Error("cleanup failed")
		})
		const pending = executeHook({
			...options(manager, "hook"),
			setActiveHookExecution: async (run) => {
				tracked = run
				void run.completion.then(() => { completed = true }, () => { completed = true })
				await manager.setActiveHookExecution(run)
			},
			clearActiveHookExecution: clear,
		})
		const rejection = assert.rejects(pending, /cleanup failed/)
		await pWaitFor(() => clear.calledOnce, { interval: 1 })
		assert.equal(completed, false)
		assert.equal(await manager.getActiveHookExecution(tracked.runId), tracked)
		cleanup.resolve()
		await rejection
		await assert.rejects(tracked.completion, /cleanup failed/)
		assert.equal(completed, true)
	})
})
