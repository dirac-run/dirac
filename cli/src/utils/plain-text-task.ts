/**
 * Plain-text task runner for non-TTY environments (piped output, file redirection)
 * Optimized for CI/CD and piping - only outputs the final completion result to stdout.
 *
 * Design goals:
 * - stdout: Only the final completion result text (no prefix) - perfect for piping
 * - stderr: Errors and verbose output (won't break pipes)
 * - Enables workflows like: git diff | dirac 'explain' | dirac 'summarize'
 */

/* eslint-disable no-console */
// Console output is intentional here for plain text mode

import {
	CardStatus,
	DiracMessage,
	DiracMessageType,
	ExtensionState,
	TaskStatus,
	UIActionButtonType,
} from "@shared/ExtensionMessage"
import { isTaskCompletionCard } from "@shared/cardIdentity"
import { randomUUID } from "node:crypto"
import { Logger } from "@/shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"

import { StringRequest } from "@shared/proto/dirac/common"
import type { Controller } from "@/core/controller"
import { getRequestRegistry } from "@/core/controller/grpc-handler"
import { subscribeToState } from "@/core/controller/state/subscribeToState"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { emitTaskStartedMessage } from "./task-start-output"
import { getApiMetrics } from "@shared/getApiMetrics"
import type { PresentationBatch } from "@shared/PresentationOperation"
import { applyPresentationBatch, createPresentationState } from "@shared/presentationState"
import {
	approveCardForPlainTextYolo,
	getStandaloneCardDisposition,
	StandaloneCardDisposition,
} from "./standalone-card-policy"
import { stderrStyle } from "./display"
import { cardBodyForDisplay } from "./card-body"

export { approveCardForPlainTextYolo } from "./standalone-card-policy"

export interface TerminalStateEvaluation {
	isTerminal: boolean
	action?: "resolve" | "reject"
	error?: Error
}

export function evaluatePlainTextTaskTerminalState(
	state: ExtensionState,
	isViewTaskOnly = false,
): TerminalStateEvaluation {
	const hasTaskFailedCard = (state.diracMessages ?? []).some(
		(m) =>
			m.content.type === DiracMessageType.CARD &&
			m.content.card.header === "Task Failed" &&
			m.content.card.status === CardStatus.ERROR,
	)

	if (hasTaskFailedCard) {
		const failedCard = [...(state.diracMessages ?? [])]
			.reverse()
			.find(
				(m) =>
					m.content.type === DiracMessageType.CARD &&
					m.content.card.header === "Task Failed" &&
					m.content.card.status === CardStatus.ERROR,
			)
		const msg =
			failedCard?.content.type === DiracMessageType.CARD && failedCard.content.card.body
				? failedCard.content.card.body
				: "Mistake limit reached. Task halted in YOLO mode."
		return { isTerminal: true, action: "reject", error: new Error(msg) }
	}

	const globalButtons = state.uiActionState?.globalButtons || []
	const cardButtons = state.uiActionState?.cardButtons || []
	const hasNewTask = globalButtons.some((button) => button.action === UIActionButtonType.NEW_TASK)
	const hasProceed = globalButtons.some((button) => button.action === UIActionButtonType.PROCEED)

	if (hasNewTask && hasProceed) {
		return { isTerminal: true, action: "reject", error: new Error("Mistake limit reached. Task halted in YOLO mode.") }
	}
	if (state.taskStatus === TaskStatus.COMPLETED || (hasNewTask && !hasProceed)) {
		return { isTerminal: true, action: "resolve" }
	}
	if (state.taskStatus === TaskStatus.CANCELLED) {
		if (isViewTaskOnly) {
			return { isTerminal: true, action: "resolve" }
		}
		return { isTerminal: true, action: "reject", error: new Error("Task was cancelled.") }
	}
	if (isViewTaskOnly && cardButtons.length > 0) {
		return { isTerminal: true, action: "resolve" }
	}

	return { isTerminal: false }
}

export interface PlainTextTaskOptions {
	controller: Controller
	/** Prompt for new task or message to send to resumed task */
	prompt?: string
	imageDataUrls?: string[]
	verbose?: boolean
	jsonOutput?: boolean
	/** Timeout in seconds (only applied when explicitly provided) */
	timeoutSeconds?: number
	/** Task ID to resume an existing task */
	taskId?: string
	yolo?: boolean
}

export async function runPlainTextTask(options: PlainTextTaskOptions): Promise<boolean> {
	const { controller, prompt, imageDataUrls, verbose, jsonOutput, yolo } = options

	let completionResolve: () => void
	let completionReject: (reason: Error) => void
	const completionPromise = new Promise<void>((res, rej) => {
		completionResolve = res
		completionReject = rej
	})
	// Subscription callbacks can reject completion while task initialization is
	// still in progress. Attach a handler immediately so Node never reports that
	// legitimate early failure as an unhandled rejection before we await it.
	void completionPromise.catch(() => { })
	let completionSettled = false
	const resolveCompletion = () => {
		if (completionSettled) return
		completionSettled = true
		completionResolve()
	}
	const rejectCompletion = (error: Error) => {
		if (completionSettled) return
		completionSettled = true
		completionReject(error)
	}

	let hasError = false
	let hasEmittedTaskStarted = false
	let taskExecutionStarted = false
	// Track which messages have been processed (by ID)
	const processedMessages = new Set<string>()
	const streamedApiStatusIds = new Set<string>()
	const completedApiStatusIds = new Set<string>()
	const lastPrintedCardState = new Map<string, string>()
	const autoApprovedCards = new Set<string>()
	let approvalQueue = Promise.resolve()
	let latestState: Partial<ExtensionState> = {}
	let presentationState = createPresentationState()

	const isViewTaskOnly = Boolean(options.taskId) && !prompt && !imageDataUrls?.length

	const emitTaskStarted = () => {
		if (hasEmittedTaskStarted) {
			return
		}

		const taskId = controller.task?.taskId
		if (!taskId) {
			return
		}

		emitTaskStartedMessage(taskId, Boolean(jsonOutput))
		hasEmittedTaskStarted = true
	}

	// Helper to process a message and track completion state
	const processMessage = async (message: DiracMessage, state: ExtensionState) => {
		if (completionSettled) return
		const content = message.content

		const isStreaming =
			state.activeVoiceStreamId === message.id || (content.type === DiracMessageType.API_STATUS && state.isApiRequestActive)
		if (isStreaming) {
			// Special case: allow printing the initial api_req_started message even if it's partial
			// so the user knows the request has begun. Subsequent updates will be skipped until complete.
			if (content.type === DiracMessageType.API_STATUS && !streamedApiStatusIds.has(message.id)) {
				if (jsonOutput) {
					process.stdout.write(JSON.stringify(message) + "\n")
				} else {
					handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
				}
				streamedApiStatusIds.add(message.id)
				return
			}

			return
		}

		// Message is complete (or is a partial interaction card)
		// Skip if already processed as a complete message.
		// API_STATUS messages may arrive multiple times as they transition from "started"
		// to "finished" with metrics. We let them through until the metrics version prints.
		if (content.type === DiracMessageType.API_STATUS) {
			if (completedApiStatusIds.has(message.id)) {
				return
			}
			const hasMetrics = content.status.cost !== undefined || content.status.tokensIn !== undefined
			if (processedMessages.has(message.id) && !hasMetrics) {
				return
			}
		} else if (content.type !== DiracMessageType.CARD && processedMessages.has(message.id)) {
			return
		}

		const cardStateKey = content.type === DiracMessageType.CARD ? JSON.stringify(content.card) : undefined
		if (cardStateKey !== undefined && lastPrintedCardState.get(message.id) === cardStateKey) return

		// JSON mode: stream all messages to stdout (existing behavior)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify(message) + "\n")
		} else {
			// For cards, avoid duplicate printing of the same state (interaction cards are never "streaming" in this mode)
			if (content.type === DiracMessageType.CARD) {
				handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
			} else {
				handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
			}
		}

		// Mark as processed if it's a complete message
		if (cardStateKey !== undefined) {
			lastPrintedCardState.set(message.id, cardStateKey)
		} else if (!isStreaming) {
			processedMessages.add(message.id)
			// For API_STATUS, once metrics are present, mark as completed to stop re-printing
			if (content.type === DiracMessageType.API_STATUS && (content.status.cost !== undefined || content.status.tokensIn !== undefined)) {
				completedApiStatusIds.add(message.id)
			}
		}

		// Auto-approve if yolo mode is on and it's an approval request
		if (content.type === DiracMessageType.CARD && content.card.status === CardStatus.WAITING_FOR_INPUT) {
			const disposition = getStandaloneCardDisposition(content.card, Boolean(yolo), isViewTaskOnly)
			if (disposition === StandaloneCardDisposition.AUTO_APPROVE && !autoApprovedCards.has(content.card.id)) {
				autoApprovedCards.add(content.card.id)
				approvalQueue = approvalQueue
					.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
					.then(() => approveCardForPlainTextYolo(controller, content.card))
					.catch((error) => {
						rejectCompletion(
							error instanceof Error
								? error
								: new Error(`Failed to auto-approve card: ${String(error)}`),
						)
					})
				return
			}
			if (disposition === StandaloneCardDisposition.FAIL_FOR_FEEDBACK) {
				rejectCompletion(new Error("Task requires user feedback, which is unavailable in standalone mode."))
				return
			}
			if (disposition === StandaloneCardDisposition.FAIL_FOR_APPROVAL) {
				rejectCompletion(new Error("Task requires approval. Re-run with --yolo or use interactive mode."))
				return
			}
		}

		// Check for task failure card (e.g. YOLO mistake limit reached)
		if (
			content.type === DiracMessageType.CARD &&
			content.card.header === "Task Failed" &&
			content.card.status === CardStatus.ERROR
		) {
			rejectCompletion(new Error(content.card.body || "Mistake limit reached. Task halted in YOLO mode."))
			return
		}

		// Check for API failure (retries exhausted)
		if (content.type === DiracMessageType.API_STATUS && content.status.cancelReason === "retries_exhausted") {
			rejectCompletion(new Error("API request failed: retries exhausted"))
		}
	}

	const requestId = `dirac-plain-text-task-${randomUUID()}`
	let subscriptionStarted = false
	let timeout: NodeJS.Timeout | undefined

	try {
		subscriptionStarted = true
		await subscribeToState(
			controller,
			{},
			async ({ stateJson, presentationJson }) => {
				try {
					const previousActiveVoiceStreamId = latestState.activeVoiceStreamId
					const update = JSON.parse(stateJson) as Partial<ExtensionState>
					latestState = { ...latestState, ...update, activeVoiceStreamId: update.activeVoiceStreamId }
					let changedMessages: DiracMessage[] = []
					if (update.diracMessages !== undefined) {
						presentationState = createPresentationState(
							update.diracMessages,
							update.presentationSurfaceId,
							update.presentationOffset,
						)
						changedMessages = update.diracMessages
					}
					if (presentationJson) {
						const applied = applyPresentationBatch(
							presentationState,
							JSON.parse(presentationJson) as PresentationBatch,
						)
						if (applied.result === "gap") {
							const fullState = await controller.getStateToPostToWebview()
							latestState = fullState
							presentationState = createPresentationState(
								fullState.diracMessages,
								fullState.presentationSurfaceId,
								fullState.presentationOffset,
							)
							changedMessages = fullState.diracMessages
						} else if (applied.result === "applied") {
							changedMessages = applied.changedMessages
						}
					}
					latestState.diracMessages = presentationState.messages
					latestState.presentationSurfaceId = presentationState.surfaceId
					latestState.presentationOffset = presentationState.offset
					if (!taskExecutionStarted) return
					const state = latestState as ExtensionState
					const completedVoiceStreamId = previousActiveVoiceStreamId !== state.activeVoiceStreamId
						? previousActiveVoiceStreamId
						: undefined
					if (completedVoiceStreamId) {
						const completedIndex = presentationState.messageIndexById.get(completedVoiceStreamId)
						const completedMessage = completedIndex === undefined
							? undefined
							: presentationState.messages[completedIndex]
						if (completedMessage) await processMessage(completedMessage, state)
					}
					for (const message of changedMessages) {
						await processMessage(message, state)
					}

					// Check for terminal state via task status and mistake-limit projection
					const terminalCheck = evaluatePlainTextTaskTerminalState(state, isViewTaskOnly)
					if (terminalCheck.isTerminal) {
						if (terminalCheck.action === "resolve") {
							resolveCompletion()
						} else if (terminalCheck.action === "reject" && terminalCheck.error) {
							rejectCompletion(terminalCheck.error)
						}
					}
				} catch (error) {
					rejectCompletion(error instanceof Error ? error : new Error(String(error)))
				}
			},
			requestId,
		)
		// Either resume an existing task or start a new one
		if (options.taskId) {
			// A historical completed state is terminal only when the caller is
			// viewing history. When sending a follow-up, ignore that snapshot until
			// the new turn has actually been submitted.
			taskExecutionStarted = isViewTaskOnly
			// Load the existing task
			await showTaskWithId(controller, StringRequest.create({ value: options.taskId }))
			emitTaskStarted()

			// If a prompt was provided, send it as a message to the resumed task
			if ((prompt || imageDataUrls?.length) && controller.task) {
				// Send the prompt as a response to any pending ask, or as a new message
				taskExecutionStarted = true
				await controller.task.submitCardResponse("", DiracAskResponse.MESSAGE, prompt || "", imageDataUrls)
			}
		} else if (prompt || imageDataUrls?.length) {
			taskExecutionStarted = true
			// Start a new task with the prompt
			await controller.initTask(prompt || "", imageDataUrls)
			emitTaskStarted()
		} else {
			throw new Error("Either taskId or prompt must be provided")
		}

		// Wait for task completion, with optional timeout only when explicitly configured
		if (options.timeoutSeconds) {
			const timeoutMs = options.timeoutSeconds * 1000
			const timeoutPromise = new Promise<void>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Task timed out after ${options.timeoutSeconds} seconds.`)), timeoutMs)
			})
			await Promise.race([completionPromise, timeoutPromise])
		} else {
			await completionPromise
		}
	} catch (error) {
		try {
			await controller.task?.abortTask()
		} catch (abortError) {
			Logger.error("Failed to abort standalone task after an error:", abortError)
		}
		const errMsg = error instanceof Error ? error.message : String(error)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify({ type: "error", message: errMsg }) + "\n")
		} else {
			process.stderr.write(
				stderrStyle.error(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] Error: ${errMsg}`) + "\n",
			)
		}
		hasError = true
	} finally {
		if (timeout) clearTimeout(timeout)
		if (subscriptionStarted) getRequestRegistry().cancelRequest(requestId)
		await approvalQueue
	}

	// non json mode outputs only the final complete message
	if (!jsonOutput && !hasError) {
		const messages = controller.task?.messageStateHandler.getDiracMessages() || []
		// Prefer the body of the "Task Completed" card
		const completionCard = [...messages]
			.reverse()
			.find((m) => m.content.type === DiracMessageType.CARD && isTaskCompletionCard(m.content.card))

		if (completionCard && completionCard.content.type === DiracMessageType.CARD) {
			const card = completionCard.content.card
			process.stdout.write(cardBodyForDisplay(card.body, card.renderType) + "\n")
		} else {
			// Fallback to the last markdown message when no completion card exists.
			const lastMarkdown = [...messages]
				.reverse()
				.find((m) => m.content.type === DiracMessageType.MARKDOWN && !m.content.isReasoning)
			if (lastMarkdown && lastMarkdown.content.type === DiracMessageType.MARKDOWN) {
				process.stdout.write(lastMarkdown.content.content + "\n")
			}
		}
	}

	// Print final summary if verbose or yolo
	if (!jsonOutput && (verbose || yolo)) {
		const messages = controller.task?.messageStateHandler.getDiracMessages() || []
		const metrics = getApiMetrics(messages)
		if (metrics.totalTokensIn > 0 || metrics.totalCost > 0) {
			process.stderr.write(`\n${stderrStyle.dim("-".repeat(40))}\n`)
			process.stderr.write(`${stderrStyle.info("Task Summary:")}\n`)
			process.stderr.write(
				`Tokens: ${metrics.totalTokensIn.toLocaleString()} in, ${metrics.totalTokensOut.toLocaleString()} out${metrics.totalReasoningTokens ? ` (+${metrics.totalReasoningTokens.toLocaleString()} thinking)` : ""}\n`,
			)
			if (metrics.totalCacheReads || metrics.totalCacheWrites) {
				process.stderr.write(
					`Cache: ${(metrics.totalCacheReads || 0).toLocaleString()} read, ${(metrics.totalCacheWrites || 0).toLocaleString()} write\n`,
				)
			}
			if (metrics.totalCacheReads || metrics.totalCacheWrites) {
				process.stderr.write(`Cache Hit Rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%\n`)
			}
			if (metrics.totalCost > 0) {
				process.stderr.write(`Total Cost: $${metrics.totalCost.toFixed(4)}\n`)
			}
			process.stderr.write(`${stderrStyle.dim("-".repeat(40))}\n`)
		}
	}

	return !hasError
}

/**
 * Handle a message in pipe-optimized mode (non-JSON)
 * - Assistant response text (say: "text") is passed to the callback for buffering
 * - Errors go to stderr
 * - Verbose output goes to stderr
 * - Nothing else goes to stdout (stdout is reserved for final result only)
 */
function handleMessageForPipeMode(
	message: DiracMessage,
	state: ExtensionState,
	verbose: boolean,
	yolo: boolean,
	isUpdate?: boolean,
): void {
	const timestamp = message.ts ? `[${new Date(message.ts).toLocaleTimeString("en-GB", { hour12: false })}] ` : ""
	const content = message.content
	const isPartial =
		state.activeVoiceStreamId === message.id || (content.type === DiracMessageType.API_STATUS && state.isApiRequestActive)
	const statusPrefix = verbose ? (isPartial ? "[partial]  " : isUpdate ? "[update]   " : "[complete] ") : ""

	// 1. Handle API Status (Vitals)
	if (content.type === DiracMessageType.API_STATUS) {
		handleApiReqMessage(message, statusPrefix, isUpdate)
		return
	}

	// 2. Handle Markdown (Voice/Reasoning)
	if (content.type === DiracMessageType.MARKDOWN) {
		const label = content.isReasoning ? "Reasoning" : "Assistant"
		if (verbose || !content.isReasoning) {
			if (content.content) {
				const styledLabel = content.isReasoning ? stderrStyle.dim(label) : stderrStyle.assistant(label)
				const styledContent = content.isReasoning
					? stderrStyle.dim(content.content)
					: stderrStyle.assistant(content.content)
				process.stderr.write(
					`${stderrStyle.metadata(`${timestamp}${statusPrefix}`)}${styledLabel}: ${styledContent}\n`,
				)
			}
		}
		return
	}

	// 3. Handle Cards (Work Units)
	if (content.type === DiracMessageType.CARD) {
		const card = content.card
		let extra = ""
		if (card.status === CardStatus.WAITING_FOR_INPUT) {
			if (yolo && card.requireApproval) {
				extra = " [yolo auto-approved]"
			} else {
				extra = " [waiting for input]"
			}
		}

		const statusStr = card.status !== CardStatus.RUNNING ? ` (${card.status})` : ""
		const statusIndicator =
			card.status === CardStatus.SUCCESS
				? stderrStyle.success("✓ ")
				: card.status === CardStatus.ERROR
					? stderrStyle.error("✕ ")
					: ""
		const styledHeader =
			card.status === CardStatus.ERROR
				? stderrStyle.error(card.header)
				: card.status === CardStatus.WAITING_FOR_INPUT
					? stderrStyle.warning(card.header)
					: stderrStyle.tool(card.header, card.icon)
		process.stderr.write(
			`${stderrStyle.metadata(`${timestamp}${statusPrefix}`)}${statusIndicator}${styledHeader}${stderrStyle.metadata(`${statusStr}${extra}`)}\n`,
		)

		if (verbose && card.body && !isTaskCompletionCard(card)) {
			process.stderr.write(`${stderrStyle.toolBody(cardBodyForDisplay(card.body, card.renderType))}\n`)
		}
		return
	}
}

/**
 * Handle formatting and printing of API request messages
 */
function handleApiReqMessage(message: DiracMessage, statusPrefix: string, isUpdate?: boolean): void {
	const timestamp = message.ts ? `[${new Date(message.ts).toLocaleTimeString("en-GB", { hour12: false })}] ` : ""
	const content = message.content
	if (content.type !== DiracMessageType.API_STATUS) return
	const info = content.status

	const hasMetrics = info.cost !== undefined || info.tokensIn !== undefined

	let label = "API request"
	if (hasMetrics) {
		label = "API request finished"
	} else if (info.retryStatus) {
		label = "API request retried"
	} else {
		label = "API request started"
	}

	if (hasMetrics || !isUpdate || info.retryStatus || info.streamingFailedMessage) {
		const costStr = info.cost !== undefined ? `Cost: $${info.cost.toFixed(4)}` : ""
		const tokensStr =
			info.tokensIn !== undefined
				? `Tokens: ${info.tokensIn.toLocaleString()} in, ${(info.tokensOut || 0).toLocaleString()} out${info.reasoningTokens ? ` (+${info.reasoningTokens.toLocaleString()} thinking)` : ""
				}`
				: ""
		const cacheStr =
			info.cacheReads !== undefined || info.cacheWrites !== undefined
				? `Cache: ${(info.cacheReads || 0).toLocaleString()} read, ${(info.cacheWrites || 0).toLocaleString()} write`
				: ""
		const contextUsagePercentage =
			info.contextUsagePercentage ??
			(info.contextWindow && info.tokensIn !== undefined
				? Math.round((info.tokensIn / info.contextWindow) * 100)
				: undefined)
		const contextStr =
			info.contextWindow !== undefined
				? `Context: ${contextUsagePercentage ?? 0}% of ${(info.contextWindow / 1000).toFixed(0)}K`
				: ""

		const retryStr = info.retryStatus
			? ` (Retry ${info.retryStatus.attempt}/${info.retryStatus.maxAttempts}${info.retryStatus.delaySec ? ` in ${info.retryStatus.delaySec}s` : ""}${info.retryStatus.errorSnippet ? `: ${info.retryStatus.errorSnippet}` : ""})`
			: ""

		const metricParts = [tokensStr, cacheStr, contextStr, retryStr.trim(), costStr].filter(Boolean)
		const metricsStr = metricParts.length > 0 ? ` [${metricParts.join(" | ")}]` : ""
		const errorStr = info.streamingFailedMessage
			? `
Error: ${info.streamingFailedMessage}`
			: ""
		const styledLabel = info.streamingFailedMessage ? stderrStyle.error(label) : stderrStyle.api(label)
		process.stderr.write(
			`${stderrStyle.metadata(`${timestamp}${statusPrefix}`)}${styledLabel}${stderrStyle.metadata(metricsStr)}${errorStr}\n`,
		)
	}
}
