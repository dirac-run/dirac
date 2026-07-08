import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessageChange } from "@core/task/message-state"
import { CardStatus, DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Controller } from "@/core/controller"
import { Logger } from "@/shared/services/Logger.js"
import { parseWebSearchMarkerText, translateMessage } from "./messageTranslator.js"
import { handlePermissionResponse } from "./permissionHandler.js"
import type { DiracAcpSession } from "./public-types.js"
import type { AcpSessionState } from "./types.js"

type PromptResolver = (response: acp.PromptResponse) => void

type TaskMessageBridgeOptions = {
	getSession: (sessionId: string) => DiracAcpSession | undefined
	getController: (session: DiracAcpSession) => Controller | undefined
	requestPermission: (
		sessionId: string,
		toolCall: unknown,
		options?: acp.PermissionOption[],
	) => Promise<acp.RequestPermissionResponse>
	emitSessionUpdate: (sessionId: string, update: acp.SessionUpdate) => Promise<void>
	getClientCapabilities: () => acp.ClientCapabilities | undefined
}

export class TaskMessageBridge {
	private readonly getSession: TaskMessageBridgeOptions["getSession"]
	private readonly getController: TaskMessageBridgeOptions["getController"]
	private readonly requestPermission: TaskMessageBridgeOptions["requestPermission"]
	private readonly emitSessionUpdate: TaskMessageBridgeOptions["emitSessionUpdate"]
	private readonly getClientCapabilities: TaskMessageBridgeOptions["getClientCapabilities"]

	/** Track last sent content for partial messages to compute deltas */
	private readonly partialMessageLastContent: Map<number, string> = new Map()

	/**
	 * Accumulated streamed text for message subtypes whose final (non-partial)
	 * emission arrives under a NEW ts, keyed by a stable per-subtype string.
	 *
	 * Two distinct mechanisms produce this ts change mid-stream:
	 *   - completion_result: AttemptCompletionHandler delete-and-replaces the message
	 *     (partial ts=T1 removed, fresh non-partial ts=T2 created).
	 *   - followup / plan_mode_respond: the tool handler issues the final ask() with
	 *     partial=undefined, which TaskMessenger.ask() stores under a fresh Date.now()
	 *     ts rather than reusing the streaming partial's ts.
	 *
	 * In both cases the ts-keyed partialMessageLastContent sees "" for the new ts and
	 * re-emits the full text, duplicating it. Accumulating under a stable subtype key
	 * bridges the gap so the delta computes correctly. Keys: "completion_result",
	 * "followup", "plan_mode_respond". Cleared at the start of each prompt cycle.
	 */
	private readonly tsUnstableStreamLastContent: Map<string, string> = new Map()

	/** Map message timestamps to toolCallIds to avoid creating duplicate tool calls during streaming */
	private readonly messageToToolCallId: Map<number, string> = new Map()

	/** Track waiting cards already delivered to ACP interaction IO during the active prompt turn. */
	private readonly processedInteractionCardKeys: Set<string> = new Set()

	constructor(options: TaskMessageBridgeOptions) {
		this.getSession = options.getSession
		this.getController = options.getController
		this.requestPermission = options.requestPermission
		this.emitSessionUpdate = options.emitSessionUpdate
		this.getClientCapabilities = options.getClientCapabilities
	}

	clearPromptState(): void {
		this.partialMessageLastContent.clear()
		this.tsUnstableStreamLastContent.clear()
		this.messageToToolCallId.clear()
		this.processedInteractionCardKeys.clear()
	}

	subscribeToTaskMessages(
		controller: Controller,
		sessionId: string,
		sessionState: AcpSessionState,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
		cleanupFunctions: Array<() => void>,
		taskRunPromise?: Promise<void>,
	): void {
		// Capture the task reference once so that if cancelTask() triggers a
		// Controller.initTask() reinit (which replaces controller.task with a
		// new Task instance), our cleanup still removes the listener from the
		// *original* task — not from whatever controller.task points to at
		// cleanup time.
		const task = controller.task
		if (!task) return

		const onDiracMessagesChanged = (change: DiracMessageChange) => {
			this.handleDiracMessagesChanged(sessionId, sessionState, change, resolvePrompt, promptResolved).catch((error) =>
				this.handleUnhandledHandlerError(sessionId, promptResolved, resolvePrompt, error),
			)
		}

		task.messageStateHandler.on("diracMessagesChanged", onDiracMessagesChanged)
		cleanupFunctions.push(() => task.messageStateHandler.off("diracMessagesChanged", onDiracMessagesChanged))

		// Safety net: Task.startTask/resumeTaskFromHistory are kicked off
		// detached by Controller.initTask, so any uncaught throw inside the
		// task's run loop never reaches the outer try/catch. This handler
		// ensures task errors surface as failures rather than hanging.
		if (taskRunPromise) {
			taskRunPromise.catch((error) => {
				this.handleUnhandledHandlerError(sessionId, promptResolved, resolvePrompt, error)
			})
		}
	}

	async replayTaskMessages(
		controller: Controller,
		sessionId: string,
		sessionState: AcpSessionState,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
		startIndex = 0,
	): Promise<void> {
		const messages = controller.task?.messageStateHandler.getDiracMessages().slice(startIndex) ?? []

		for (const message of messages) {
			await this.processMessageWithDelta(sessionId, sessionState, message)
			this.checkMessageForPromptResolution(message, resolvePrompt, promptResolved)
			if (promptResolved.value) return
		}
	}

	/**
	 * Terminate the in-flight prompt with an error after an unhandled throw
	 * inside message handling.
	 *
	 * Without this the promise wired up in prompt() would never resolve
	 * and the client (Zed et al.) would spin forever. Emits an
	 * `agent_message_chunk` carrying the error text, then resolves the prompt
	 * with `stopReason: "end_turn"`.
	 */
	private handleUnhandledHandlerError(
		sessionId: string,
		promptResolved: { value: boolean },
		resolvePrompt: PromptResolver,
		error: unknown,
	): void {
		Logger.error("[TaskMessageBridge] Unhandled error in message handler:", error)
		if (promptResolved.value) return
		promptResolved.value = true
		const message = error instanceof Error ? error.message : String(error)
		this.emitSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `Error: ${message}` },
		})
			.catch((emitError) => Logger.error("[TaskMessageBridge] Failed to emit error update:", emitError))
			.finally(() => resolvePrompt({ stopReason: "end_turn" }))
	}

	private async handleDiracMessagesChanged(
		sessionId: string,
		sessionState: AcpSessionState,
		change: DiracMessageChange,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
	): Promise<void> {
		switch (change.type) {
			case "add":
				if (change.message) {
					await this.processMessageWithDelta(sessionId, sessionState, change.message)
					this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
				}
				break

			case "update":
				if (change.message) {
					await this.processMessageWithDelta(sessionId, sessionState, change.message)
					this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
				}
				break
			case "set":
				break
			case "delete":
				break
		}
	}

	private async handlePermissionRequest(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessage,
		permissionRequest: Omit<acp.RequestPermissionRequest, "sessionId">,
	): Promise<void> {
		const session = this.getSession(sessionId)

		if (!session) {
			Logger.debug("[TaskMessageBridge] No session found for permission request")
			return
		}

		const controller = this.getController(session)

		if (!controller?.task) {
			Logger.debug("[TaskMessageBridge] No active task for permission request")
			return
		}

		const cardId = message.content.type === DiracMessageType.CARD ? message.content.card.id : ""

		// Derive interaction type from card properties: requireApproval → "tool", requireFeedback → "followup"
		const interactionType: "tool" | "followup" =
			message.content.type === DiracMessageType.CARD && message.content.card.requireApproval ? "tool" : "followup"

		try {
			const response = await this.requestPermission(sessionId, permissionRequest.toolCall, permissionRequest.options)

			Logger.debug("[TaskMessageBridge] Permission response received:", response.outcome)

			const result = handlePermissionResponse(response, interactionType)
			if (sessionState.currentToolCallId) {
				if (result.cancelled) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "cancelled" },
					})
				} else if (result.response === DiracAskResponse.REJECT) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "rejected" },
					})
				} else {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "in_progress",
					})
				}
			}

			if (result.cancelled) {
				await controller.task.submitCardResponse(cardId, DiracAskResponse.REJECT)
			} else {
				await controller.task.submitCardResponse(cardId, result.response, result.text)
			}
		} catch (error) {
			Logger.debug("[TaskMessageBridge] Error handling permission request:", error)

			if (sessionState.currentToolCallId) {
				await this.emitSessionUpdate(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.currentToolCallId,
					status: "failed",
					rawOutput: { error: String(error) },
				})
			}

			await controller.task.submitCardResponse(cardId, DiracAskResponse.REJECT)
		}
	}

	private checkMessageForPromptResolution(
		message: DiracMessage,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
	): void {
		if (promptResolved.value) return

		switch (message.content.type) {
			case DiracMessageType.CARD: {
				const card = message.content.card

				// Feedback cards (followup, plan_mode_respond, act_mode_respond, mistake_limit_reached)
				// → waiting for user text input, end the turn so the client can collect it.
				if (card.status === CardStatus.WAITING_FOR_INPUT && card.requireFeedback) {
					promptResolved.value = true
					resolvePrompt({ stopReason: "end_turn" })
					return
				}

				// Approval cards for terminal failures (api_req_failed, mistake_limit_reached with requireApproval)
				// End the turn so the client can decide whether to retry.
				if (
					card.status === CardStatus.WAITING_FOR_INPUT &&
					card.requireApproval &&
					(card.header === "API Request Failed" || card.header === "Mistake Limit Reached")
				) {
					promptResolved.value = true
					resolvePrompt({ stopReason: "end_turn" })
					return
				}

				// Terminal success — task completed (completion_result)
				if (card.status === CardStatus.SUCCESS && card.header === "Task Completed") {
					promptResolved.value = true
					resolvePrompt({ stopReason: "end_turn" })
					return
				}

				// Error cards — terminal failure signals
				if (card.status === CardStatus.ERROR) {
					// Non-terminal auto-retry card finalized with ERROR after the
					// retry delay. The task will either succeed on the next attempt
					// or create a separate terminal error card. Don't resolve yet.
					if (card.header === "API Error (Retrying)") {
						break
					}
					// `error_retry` fires once per retry attempt. The final attempt has
					// `failed: true` in its JSON payload — that's the terminal signal for
					// retry-exhausted requests (e.g. bedrock with bad creds), where no
					// subsequent error or api_req_failed card is emitted.
					if (card.body) {
						try {
							const parsed = JSON.parse(card.body)
							if (parsed.failed !== true) {
								// Non-terminal retry card ("API Error (Retrying)") — don't resolve
								break
							}
						} catch {
							// Unparseable payload — treat as terminal error (e.g. "Task Error")
						}
					}
					promptResolved.value = true
					resolvePrompt({ stopReason: "end_turn" })
					return
				}

				break
			}
			case DiracMessageType.CHECKPOINT: {
				// Task completed successfully
				promptResolved.value = true
				resolvePrompt({ stopReason: "end_turn" })
				break
			}
			case DiracMessageType.MARKDOWN:
			case DiracMessageType.API_STATUS:
				// Not terminal — continue streaming
				break
		}
	}

	private getInteractionCardKey(sessionId: string, message: DiracMessage): string | undefined {
		if (message.content.type !== DiracMessageType.CARD) return undefined

		const { card } = message.content
		if (card.status !== CardStatus.WAITING_FOR_INPUT) return undefined
		if (!card.requireApproval && !card.requireFeedback && !card.actions?.length) return undefined

		return `${sessionId}:${card.id}`
	}

	private async processMessageWithDelta(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessage,
	): Promise<void> {
		const messageKey = message.ts
		const lastText = this.partialMessageLastContent.get(messageKey) || ""

		// In the new message model, only MARKDOWN messages stream text content.
		// Card bodies are set at creation time (no incremental streaming).
		// Narrow message.content to MARKDOWN up front so that downstream
		// property accesses (.content, .isCompletion, .isReasoning) type-check
		// without intermediate boolean variables that defeat TS narrowing.
		const isTextStreamingMessage = message.content.type === DiracMessageType.MARKDOWN

		if (
			message.content.type === DiracMessageType.MARKDOWN &&
			message.content.content &&
			!parseWebSearchMarkerText(message.content.content)
		) {
			const isCompletionResult = message.content.isCompletion === true

			const textContent = message.content.content

			// completion_result text was previously wrapped in JSON; in the new model
			// the content is already plain text.

			// completion_result emits its final (non-partial) text under a NEW ts
			// (see tsUnstableStreamLastContent). The ts-keyed partialMessageLastContent
			// sees "" for that new ts and would re-emit the whole text, so for these
			// subtypes we accumulate under a stable key.
			const stableStreamKey = isCompletionResult ? "completion_result" : undefined
			const lastTextForDelta = stableStreamKey ? (this.tsUnstableStreamLastContent.get(stableStreamKey) ?? "") : lastText

			// For streaming text messages, compute delta to avoid sending duplicates
			let textDelta: string
			if (textContent.startsWith(lastTextForDelta)) {
				textDelta = textContent.slice(lastTextForDelta.length)
			} else {
				// Content changed entirely (rare), send all
				textDelta = textContent
			}

			// Determine the correct update type based on message content
			const sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" = message.content.isReasoning
				? "agent_thought_chunk"
				: "agent_message_chunk"

			// For completion_result messages, add a leading newline to separate from previous content
			const needsNewline = isCompletionResult && lastTextForDelta === ""

			// Update tracking BEFORE the await: concurrent event handlers share these accumulators,
			// and an await yields the event loop — a second handler could otherwise read stale state
			// and re-send the full accumulated text instead of just the delta.
			if (stableStreamKey) {
				this.tsUnstableStreamLastContent.set(stableStreamKey, textContent)
			} else {
				this.partialMessageLastContent.set(messageKey, textContent)
			}

			// Only send if there's new content
			if (textDelta) {
				await this.emitSessionUpdate(sessionId, {
					sessionUpdate,
					content: { type: "text", text: needsNewline ? `\n${textDelta}` : textDelta },
				})
			}
		} else {
			// For non-streaming messages (cards, checkpoints, api status), use the full translator
			// Check if we already have a toolCallId for this message (from a previous partial update)
			const existingToolCallId = this.messageToToolCallId.get(messageKey)

			const result = translateMessage(message, sessionState, {
				existingToolCallId,
				clientCapabilities: this.getClientCapabilities(),
			})

			// Send all updates produced by the translator
			for (const update of result.updates) {
				await this.emitSessionUpdate(sessionId, update)
			}

			// Emit usage_update for API_STATUS messages so the TUI StatusBar can show token/cost data.
			if (message.content.type === DiracMessageType.API_STATUS) {
				const info = message.content.status
				if (info.tokensIn !== undefined || info.cost !== undefined) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "usage_update" as any,
						tokensIn: info.tokensIn ?? 0,
						tokensOut: info.tokensOut ?? 0,
						totalCost: info.cost ?? 0,
					} as any)
				}
			}

			// Track the toolCallId for this message so subsequent updates reuse it
			if (result.toolCallId) {
				this.messageToToolCallId.set(messageKey, result.toolCallId)
			}

			// Handle permission requests for card messages
			if (result.requiresPermission && result.permissionRequest) {
				const interactionCardKey = this.getInteractionCardKey(sessionId, message)

				if (interactionCardKey && this.processedInteractionCardKeys.has(interactionCardKey)) {
					Logger.debug("[TaskMessageBridge] Skipping duplicate ACP interaction request:", interactionCardKey)
				} else {
					if (interactionCardKey) {
						this.processedInteractionCardKeys.add(interactionCardKey)
					}
					await this.handlePermissionRequest(sessionId, sessionState, message, result.permissionRequest)
				}
			}

			// Track text content for this message (in case of future updates)
			if (message.content.type === DiracMessageType.CARD && message.content.card.body) {
				this.partialMessageLastContent.set(messageKey, message.content.card.body)
			}

			// NOTE: Do NOT delete messageToToolCallId here. A message can receive multiple
			// non-partial updates (e.g. ask:command status updates during execution).
			// Deleting on the first partial=false would cause subsequent updates to lose the
			// existingToolCallId, generating new tool_call + permission events.
			// The map is cleared at the start of each prompt cycle (clearPromptState()).
		}
	}
}
