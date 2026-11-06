import assert from "node:assert/strict"
import sinon from "sinon"
import pWaitFor from "p-wait-for"
import { HookFactory } from "@core/hooks/hook-factory"
import { executeHook } from "@core/hooks/hook-executor"
import { HookManager } from "../HookManager"
import { TaskState } from "../TaskState"

describe("HookManager cancellation", () => {
	afterEach(() => sinon.restore())

	function createManager() {
		const taskState = new TaskState()
		const manager = new HookManager({
			taskState,
			withStateLock: async (operation: () => unknown) => operation(),
		} as any)
		return { manager, taskState }
	}

	it("tracks a cancellable hook while the task is running", async () => {
		const { manager, taskState } = createManager()
		const execution = { hookName: "TaskStart", messageId: "hook", abortController: new AbortController() }

		await manager.setActiveHookExecution(execution)

		assert.equal(taskState.activeHookExecution, execution)
		assert.equal(execution.abortController.signal.aborted, false)
	})

	it("aborts a hook that registers after task cancellation instead of publishing it", async () => {
		const { manager, taskState } = createManager()
		taskState.abort = true
		const execution = { hookName: "TaskStart", messageId: "hook", abortController: new AbortController() }

		await manager.setActiveHookExecution(execution)

		assert.equal(execution.abortController.signal.aborted, true)
		assert.equal(taskState.activeHookExecution, undefined)
	})

	it("passes cancellation to a TaskStart runner whose card was still being created", async () => {
		const { manager, taskState } = createManager()
		sinon.stub(HookFactory.prototype, "hasHook").resolves(true)
		sinon.stub(HookFactory.prototype, "getHookInfo").resolves({ scriptPaths: ["TaskStart"] })
		let releaseCard!: (card: { id: string }) => void
		const createCard = sinon.stub().returns(new Promise<{ id: string }>((resolve) => { releaseCard = resolve }))
		const factory = sinon.stub(HookFactory.prototype, "createWithStreaming")
		const run = sinon.stub().callsFake(async () => {
			if (factory.firstCall.args[2]?.aborted) throw new Error("Hook execution cancelled")
			return { cancel: false, contextModification: "", errorMessage: "" }
		})
		factory.resolves({ run } as any)

		const pending = executeHook({
			hookName: "TaskStart",
			hookInput: { taskStart: { taskMetadata: { taskId: "task", ulid: "ulid", initialTask: "task" } } },
			isCancellable: true,
			messenger: { createCard } as any,
			setActiveHookExecution: manager.setActiveHookExecution.bind(manager),
			clearActiveHookExecution: manager.clearActiveHookExecution.bind(manager),
			messageStateHandler: { findMessageIndexById: () => -1 } as any,
			taskId: "task",
			hooksEnabled: true,
		})
		await pWaitFor(() => createCard.calledOnce, { interval: 1 })
		taskState.abort = true
		releaseCard({ id: "hook" })

		assert.deepEqual(await pending, { cancel: true, wasCancelled: true })
		assert.equal(factory.firstCall.args[2]?.aborted, true)
		assert.equal(taskState.activeHookExecution, undefined)
	})
})
