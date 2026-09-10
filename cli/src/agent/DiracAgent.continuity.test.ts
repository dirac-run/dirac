import { TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, expect, it, vi } from "vitest"

function findRuntimeSettings(value: unknown, depth = 0): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || depth > 3) return undefined
	const record = value as Record<string, unknown>
	if ((record.mode === "plan" || record.mode === "act") && ("autoApproveAllToggled" in record || "yoloModeToggled" in record)) {
		return record
	}
	for (const nested of Object.values(record)) {
		const runtime = findRuntimeSettings(nested, depth + 1)
		if (runtime) return runtime
	}
	return undefined
}

const mocks = vi.hoisted(() => {
	let activePromptResolver: ((response: { stopReason: string }) => void) | undefined
	const controllers: MockController[] = []

	let resolveSubmittedResponses = true
	const conversationHistory = ["remember: established context"]

	const task = {
		taskId: "session-task",
		conversationHistory,
		taskState: {
			lastWaitingCardId: undefined as string | undefined,
			didAttemptCompletion: true,
			status: "awaiting_user_input",
		},
		messageStateHandler: {
			getDiracMessages: vi.fn(() => []),
			on: vi.fn(),
			off: vi.fn(),
		},
		submitCardResponse: vi.fn(async () => {
			if (resolveSubmittedResponses) activePromptResolver?.({ stopReason: "end_turn" })
		}),
		applyWorkingConfigurationUpdate: vi.fn(async (_patch: unknown, beforeCommit?: () => void | Promise<void>) => {
			await beforeCommit?.()
		}),
		canAcceptSteeringMessage: vi.fn(() => false),
	}

	class MockController {
		task: typeof task | undefined
		taskRunPromise: Promise<void> | undefined
		getStateToPostToWebview = vi.fn(async () => ({ mode: "act" }))
		onTaskReplaced = vi.fn(() => () => undefined)
		dispose = vi.fn()
		initTask = vi.fn(async () => {
			this.task = task
			return task.taskId
		})
		reinitExistingTaskFromId = vi.fn(async () => {
			this.task = task
			task.taskState.didAttemptCompletion = true
			task.taskState.status = TaskStatus.COMPLETED
		})
		cancelTask = vi.fn(async () => {
			this.task = task
			task.taskState.lastWaitingCardId = undefined
			task.taskState.didAttemptCompletion = false
			task.taskState.status = TaskStatus.CANCELLED
		})

		constructor() {
			controllers.push(this)
		}
	}

	class MockTaskMessageBridge {
		clearPromptState = vi.fn()
		promptResponse = vi.fn((stopReason: string) => ({ stopReason }))
		cancelInFlightToolCalls = vi.fn(async () => undefined)
		invalidatePendingInteractions = vi.fn()
		waitForMessageWork = vi.fn(async () => undefined)
		subscribeToTaskMessages = vi.fn(
			(
				_controller: unknown,
				_sessionId: string,
				_sessionState: unknown,
				resolvePrompt: (response: { stopReason: string }) => void,
			) => {
				activePromptResolver = resolvePrompt
			},
		)
		replayTaskMessages = vi.fn(async () => {
			activePromptResolver?.({ stopReason: "end_turn" })
		})
	}

	return {
		controllers,
		task,
		MockController,
		MockTaskMessageBridge,
		setResolveSubmittedResponses(value: boolean) {
			resolveSubmittedResponses = value
		},
		reset() {
			activePromptResolver = undefined
			controllers.splice(0)
			task.taskState.lastWaitingCardId = undefined
			task.taskState.didAttemptCompletion = true
			task.taskState.status = "awaiting_user_input"
			task.messageStateHandler.getDiracMessages.mockClear()
			task.submitCardResponse.mockClear()
			task.applyWorkingConfigurationUpdate.mockReset()
			task.applyWorkingConfigurationUpdate.mockResolvedValue(undefined)
			resolveSubmittedResponses = true
		},
	}
})

const stateManager: any = {
	getGlobalSettingsKey: vi.fn((key: string) => {
		if (key === "mode") return "act"
		if (key === "actModeApiProvider") return "anthropic"
		return undefined
	}),
	getSystemDefaultSettingsKey: vi.fn((key: string) => {
		if (key === "mode") return "act"
		if (key === "actModeApiProvider" || key === "planModeApiProvider") return "anthropic"
		return undefined
	}),
	getApiConfiguration: vi.fn(() => ({})),
	getGlobalStateKey: vi.fn(() => []),
	flushPendingState: vi.fn(async () => undefined),
	captureEffectiveTaskConfiguration: vi.fn((explicitOverrides: Record<string, unknown>) => ({
		settings: structuredClone(explicitOverrides),
		apiConfiguration: structuredClone(explicitOverrides),
	})),
}

vi.mock("@/core/controller", () => ({ Controller: mocks.MockController }))
vi.mock("@/core/storage/disk", () => ({ setRuntimeHooksDir: vi.fn() }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: vi.fn(() => stateManager) } }))
vi.mock("./taskMessageBridge.js", () => ({ TaskMessageBridge: mocks.MockTaskMessageBridge }))

const { DiracAgent } = await import("./DiracAgent.js")
describe("DiracAgent active prompt runtime construction", () => {
	it("reads the latest explicitly transitioned mode at the construction boundary", () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
		const sessionId = "queued-session"
			; (agent as any).activePromptOverrides.set(sessionId, {
				mode: "act",
				autoApproveAllToggled: false,
				yoloModeToggled: false,
			})

		const queuedAtTurnStart = (agent as any).activePromptInitializationOptions(sessionId)
			; (agent as any).activePromptOverrides.set(sessionId, {
				mode: "plan",
				autoApproveAllToggled: false,
				yoloModeToggled: false,
			})
		const atConstructionBoundary = (agent as any).activePromptInitializationOptions(sessionId)

		expect(findRuntimeSettings(queuedAtTurnStart)).toMatchObject({ mode: "act" })
		expect(findRuntimeSettings(atConstructionBoundary)).toMatchObject({ mode: "plan" })
	})

	it("constructs from the active Task mirror rather than an uncommitted session value", () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
		const sessionId = "active-session"
			; (agent as any).acpSessionOverrides.set(sessionId, {
				mode: "plan",
				autoApproveAllToggled: true,
				yoloModeToggled: false,
			})
			; (agent as any).activePromptOverrides.set(sessionId, {
				mode: "plan",
				autoApproveAllToggled: false,
				yoloModeToggled: false,
			})

		expect(findRuntimeSettings((agent as any).activePromptInitializationOptions(sessionId))).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: false,
		})
	})
})



describe("DiracAgent ACP conversation continuity", () => {
	afterEach(() => {
		mocks.reset()
		vi.clearAllMocks()
	})

	it("continues a completed turn on the existing task for the same session", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "act", availableModes: [] }))
			; (agent as any).sendAvailableCommands = vi.fn(async () => undefined)
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]

		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "execute ls" }] } as any)).resolves.toEqual({
			stopReason: "end_turn",
		})
		expect(controller.initTask).toHaveBeenCalledTimes(1)
		const originalTask = controller.task

		mocks.task.taskState.status = TaskStatus.COMPLETED

		await expect(
			agent.prompt({ sessionId, prompt: [{ type: "text", text: "what was my last message?" }] } as any),
		).resolves.toEqual({ stopReason: "end_turn" })

		expect(controller.task).toBe(originalTask)
		expect(controller.initTask).toHaveBeenCalledTimes(1)
		expect(mocks.task.submitCardResponse).toHaveBeenCalledWith(
			"",
			DiracAskResponse.MESSAGE,
			"what was my last message?",
			[],
			[],
		)
		expect(mocks.task.taskState.status).toBe(TaskStatus.COMPLETED)
	})

	it("waits for completion publication before forwarding a follow-up", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "act", availableModes: [] }))

		let setupCallCount = 0
		let markSecondTurnSetup!: () => void
		const secondTurnSetup = new Promise<void>((resolve) => {
			markSecondTurnSetup = resolve
		})
			; (agent as any).sendAvailableCommands = vi.fn(async () => {
				setupCallCount++
				if (setupCallCount === 2) markSecondTurnSetup()
			})
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "execute ls" }] } as any)).resolves.toEqual({
			stopReason: "end_turn",
		})

		mocks.task.taskState.status = TaskStatus.EXECUTING_TOOL
		const followUp = agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] } as any)
		await secondTurnSetup
		await new Promise<void>((resolve) => setImmediate(resolve))

		expect(mocks.task.submitCardResponse).not.toHaveBeenCalled()

		mocks.task.taskState.status = TaskStatus.COMPLETED
		await expect(followUp).resolves.toEqual({ stopReason: "end_turn" })
		expect(mocks.task.submitCardResponse).toHaveBeenCalledWith("", DiracAskResponse.MESSAGE, "continue", [], [])
	})

	it("starts a new task for the first prompt after loading completed history", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "act", availableModes: [] }))
			; (agent as any).sendAvailableCommands = vi.fn(async () => undefined)
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]
		const session = (agent as any).sessions.get(sessionId)
		session.isLoadedFromHistory = true
		session.loadedTaskId = "completed-task"

		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "start a follow-up" }] } as any)).resolves.toEqual({
			stopReason: "end_turn",
		})

		expect(controller.reinitExistingTaskFromId).toHaveBeenCalledWith("completed-task", expect.any(Object))
		expect(controller.initTask).toHaveBeenCalledWith(
			"start a follow-up",
			[],
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			expect.any(Object),
		)
		expect(mocks.task.submitCardResponse).not.toHaveBeenCalled()
	})

	it("resumes the reinitialized task after cancellation without a historical resume card", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "act", availableModes: [] }))
			; (agent as any).sendAvailableCommands = vi.fn(async () => undefined)
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]

		await expect(
			agent.prompt({ sessionId, prompt: [{ type: "text", text: "remember this context" }] } as any),
		).resolves.toEqual({
			stopReason: "end_turn",
		})
		const backingTaskId = controller.task!.taskId
		const initCallsBeforeCancellation = controller.initTask.mock.calls.length

		mocks.setResolveSubmittedResponses(false)
		const activeTurn = agent.prompt({ sessionId, prompt: [{ type: "text", text: "begin active work" }] } as any)
		await vi.waitFor(() =>
			expect(mocks.task.submitCardResponse).toHaveBeenCalledWith("", DiracAskResponse.MESSAGE, "begin active work", [], []),
		)

		await agent.cancel({ sessionId } as any)
		await expect(activeTurn).resolves.toEqual({ stopReason: "cancelled" })
		expect(controller.cancelTask).toHaveBeenCalledOnce()
		expect((agent as any).sessions.get(sessionId).awaitingCancelledTaskResume).toBe(true)

		mocks.setResolveSubmittedResponses(true)
		await expect(
			agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue using the context" }] } as any),
		).resolves.toEqual({
			stopReason: "end_turn",
		})

		expect(controller.task?.taskId).toBe(backingTaskId)
		expect(controller.task?.conversationHistory).toEqual(["remember: established context"])
		expect(controller.initTask).toHaveBeenCalledTimes(initCallsBeforeCancellation)
		expect(mocks.task.submitCardResponse).toHaveBeenLastCalledWith(
			"",
			DiracAskResponse.MESSAGE,
			"continue using the context",
			[],
			[],
		)
		expect((agent as any).sessions.get(sessionId).awaitingCancelledTaskResume).toBe(false)
	})

	it("commits an idle Act transition through the task transaction without global override mutation", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		const controller = mocks.controllers[0]
		controller.task = mocks.task

		const nextOverrides = {
			...(agent as any).acpSessionOverrides.get(sessionId),
			mode: "act",
			actModeApiProvider: "anthropic",
		}
		await (agent as any).replaceSessionRuntimeConfig(session, nextOverrides, "act")

		expect(mocks.task.applyWorkingConfigurationUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ settings: expect.objectContaining({ mode: "act" }) }),
			expect.any(Function),
		)
		expect(session.mode).toBe("act")
	})

	it("serializes provider publications with client runtime mutations", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "act", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		let releasePublication!: () => void
		let markPublicationStarted!: () => void
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve
		})
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve
		})
		const getSessionConfigOptions = (agent as any).sessionConfig.getSessionConfigOptions as ReturnType<typeof vi.fn>
		getSessionConfigOptions.mockImplementationOnce(async () => {
			markPublicationStarted()
			await publicationGate
			return []
		})

		const publication = (agent as any).publishProviderConfigChanges()
		await publicationStarted
		const clientMutation = agent.setSessionConfigOption({
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: true,
		} as any)
		releasePublication()
		await Promise.all([publication, clientMutation])

		expect((agent as any).acpSessionOverrides.get(sessionId).autoApproveAllToggled).toBe(true)
	})

	it("normalizes automatic Act switches before persisting their authoritative runtime", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const runtime = (agent as any).acpSessionOverrides.get(sessionId)
		Object.assign(runtime, {
			mode: "plan",
			planActSeparateModelsSetting: true,
			actModeApiProvider: "deepseek",
			actModeApiModelId: "removed-deepseek-model",
		})

		const persistedSnapshots: Array<Record<string, unknown>> = []
			; (agent as any).writeSessionRuntimeConfig = vi.fn((_session: unknown, overrides: Record<string, unknown>) => {
				persistedSnapshots.push(structuredClone(overrides))
			})
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(
				async (_session: unknown, overrides: Record<string, unknown>) => {
					if (overrides.mode === "act") overrides.actModeApiModelId = "deepseek-flash"
					return []
				},
			)

		await (agent as any).switchSessionToActMode(sessionId)

		expect(persistedSnapshots.at(-1)).toMatchObject({
			mode: "act",
			actModeApiProvider: "deepseek",
			actModeApiModelId: "deepseek-flash",
		})
	})
	it("applies in-turn auto-approve updates to the active Task before advertising them", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		const controller = mocks.controllers[0]
		controller.task = mocks.task
		const activeRuntime = structuredClone((agent as any).acpSessionOverrides.get(sessionId))
			; (agent as any).activePromptOverrides.set(sessionId, activeRuntime)
			; (agent as any).activePromptSessionId = sessionId
		const emitCurrentModeUpdate = vi.spyOn(agent as any, "emitCurrentModeUpdate")

		await agent.setSessionConfigOption({
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: true,
		} as any)

		expect(mocks.task.applyWorkingConfigurationUpdate).toHaveBeenCalledOnce()
		expect(mocks.task.applyWorkingConfigurationUpdate.mock.calls[0]?.[0]).toMatchObject({
			settings: { mode: "plan", autoApproveAllToggled: true },
		})
		expect((agent as any).acpSessionOverrides.get(sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
		})
		expect((agent as any).activePromptOverrides.get(sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
		})

		await agent.setSessionConfigOption({
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: false,
		} as any)

		expect(mocks.task.applyWorkingConfigurationUpdate).toHaveBeenCalledTimes(2)
		expect(mocks.task.applyWorkingConfigurationUpdate.mock.calls[1]?.[0]).toMatchObject({
			settings: { mode: "plan", autoApproveAllToggled: false },
		})
		expect((agent as any).activePromptOverrides.get(sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: false,
		})
		expect(session.mode).toBe("plan")
		expect(emitCurrentModeUpdate).not.toHaveBeenCalled()
	})

	it("does not advertise an in-turn auto-approve update rejected by the active Task", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		mocks.controllers[0].task = mocks.task
		const committedBefore = structuredClone((agent as any).acpSessionOverrides.get(sessionId))
		const activeBefore = structuredClone(committedBefore)
			; (agent as any).activePromptOverrides.set(sessionId, activeBefore)
		const persist = vi.spyOn(agent as any, "writeSessionRuntimeConfig")
		mocks.task.applyWorkingConfigurationUpdate.mockRejectedValueOnce(new Error("invalid task candidate"))

		await expect(
			agent.setSessionConfigOption({
				sessionId,
				configId: "auto_approve",
				type: "boolean",
				value: true,
			} as any),
		).rejects.toThrow("invalid task candidate")

		expect(persist).not.toHaveBeenCalled()
		expect((agent as any).acpSessionOverrides.get(sessionId)).toEqual(committedBefore)
		expect((agent as any).activePromptOverrides.get(sessionId)).toEqual(activeBefore)
		expect(session.mode).toBe("plan")
	})

	it("publishes an authorized active-turn Plan-to-Act switch only after the task runtime changes", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]
		controller.task = mocks.task
			; (agent as any).activePromptOverrides.set(sessionId, structuredClone((agent as any).acpSessionOverrides.get(sessionId)))
			; (agent as any).activePromptSessionId = sessionId

		const order: string[] = []
		const writeSessionRuntimeConfig = vi.spyOn(agent as any, "writeSessionRuntimeConfig").mockImplementation(() => {
			order.push("durable-runtime")
		})
		mocks.task.applyWorkingConfigurationUpdate.mockImplementation(async (_patch, beforeCommit) => {
			await beforeCommit?.()
			order.push("task-runtime")
		})
			; (agent as any).emitCurrentModeUpdate = vi.fn(async () => {
				expect(mocks.task.applyWorkingConfigurationUpdate).toHaveBeenCalledOnce()
				order.push("client-mode-update")
			})

		await (agent as any).switchSessionToActMode(sessionId)
		expect(order).toEqual(["durable-runtime", "task-runtime", "client-mode-update"])
		expect(writeSessionRuntimeConfig).toHaveBeenCalledOnce()
		expect((agent as any).activePromptOverrides.get(sessionId).mode).toBe("act")
		expect((agent as any).sessions.get(sessionId).mode).toBe("act")
	})

	it("leaves an active Plan session unchanged when the Task rejects a mode candidate before persistence", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		mocks.controllers[0].task = mocks.task
		const committedBefore = structuredClone((agent as any).acpSessionOverrides.get(sessionId))
		const activeBefore = structuredClone(committedBefore)
			; (agent as any).activePromptOverrides.set(sessionId, activeBefore)
		const persist = vi.spyOn(agent as any, "writeSessionRuntimeConfig")
		const emitCurrentModeUpdate = vi.spyOn(agent as any, "emitCurrentModeUpdate")
		mocks.task.applyWorkingConfigurationUpdate.mockRejectedValueOnce(new Error("invalid task candidate"))

		await expect((agent as any).switchSessionToActMode(sessionId)).rejects.toThrow("invalid task candidate")

		expect(persist).not.toHaveBeenCalled()
		expect((agent as any).acpSessionOverrides.get(sessionId)).toEqual(committedBefore)
		expect((agent as any).activePromptOverrides.get(sessionId)).toEqual(activeBefore)
		expect(session.mode).toBe("plan")
		expect(emitCurrentModeUpdate).not.toHaveBeenCalled()
	})

	it("leaves an idle Plan session unchanged when durable persistence fails at the Task commit boundary", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		mocks.controllers[0].task = mocks.task
		const committedBefore = structuredClone((agent as any).acpSessionOverrides.get(sessionId))
		let taskCommitted = false
		mocks.task.applyWorkingConfigurationUpdate.mockImplementationOnce(async (_patch, beforeCommit) => {
			await beforeCommit?.()
			taskCommitted = true
		})
		const persistenceFailure = vi
			.spyOn(agent as any, "writeSessionRuntimeConfig")
			.mockImplementationOnce(() => {
				throw new Error("durable write failed")
			})
		const emitCurrentModeUpdate = vi.spyOn(agent as any, "emitCurrentModeUpdate")

		await expect((agent as any).switchSessionToActMode(sessionId)).rejects.toThrow("durable write failed")

		expect(persistenceFailure).toHaveBeenCalledOnce()
		expect(taskCommitted).toBe(false)
		expect((agent as any).acpSessionOverrides.get(sessionId)).toEqual(committedBefore)
		expect(session.mode).toBe("plan")
		expect(emitCurrentModeUpdate).not.toHaveBeenCalled()
	})

	it("leaves an active Plan session unchanged when durable persistence fails during an authorized switch", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const session = (agent as any).sessions.get(sessionId)
		mocks.controllers[0].task = mocks.task
		const committedBefore = structuredClone((agent as any).acpSessionOverrides.get(sessionId))
		const activeBefore = structuredClone(committedBefore)
			; (agent as any).activePromptOverrides.set(sessionId, activeBefore)
		let taskCommitted = false
		mocks.task.applyWorkingConfigurationUpdate.mockImplementationOnce(async (_patch, beforeCommit) => {
			await beforeCommit?.()
			taskCommitted = true
		})
		vi.spyOn(agent as any, "writeSessionRuntimeConfig").mockImplementationOnce(() => {
			throw new Error("durable write failed")
		})
		const emitCurrentModeUpdate = vi.spyOn(agent as any, "emitCurrentModeUpdate")

		await expect((agent as any).switchSessionToActMode(sessionId)).rejects.toThrow("durable write failed")

		expect(taskCommitted).toBe(false)
		expect((agent as any).acpSessionOverrides.get(sessionId)).toEqual(committedBefore)
		expect((agent as any).activePromptOverrides.get(sessionId)).toEqual(activeBefore)
		expect(session.mode).toBe("plan")
		expect(emitCurrentModeUpdate).not.toHaveBeenCalled()
	})

	it("keeps committed and active runtime changes isolated between ACP sessions", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))

		const first = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const second = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const firstActiveRuntime = structuredClone((agent as any).acpSessionOverrides.get(first.sessionId))
			; (agent as any).activePromptOverrides.set(first.sessionId, firstActiveRuntime)
			; (agent as any).activePromptSessionId = first.sessionId

		await agent.setSessionConfigOption({
			sessionId: first.sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: true,
		} as any)

		expect((agent as any).acpSessionOverrides.get(first.sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
		})
		expect((agent as any).activePromptOverrides.get(first.sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
		})
		expect((agent as any).acpSessionOverrides.get(second.sessionId)).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: false,
		})
		expect((agent as any).activePromptOverrides.has(second.sessionId)).toBe(false)
	})

	it("passes the owning ACP runtime through initial and reconstructed task initialization", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace", mode: "plan", autoApprove: true, yolo: false })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
			; (agent as any).providerConfiguration.assertProviderEnabled = vi.fn()
			; (agent as any).sessionConfig.getSessionConfigOptions = vi.fn(async () => [])
			; (agent as any).sessionConfig.getSessionModeState = vi.fn(() => ({ currentModeId: "plan", availableModes: [] }))
			; (agent as any).sendAvailableCommands = vi.fn(async () => undefined)
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]
		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "start in Plan" }] } as any)).resolves.toEqual({
			stopReason: "end_turn",
		})
		// Change process defaults after the session-owned runtime was captured. Every
		// subsequent reconstruction must still receive the original Plan ownership.
		stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "mode") return "act"
			if (key === "autoApproveAllToggled" || key === "yoloModeToggled") return true
			if (key === "actModeApiProvider") return "anthropic"
			return undefined
		})
		controller.task = undefined
		const session = (agent as any).sessions.get(sessionId)
		session.isLoadedFromHistory = true
		session.loadedTaskId = "persisted-plan-task"
		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "resume in Plan" }] } as any)).resolves.toEqual({
			stopReason: "end_turn",
		})

		const initialOptions = (controller.initTask.mock.calls as unknown[][])[0]?.[7]
		// The first Task receives the session-owned runtime, not process defaults.
		expect(findRuntimeSettings(initialOptions), "initial task must receive the owning ACP runtime").toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
			yoloModeToggled: false,
		})
		const reconstructionOptions = (controller.reinitExistingTaskFromId.mock.calls as unknown[][]).at(-1)?.[1]
		expect(
			findRuntimeSettings(reconstructionOptions),
			"reconstructed task must receive the owning ACP runtime",
		).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
			yoloModeToggled: false,
		})
		const completedContinuationOptions = (controller.initTask.mock.calls as unknown[][]).at(-1)?.[7]
		expect(
			findRuntimeSettings(completedContinuationOptions),
			"new task after completed history must retain the owning ACP runtime",
		).toMatchObject({
			mode: "plan",
			autoApproveAllToggled: true,
			yoloModeToggled: false,
		})
	})

	it("forces cleanup during shutdown while preserving close-session guards", async () => {
		const agent = new DiracAgent({ cwd: "/tmp/workspace" })
			; (agent as any).ctx = { extensionContext: {}, DATA_DIR: "/tmp/dirac-test-data" }
		const { sessionId } = await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] } as any)
		const controller = mocks.controllers[0]
			; (agent as any).configuringSessions.add(sessionId)

		await expect(agent.closeSession({ sessionId } as any)).rejects.toThrow("applying a runtime configuration change")
		await expect(agent.shutdown()).resolves.toBeUndefined()
		expect(controller.dispose).toHaveBeenCalledOnce()
		expect((agent as any).sessions.has(sessionId)).toBe(false)
	})
})
