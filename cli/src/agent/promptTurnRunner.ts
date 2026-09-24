import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessageChange } from "@core/task/message-state"
import { isResumePromptCard } from "@shared/cardIdentity"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import type { Controller } from "@/core/controller"
import { Logger } from "@/shared/services/Logger.js"
import { copyTaskRuntimeSettings } from "../acp/acp-session-runtime-config.js"
import { recordTaskForSession } from "../acp/acp-session-tasks.js"
import type { PinnedMessagesManager } from "./pinnedMessages.js"
import { type PromptContent, parsePromptContent } from "./promptContent.js"
import type { PromptSteeringQueue } from "./promptSteeringQueue.js"
import type { DiracAcpSession } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { handleAcpReviewCommand } from "./review.js"
import type { SessionConfigManager } from "./sessionConfig.js"
import type { SessionPermissionManager } from "./sessionPermissions.js"
import type { SessionRuntimeManager } from "./sessionRuntime.js"
import type { TaskMessageBridge } from "./taskMessageBridge.js"
import type { AcpSessionState } from "./types.js"

interface PromptTurnDeps {
	sessions: Map<string, DiracAcpSession>
	sessionStates: Map<string, AcpSessionState>
	getController(session: DiracAcpSession): Controller | undefined
	runtime: SessionRuntimeManager
	steering: PromptSteeringQueue
	permissions: SessionPermissionManager
	pinned: PinnedMessagesManager
	sessionConfig: SessionConfigManager
	bridgeForSession(sessionId: string): TaskMessageBridge
	emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void>
	sendAvailableCommands(sessionId: string, controller: Controller): Promise<void>
	setSessionTitleFromFirstExchange(session: DiracAcpSession, promptText: string): Promise<void>
}

/**
 * Runs a single ACP prompt turn: serializes host-service prompt access across
 * sessions, binds the session's task, routes the prompt into the right task
 * path (new/continue/resume), and resolves when the turn completes or cancels.
 */

/** Mutable per-turn state shared by the prompt phases. */
interface PromptTurnContext {
	sessionId: string
	session: DiracAcpSession
	sessionState: AcpSessionState
	controller: Controller
	bridge: TaskMessageBridge
	/** Settles when the task completes, is cancelled, needs input, or fails internally. */
	promptPromise: Promise<acp.PromptResponse>
	resolvePrompt: (response: acp.PromptResponse) => void
	rejectPrompt: (error: Error) => void
	promptResolved: { value: boolean }
	cleanupFunctions: (() => void)[]
	subscribedTask: object | undefined
}

export class PromptTurnRunner {
	private activePrompt: Promise<void> = Promise.resolve()

	/** Session currently owning the serialized host-service prompt path. */
	private activePromptSessionId?: string

	/**
	 * In-flight prompt resolvers, keyed by session id. {@link cancel} uses these
	 * to resolve the current `session/prompt` request with `stopReason: "cancelled"`
	 * as required by the ACP spec
	 * (agent-client-protocol/docs/protocol/prompt-turn.mdx — "After all ongoing
	 * operations have been successfully aborted ... the Agent MUST respond to
	 * the original session/prompt request with the cancelled stop reason").
	 */
	private readonly pendingPromptResolvers: Map<
		string,
		{
			resolve: (response: acp.PromptResponse) => void
			resolved: { value: boolean }
		}
	> = new Map()

	constructor(private readonly deps: PromptTurnDeps) {}

	/** Session currently holding the host-service prompt serialization lock. */
	get currentPromptSessionId(): string | undefined {
		return this.activePromptSessionId
	}

	/**
	 * Handle a user prompt.
	 *
	 * This is the main entry point for user interaction. The agent
	 * processes the prompt and sends updates back via sessionUpdate.
	 *
	 * The prompt flow:
	 * 1. Extract content from the ACP prompt (text, images, files)
	 * 2. Set up internal dirac state subsription
	 * 3. Initialize or continue dirac task
	 * 4. Translate DiracMessages to ACP SessionUpdates
	 * 5. Handle permission requests for tools/commands
	 * 6. Return when dirac task completes, is cancelled, or needs user input
	 */
	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		const session = this.deps.sessions.get(params.sessionId)
		const sessionState = this.deps.sessionStates.get(params.sessionId)

		if (!session || !sessionState) {
			throw new Error(`Session not found: ${params.sessionId}`)
		}

		const controller = this.deps.getController(session)
		if (!controller) {
			throw new Error("Controller not initialized for session. This is a bug in the ACP agent setup.")
		}

		const activeOverrides = await this.deps.runtime.runSessionRuntimeMutation(params.sessionId, async () => {
			if (sessionState.status !== AcpSessionStatus.Idle) {
				throw new Error(`Session ${params.sessionId} is busy with another operation`)
			}
			const sessionOverrides = this.deps.runtime.acpSessionOverrides.get(params.sessionId)
			if (!sessionOverrides) throw new Error(`Session runtime configuration not found: ${params.sessionId}`)
			const overrides = copyTaskRuntimeSettings(sessionOverrides)
			await this.deps.sessionConfig.assertTaskRuntimeAvailable(session, overrides)
			await this.deps.runtime.refreshTaskRuntime(session, overrides)
			this.deps.runtime.activePromptOverrides.set(params.sessionId, overrides)
			this.deps.steering.unbindPromptTask(params.sessionId)
			sessionState.status = AcpSessionStatus.Processing
			session.lastActivityAt = Date.now()
			return overrides
		})
		void activeOverrides // returned for parity with the mutation result; prompt uses the map as the source of truth

		Logger.debug("[DiracAgent] prompt called:", {
			sessionId: params.sessionId,
			promptLength: params.prompt.length,
		})
		const previousPrompt = this.activePrompt
		let releasePrompt!: () => void
		this.activePrompt = new Promise<void>((resolve) => {
			releasePrompt = resolve
		})
		await previousPrompt
		this.activePromptSessionId = params.sessionId

		// A session can be cancelled while queued behind another session's prompt.
		// Do not begin task initialization once it reaches the front of that queue.
		if ((sessionState.status as AcpSessionStatus) === AcpSessionStatus.Cancelled) {
			this.deps.runtime.activePromptOverrides.delete(params.sessionId)
			releasePrompt()
			sessionState.status = AcpSessionStatus.Idle
			this.activePromptSessionId = undefined
			return this.deps.bridgeForSession(params.sessionId).promptResponse("cancelled")
		}

		const turn = this.setupPromptTurn(session, sessionState, controller, params.sessionId)

		try {
			const content = parsePromptContent(params.prompt)

			// Command availability may depend on skills and workflows added after the
			// session was created. Republish the complete current set before each turn.
			await this.deps.sendAvailableCommands(params.sessionId, controller)
			await this.deps.setSessionTitleFromFirstExchange(session, content.textContent)

			const intercepted = await this.interceptReviewCommand(turn, content)
			if (intercepted) return intercepted

			await this.routePromptToTask(turn, content)
			await this.subscribeAndReplayCurrentTask(turn)

			// Return the promise that will resolve when task completes
			return await turn.promptPromise
		} catch (error) {
			if (!turn.promptResolved.value) {
				turn.promptResolved.value = true
				const internalError = error instanceof Error ? error : new Error(String(error))
				try {
					await this.deps.emitSessionUpdate(params.sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: `Error: ${internalError.message}`,
						},
					})
				} catch (emitError) {
					Logger.error("[DiracAgent] Failed to emit internal prompt error:", emitError)
				}
				throw internalError
			}
			throw error
		} finally {
			this.deps.runtime.activePromptOverrides.delete(params.sessionId)
			releasePrompt()
			this.activePromptSessionId = undefined

			// Clean up subscriptions
			for (const cleanup of turn.cleanupFunctions) {
				try {
					cleanup()
				} catch (error) {
					Logger.debug("[DiracAgent] Error during cleanup:", error)
				}
			}
			this.pendingPromptResolvers.delete(params.sessionId)
			this.deps.steering.unbindPromptTask(params.sessionId)

			// Task-owned steering remains in the transcript. Pre-task guidance remains session-owned until a task binds.
			sessionState.status = AcpSessionStatus.Idle
		}
	}

	/** Builds the per-turn context: prompt plumbing plus task-replacement handling. */
	private setupPromptTurn(
		session: DiracAcpSession,
		sessionState: AcpSessionState,
		controller: Controller,
		sessionId: string,
	): PromptTurnContext {
		// Clear only this session's delta and tool-call tracking state.
		const bridge = this.deps.bridgeForSession(sessionId)
		bridge.clearPromptState()

		// Promise that settles when the task completes, is cancelled, needs input,
		// or encounters an internal failure.
		let resolvePrompt!: (response: acp.PromptResponse) => void
		let rejectPrompt!: (error: Error) => void
		const promptPromise = new Promise<acp.PromptResponse>((resolve, reject) => {
			resolvePrompt = resolve
			rejectPrompt = reject
		})

		// Track if we've already resolved/rejected (object for pass-by-reference)
		const promptResolved = { value: false }

		const turn: PromptTurnContext = {
			sessionId,
			session,
			sessionState,
			controller,
			bridge,
			promptPromise,
			resolvePrompt,
			rejectPrompt,
			promptResolved,
			cleanupFunctions: [],
			subscribedTask: undefined,
		}

		// Register the resolver so cancel() can resolve the in-flight prompt with
		// `stopReason: "cancelled"`. Cleared in the finally block.
		this.pendingPromptResolvers.set(sessionId, {
			resolve: turn.resolvePrompt,
			resolved: promptResolved,
		})

		this.registerTaskReplacementListener(turn)
		return turn
	}

	/** Subscribes the bridge to the controller's current task, once per task object. */
	private subscribeToCurrentTask(turn: PromptTurnContext): void {
		const task = turn.controller.task
		if (!task || turn.subscribedTask === task) return
		turn.bridge.subscribeToTaskMessages(
			turn.controller,
			turn.sessionId,
			turn.sessionState,
			turn.resolvePrompt,
			turn.rejectPrompt,
			turn.promptResolved,
			turn.cleanupFunctions,
			turn.controller.taskRunPromise,
		)
		turn.subscribedTask = task
	}

	/** Replays the task's full message history into the session output. */
	private async replayTaskHistory(turn: PromptTurnContext, task: NonNullable<Controller["task"]>): Promise<void> {
		const replayEndIndex = task.messageStateHandler.getDiracMessages().length
		await turn.bridge.replayTaskMessages(
			turn.controller,
			turn.sessionId,
			turn.sessionState,
			turn.resolvePrompt,
			turn.rejectPrompt,
			turn.promptResolved,
			0,
			replayEndIndex,
		)
	}

	/** Resubscribes and replays when the controller replaces the task mid-turn. */
	private registerTaskReplacementListener(turn: PromptTurnContext): void {
		const removeListener = turn.controller.onTaskReplaced(async (taskId) => {
			await turn.bridge.cancelInFlightToolCalls(turn.sessionId, turn.sessionState)
			await recordTaskForSession(turn.sessionId, taskId)
			turn.session.taskId = taskId
			turn.subscribedTask = undefined
			const replacementTask = turn.controller.task
			if (!replacementTask) return
			await this.deps.steering.bindPromptTask(turn.sessionId, replacementTask)
			this.subscribeToCurrentTask(turn)
			await this.replayTaskHistory(turn, replacementTask)
		})
		turn.cleanupFunctions.push(removeListener)
	}

	/** Intercepts /review-style commands before any task routing; null when not intercepted. */
	private async interceptReviewCommand(turn: PromptTurnContext, content: PromptContent): Promise<acp.PromptResponse | null> {
		if (content.imageContent.length > 0 || content.fileResources.length > 0) return null
		const intercepted = await handleAcpReviewCommand({
			commandText: content.textContent,
			controller: turn.controller,
			sessionId: turn.sessionId,
			cwd: turn.session.cwd,
			emitSessionUpdate: (sessionId, update) => this.deps.emitSessionUpdate(sessionId, update),
		})
		if (!intercepted) return null
		return {
			...intercepted,
			...turn.bridge.promptResponse(intercepted.stopReason),
		}
	}

	/** Dispatches the prompt to the right task path: resume, loaded session, continue, or new task. */
	private async routePromptToTask(turn: PromptTurnContext, content: PromptContent): Promise<void> {
		const task = turn.controller.task
		const isLoadedSession = turn.session.isLoadedFromHistory === true

		if (turn.session.awaitingCancelledTaskResume && task) {
			await this.resumeTaskAfterCancellation(turn, task, content)
		} else if (isLoadedSession && !task) {
			await this.resumeLoadedSession(turn, content)
		} else if (task) {
			await this.continueActiveTask(turn, task, content)
		} else {
			await this.startNewTask(turn, content)
		}
	}

	/**
	 * cancelTask() reinitializes persisted history and leaves its replacement task
	 * waiting in resumeTaskFromHistory(). ACP has no historical resume-card
	 * requirement, so wake that flow directly rather than replacing the task.
	 */
	private async resumeTaskAfterCancellation(
		turn: PromptTurnContext,
		task: NonNullable<Controller["task"]>,
		content: PromptContent,
	): Promise<void> {
		Logger.debug("[DiracAgent] Resuming task reinitialized after cancellation:", task.taskId)
		this.subscribeToCurrentTask(turn)
		await this.deps.steering.bindPromptTask(turn.sessionId, task)
		await task.submitCardResponse(
			"",
			DiracAskResponse.MESSAGE,
			content.textContent,
			content.imageContent,
			content.fileResources,
		)
		turn.session.awaitingCancelledTaskResume = false
	}

	/** First prompt on a loaded session — resume the task from persisted history. */
	private async resumeLoadedSession(turn: PromptTurnContext, content: PromptContent): Promise<void> {
		Logger.debug("[DiracAgent] Resuming loaded session:", turn.sessionId)

		// Clear the flag so subsequent prompts are handled normally.
		turn.session.isLoadedFromHistory = false

		// Use loadedTaskId if set (multi-task session resolved in loadSession),
		// otherwise fall back to sessionId (common case where taskId === sessionId).
		const taskIdToResume = turn.session.loadedTaskId ?? turn.sessionId
		turn.session.loadedTaskId = undefined

		await turn.controller.reinitExistingTaskFromId(
			taskIdToResume,
			this.deps.pinned.activePromptInitializationOptions(turn.sessionId),
		)

		const task = turn.controller.task
		if (!task) return

		const resumeResult = await this.waitForLoadedTaskResume(task, turn.controller)

		if (resumeResult === "completed") {
			// Completed history is terminal: resumeTaskFromHistory() intentionally does
			// not issue a resume card or wait for a response. Start a fresh task for
			// the first new ACP prompt rather than waiting forever for that card.
			Logger.debug("[DiracAgent] Starting a new task from completed loaded session:", taskIdToResume)
			await turn.controller.initTask(
				content.textContent,
				content.imageContent,
				content.fileResources,
				undefined,
				undefined,
				undefined,
				undefined,
				this.deps.pinned.activePromptInitializationOptions(turn.sessionId),
			)
			if (turn.controller.task) {
				await recordTaskForSession(turn.sessionId, turn.controller.task.taskId)
				turn.session.taskId = turn.controller.task.taskId
			}
		} else {
			this.subscribeToCurrentTask(turn)
			await task.submitCardResponse(
				"",
				DiracAskResponse.MESSAGE,
				content.textContent,
				content.imageContent,
				content.fileResources,
			)
		}
	}

	/** Resolves once the reloaded task either turns out completed or shows its resume card. */
	private waitForLoadedTaskResume(
		task: NonNullable<Controller["task"]>,
		controller: Controller,
	): Promise<"completed" | "resumed"> {
		return new Promise<"completed" | "resumed">((resolve, reject) => {
			let settled = false
			const finish = (result: "completed" | "resumed") => {
				if (settled) return
				settled = true
				clearInterval(statusPoll)
				task.messageStateHandler.off("diracMessagesChanged", onChanged)
				resolve(result)
			}
			const onRunPromiseError = (err: unknown) => {
				if (settled) return
				settled = true
				clearInterval(statusPoll)
				task.messageStateHandler.off("diracMessagesChanged", onChanged)
				reject(err instanceof Error ? err : new Error(String(err)))
			}
			const hasResumeCard = () =>
				task.messageStateHandler
					.getDiracMessages()
					.some((message) => message.content.type === DiracMessageType.CARD && isResumePromptCard(message.content.card))
			const checkResumeState = () => {
				if (task.taskState.status === TaskStatus.COMPLETED) return finish("completed")
				if (hasResumeCard()) finish("resumed")
			}
			const onChanged = (change: DiracMessageChange) => {
				if (
					change.type === "add" &&
					change.message?.content.type === DiracMessageType.CARD &&
					isResumePromptCard(change.message.content.card)
				) {
					finish("resumed")
				}
			}
			const statusPoll = setInterval(checkResumeState, 10)
			task.messageStateHandler.on("diracMessagesChanged", onChanged)
			Promise.resolve(controller.taskRunPromise).catch(onRunPromiseError)
			checkResumeState()
		})
	}

	/** Continue the session's active task — pending ask card, completed follow-up, or fresh restart. */
	private async continueActiveTask(
		turn: PromptTurnContext,
		task: NonNullable<Controller["task"]>,
		content: PromptContent,
	): Promise<void> {
		Logger.debug("[DiracAgent] Continuing existing task:", task.taskId)

		const waitingCardId = task.taskState.lastWaitingCardId
		const waitingCard = waitingCardId
			? task.messageStateHandler
					.getDiracMessages()
					.find(
						(message) =>
							message.content.type === DiracMessageType.CARD &&
							message.content.card.id === waitingCardId &&
							message.content.card.status === CardStatus.WAITING_FOR_INPUT,
					)
			: undefined

		if (waitingCard) {
			this.subscribeToCurrentTask(turn)
			await task.submitCardResponse(
				waitingCardId!,
				DiracAskResponse.MESSAGE,
				content.textContent,
				content.imageContent,
				content.fileResources,
			)
		} else if (task.taskState.didAttemptCompletion) {
			// The completion card resolves session/prompt slightly before the core task
			// finishes publishing its terminal state. Wait until that handoff clears stale
			// response fields before submitting the follow-up. Completed tasks intentionally
			// retain COMPLETED while waitForFollowUp() accepts the next message.
			await pWaitFor(
				() => {
					const status = task.taskState.status
					return status === TaskStatus.COMPLETED || status === TaskStatus.AWAITING_USER_INPUT
				},
				{ interval: 10 },
			)

			// A completion response ends the ACP turn, not the conversation. The core
			// task remains alive in waitForFollowUp() so the next session/prompt can
			// continue with the same API conversation history.
			Logger.debug("[DiracAgent] Continuing completed task in existing ACP session:", task.taskId)
			this.subscribeToCurrentTask(turn)
			await task.submitCardResponse(
				"",
				DiracAskResponse.MESSAGE,
				content.textContent,
				content.imageContent,
				content.fileResources,
			)
		} else {
			await this.startTaskInActiveSession(turn, content)
		}
	}

	/** Starts a fresh task when the active one cannot accept a follow-up. */
	private async startTaskInActiveSession(turn: PromptTurnContext, content: PromptContent): Promise<void> {
		Logger.debug("[DiracAgent] Starting new task (active task cannot accept a follow-up)")
		await turn.controller.initTask(
			content.textContent,
			content.imageContent,
			content.fileResources,
			undefined,
			undefined,
			undefined,
			undefined,
			this.deps.pinned.activePromptInitializationOptions(turn.sessionId),
		)
		const task = turn.controller.task
		if (!task) return
		await recordTaskForSession(turn.sessionId, task.taskId)
		turn.session.taskId = task.taskId
		this.subscribeToCurrentTask(turn)
		await this.replayTaskHistory(turn, task)
	}

	/** Starts the session's first task, consuming the reserved taskId so it equals the sessionId. */
	private async startNewTask(turn: PromptTurnContext, content: PromptContent): Promise<void> {
		// Start new task — consume reservedTaskId (sessionId) so the task's taskId
		// equals the sessionId, enabling loadSession to find it without a map lookup.
		const taskIdOverride = turn.session.reservedTaskId
		turn.session.reservedTaskId = undefined
		Logger.debug("[DiracAgent] Starting new task")
		await turn.controller.initTask(
			content.textContent,
			content.imageContent,
			content.fileResources,
			undefined,
			undefined,
			taskIdOverride,
			undefined,
			this.deps.pinned.activePromptInitializationOptions(turn.sessionId),
		)
		turn.session.taskId = turn.controller.task?.taskId
	}

	/**
	 * Subscribes and replays the current task when no branch already did.
	 * Existing continuations subscribe before waking the task; newly created
	 * tasks subscribe and replay the messages emitted during initialization.
	 */
	private async subscribeAndReplayCurrentTask(turn: PromptTurnContext): Promise<void> {
		const task = turn.controller.task
		if (!task || turn.subscribedTask) return

		this.subscribeToCurrentTask(turn)
		await this.replayTaskHistory(turn, task)
	}

	/**
	 * Cancel the current operation in a session.
	 *
	 * This is a notification (no response expected). The agent should
	 * stop any ongoing processing for the specified session.
	 */
	async cancel(params: acp.CancelNotification): Promise<void> {
		const session = this.deps.sessions.get(params.sessionId)
		if (!session) {
			Logger.debug("[DiracAgent] cancel called for non-existent session:", params.sessionId)
			return
		}
		const sessionState = this.deps.sessionStates.get(params.sessionId)

		Logger.debug("[DiracAgent] cancel called:", {
			sessionId: params.sessionId,
			status: sessionState?.status,
		})

		if (sessionState) {
			sessionState.status = AcpSessionStatus.Cancelled

			// Claim the prompt-resolver slot BEFORE any await so the idle watchdog
			// cannot steal it while we're awaiting cancelTask(). The ACP spec
			// (prompt-turn.mdx) requires the agent to respond with stopReason:
			// "cancelled" once the task is aborted; claiming here ensures that even
			// if the watchdog timer fires and its callback runs during the cancelTask()
			// await, the watchdog sees the flag and returns without emitting a phantom
			// "Agent stalled" tool_call or resolving with "end_turn".
			const pending = this.pendingPromptResolvers.get(params.sessionId)
			const cancelClaimed = pending != null && !pending.resolved.value
			if (cancelClaimed) {
				pending!.resolved.value = true
				// Actual resolve() call is deferred until after cancelTask() so the
				// response goes out once the task is truly stopped (see below).
			}

			// Abort a permission request that is currently waiting on the client. Its
			// normal response path turns this into a rejected Dirac card response.
			this.deps.permissions.cancelPendingPermission(params.sessionId)

			const bridge = this.deps.bridgeForSession(params.sessionId)
			bridge.invalidatePendingInteractions()
			this.deps.permissions.cancelPendingElicitation(params.sessionId)

			try {
				// If we have an active controller task, cancel it before resolving prompt.
				const controller = this.deps.getController(session)
				if (controller?.task) {
					try {
						await controller.cancelTask()

						// TaskController.cancelTask() recreates persisted tasks and starts their
						// resume flow. Mark that handoff explicitly so the next ACP prompt can
						// submit to it without depending on a historical card.
						if (controller.task) {
							session.taskId = controller.task.taskId
							session.awaitingCancelledTaskResume = true
						}
					} catch (error) {
						Logger.debug("[DiracAgent] Error cancelling task:", error)
					}

					await bridge.waitForMessageWork()
				}

				// ACP clients retain tool calls until a terminal update arrives. Close
				// every outstanding call, including one awaiting permission, before the
				// cancelled prompt response is emitted.
				await bridge.cancelInFlightToolCalls(params.sessionId, sessionState)
			} catch (error) {
				Logger.error("[DiracAgent] Error finalizing ACP cancellation:", error)
			} finally {
				// Cancellation owns this resolver once claimed. Cleanup failures must not
				// strand the original session/prompt request.
				if (cancelClaimed) {
					pending!.resolve(bridge.promptResponse("cancelled"))
				}
			}
		}
	}
}
