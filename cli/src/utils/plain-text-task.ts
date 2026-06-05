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

import { DiracMessage, ExtensionState, DiracMessageType, CardStatus, UIActionButtonType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"

import { StringRequest } from "@shared/proto/dirac/common"
import type { Controller } from "@/core/controller"
import { getRequestRegistry } from "@/core/controller/grpc-handler"
import { subscribeToState } from "@/core/controller/state/subscribeToState"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { emitTaskStartedMessage } from "./task-start-output"
import { getApiMetrics } from "@shared/getApiMetrics"

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

	let completionResolve: (reason?: any) => void
	let completionReject: (reason?: any) => void
	const completionPromise = new Promise<string>((res, rej) => {
		completionResolve = res
		completionReject = rej
	})

	let hasError = false
	let hasEmittedTaskStarted = false
	// Track which messages have been processed (by ID)
	const processedMessages = new Set<string>()
	const lastPrintedCardState = new Map<string, string>()
	const autoApprovedCards = new Set<string>()

	const isViewTaskOnly = Boolean(options.taskId) && !prompt


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
	const processMessage = (message: DiracMessage, state: ExtensionState) => {
		const ts = message.ts || 0
		const content = message.content

		const isStreaming = state.activeVoiceStreamId === message.id || (content.type === DiracMessageType.API_STATUS && state.isApiRequestActive)
		if (isStreaming) {
			// Special case: allow printing the initial api_req_started message even if it's partial
			// so the user knows the request has begun. Subsequent updates will be skipped until complete.
			if (content.type === DiracMessageType.API_STATUS && !processedMessages.has(message.id)) {
				handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
				processedMessages.add(message.id)
				return
			}

			return
		}

		// Message is complete (or is a partial interaction card)
		// Skip if already processed as a complete message
		if (processedMessages.has(message.id)) {
			return
		}

		// JSON mode: stream all messages to stdout (existing behavior)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify(message) + "\n")
		} else {
			// For cards, avoid duplicate printing of the same state (interaction cards are never "streaming" in this mode)
			if (content.type === DiracMessageType.CARD) {
				const card = content.card
				const stateKey = `${card.status}-${card.body}`
				if (lastPrintedCardState.get(message.id) !== stateKey) {
					handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
					lastPrintedCardState.set(message.id, stateKey)
				}
			} else {
				handleMessageForPipeMode(message, state, verbose || false, yolo || false, false)
			}
		}

		// Mark as processed if it's a complete message
		if (!isStreaming) {
			processedMessages.add(message.id)
		}

		// Auto-approve if yolo mode is on and it's an approval request
		if (
			yolo &&
			content.type === DiracMessageType.CARD &&
			content.card.status === CardStatus.WAITING_FOR_INPUT &&
			(content.card.requireApproval || content.card.requireFeedback) &&
			!autoApprovedCards.has(content.card.id)
		) {
			controller.task?.submitCardResponse(content.card.id, DiracAskResponse.APPROVE)
			autoApprovedCards.add(content.card.id)
		}

		// Check for API failure (retries exhausted)
		if (content.type === DiracMessageType.API_STATUS && content.status.cancelReason === "retries_exhausted") {
			completionReject("API request failed: retries exhausted")
		}
	}

	const requestId = "dirac-plain-text-task"
	subscribeToState(
		controller,
		{},
		async ({ stateJson }) => {
			try {
				const state = JSON.parse(stateJson) as ExtensionState
				for (const message of state.diracMessages ?? []) {
					processMessage(message, state)
				}

				// Check for terminal state via UI projection
				const globalButtons = state.uiActionState?.globalButtons || []
				const cardButtons = state.uiActionState?.cardButtons || []
				const hasNewTask = globalButtons.some((b) => b.action === UIActionButtonType.NEW_TASK)
				const hasProceed = globalButtons.some((b) => b.action === UIActionButtonType.PROCEED)

				if (hasNewTask) {
					if (hasProceed) {
						completionReject("Mistake limit reached. Task halted in YOLO mode.")
					} else {
						completionResolve()
					}
				} else if (isViewTaskOnly && cardButtons.length > 0) {
					// Historical task loaded and waiting for interaction (e.g. Resume Task card)
					completionResolve()
				}
			} catch (error) {
				if (jsonOutput) {
					process.stdout.write(
						JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }) +
							"\n",
					)
				} else {
					process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
				}
				completionReject(error)
			}
		},
		requestId,
	)

	try {
		// Either resume an existing task or start a new one
		if (options.taskId) {
			// Load the existing task
			await showTaskWithId(controller, StringRequest.create({ value: options.taskId }))
			emitTaskStarted()

			// If a prompt was provided, send it as a message to the resumed task
			if (prompt && controller.task) {
				// Wait a moment for the task to fully load
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Send the prompt as a response to any pending ask, or as a new message
				await controller.task.submitCardResponse("", DiracAskResponse.MESSAGE, prompt)
			}
		} else if (prompt) {
			// Start a new task with the prompt
			await controller.initTask(prompt, imageDataUrls)
			emitTaskStarted()
		} else {
			throw new Error("Either taskId or prompt must be provided")
		}

		// Wait for task completion, with optional timeout only when explicitly configured
		if (options.timeoutSeconds) {
			const timeoutMs = options.timeoutSeconds * 1000
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Timeout")), timeoutMs),
			)
			await Promise.race([completionPromise, timeoutPromise])
		} else {
			await completionPromise
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify({ type: "error", message: errMsg }) + "\n")
		} else {
			process.stderr.write(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] Error: ${errMsg}\n`)
		}
		hasError = true
	} finally {
		getRequestRegistry().cancelRequest(requestId)
	}

	// non json mode outputs only the final complete message
	if (!jsonOutput) {
		const messages = controller.task?.messageStateHandler.getDiracMessages() || []
		// Prefer the body of the "Task Completed" card
		const completionCard = [...messages]
			.reverse()
			.find((m) => m.content.type === DiracMessageType.CARD && m.content.card.header === "Task Completed")

		if (completionCard && completionCard.content.type === DiracMessageType.CARD) {
			process.stdout.write(completionCard.content.card.body + "\n")
		} else {
			// Fallback to the last markdown message (e.g. if task was interrupted or didn't use attempt_completion)
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
			process.stderr.write(`\n${"-".repeat(40)}\n`)
			process.stderr.write(`Task Summary:\n`)
			process.stderr.write(
				`Tokens: ${metrics.totalTokensIn.toLocaleString()} in, ${metrics.totalTokensOut.toLocaleString()} out${metrics.totalReasoningTokens ? ` (+${metrics.totalReasoningTokens.toLocaleString()} thinking)` : ""}\n`,
			)
			if (metrics.totalCacheReads || metrics.totalCacheWrites) {
				process.stderr.write(
					`Cache: ${(metrics.totalCacheReads || 0).toLocaleString()} read, ${(metrics.totalCacheWrites || 0).toLocaleString()} write\n`,
				)
			}
			if (metrics.totalCost > 0) {
				process.stderr.write(`Total Cost: $${metrics.totalCost.toFixed(4)}\n`)
			}
			process.stderr.write(`${"-".repeat(40)}\n`)
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
	const isPartial = state.activeVoiceStreamId === message.id || (content.type === DiracMessageType.API_STATUS && state.isApiRequestActive)
	const statusPrefix = verbose ? (isPartial ? "[partial]  " : (isUpdate ? "[update]   " : "[complete] ")) : ""

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
				process.stderr.write(`${timestamp}${statusPrefix}${label}: ${content.content}\n`)
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
		process.stderr.write(`${timestamp}${statusPrefix}${card.header}${statusStr}${extra}\n`)
		
		if (verbose && card.body) {
			process.stderr.write(`${card.body}\n`)
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
				? `Tokens: ${info.tokensIn.toLocaleString()} in, ${(info.tokensOut || 0).toLocaleString()} out${
						info.reasoningTokens ? ` (+${info.reasoningTokens.toLocaleString()} thinking)` : ""
					}`
				: ""
		const cacheStr =
			info.cacheReads !== undefined || info.cacheWrites !== undefined
				? ` (Cache: ${(info.cacheReads || 0).toLocaleString()} read, ${(info.cacheWrites || 0).toLocaleString()} write)`
				: ""
		const contextStr =
			info.contextWindow !== undefined
				? ` | Context: ${info.contextUsagePercentage}% of ${(info.contextWindow / 1000).toFixed(0)}K`
				: ""

		const retryStr = info.retryStatus
			? ` (Retry ${info.retryStatus.attempt}/${info.retryStatus.maxAttempts}${info.retryStatus.delaySec ? ` in ${info.retryStatus.delaySec}s` : ""}${info.retryStatus.errorSnippet ? `: ${info.retryStatus.errorSnippet}` : ""})`
			: ""

		const metricsStr = hasMetrics || retryStr ? ` [${tokensStr}${cacheStr || ""}${contextStr || ""}${retryStr} | ${costStr}]` : ""
		const errorStr = info.streamingFailedMessage ? `
Error: ${info.streamingFailedMessage}` : ""
		process.stderr.write(`${timestamp}${statusPrefix}${label}${metricsStr}${errorStr}\n`)
	}
}
