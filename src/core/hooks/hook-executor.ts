import { CardStatus, DiracMessageType, type HookOutputStreamMeta } from "@shared/ExtensionMessage"
import type { HookOutput } from "@shared/proto/dirac/hooks"
import { Logger } from "@/shared/services/Logger"
import { MessageStateHandler } from "../task/message-state"
import { HookExecutionError } from "./HookError"
import type { HookModelInputContext, Hooks } from "./hook-factory"

import { HookFactory } from "./hook-factory"

import { ITaskMessenger } from "@shared/ExtensionMessage"




export interface HookExecutionOptions<Name extends keyof Hooks = any> {
	hookName: Name
	hookInput: Hooks[Name]
	isCancellable: boolean
	messenger: ITaskMessenger

	setActiveHookExecution?: (execution: {
		hookName: string
		toolName: string | undefined
		messageId: string

		abortController: AbortController
	}) => Promise<void>
	clearActiveHookExecution?: () => Promise<void>
	messageStateHandler: MessageStateHandler
	taskId: string
	hooksEnabled: boolean
	model?: HookModelInputContext
	toolName?: string // Optional tool name for PreToolUse/PostToolUse hooks
	pendingToolInfo?: any // Optional metadata about pending tool execution for PreToolUse
}



export interface HookExecutionResult {
	cancel?: boolean
	contextModification?: string
	errorMessage?: string
	wasCancelled: boolean
}

function fromHookOutput(output: HookOutput): HookExecutionResult {
	// HookOutput is protobuf-generated, so fields are defaulted (e.g. ""). Treat empty
	// strings as “unset” in the hook executor API.
	const contextModification = output.contextModification?.trim() ? output.contextModification : undefined
	const errorMessage = output.errorMessage?.trim() ? output.errorMessage : undefined

	return {
		cancel: output.cancel,
		contextModification,
		errorMessage,
		wasCancelled: false,
	}
}

/**
 * Executes a hook with standardized error handling, status tracking, and cleanup.
 * This consolidates the common pattern used across all hook execution sites.
 */
export async function executeHook<Name extends keyof Hooks>(options: HookExecutionOptions<Name>): Promise<HookExecutionResult> {
	const {
		hookName,
		hookInput,
		isCancellable,
		messenger,

		setActiveHookExecution,
		clearActiveHookExecution,
		messageStateHandler,
		taskId,
		hooksEnabled,
	} = options

	// Early return if hooks are disabled
	if (!hooksEnabled) {
		return {
			wasCancelled: false,
		}
	}

	// Check if the hook exists
	const hookFactory = new HookFactory()
	const hasHook = await hookFactory.hasHook(hookName)

	if (!hasHook) {
		return { wasCancelled: false }
	}

	let hookMessageId: string | undefined
	const abortController = new AbortController()

	// Declare hookInfo with empty default - populated inside try block.
	// If getHookInfo throws, error handlers will use the empty default.
	let hookInfo: { scriptPaths: string[] } = { scriptPaths: [] }

	try {
		// Get hook info including script paths
		hookInfo = await hookFactory.getHookInfo(hookName)

		// Show hook execution indicator and capture timestamp
		const hookMetadata = {
			hookName,
			...(options.toolName && { toolName: options.toolName }),
			status: "running",
			scriptPaths: hookInfo.scriptPaths,
			...(options.pendingToolInfo && { pendingToolInfo: options.pendingToolInfo }),
		}
		const cardHandle = await messenger.createCard({
			header: `${hookName} Hook`,
			status: CardStatus.RUNNING,
			body: JSON.stringify(hookMetadata),
		})
		hookMessageId = cardHandle.id


		// Reorder messages immediately so hook UI appears above tool UI
		// This must happen right after creating the hook message, before the hook runs
		if (hookName === "PreToolUse") {
			await reorderHookAndToolMessages(messageStateHandler)
		}

		// Track active hook execution for cancellation (only if cancellable and message was created)
		if (isCancellable && hookMessageId !== undefined && setActiveHookExecution) {
			await setActiveHookExecution({
				hookName,
				toolName: options.toolName,
				messageId: hookMessageId,
				abortController,
			})
		}

		// Create streaming callback
		const streamCallback = async (line: string, stream: "stdout" | "stderr", meta?: HookOutputStreamMeta) => {
			// Preserve script identity for multi-hook (global + workspace) scenarios.
			// Without this, concurrent hooks interleave output and it's hard to tell which
			// script produced which line (and can look like only one hook is printing).
			//
			// NOTE: We keep backward compatibility by encoding metadata into the string.
			// The CLI prints this as-is in verbose mode.
			const prefixParts: string[] = []
			if (meta?.source) prefixParts.push(meta.source)
			prefixParts.push(stream)
			// Use a shortened path for readability; full path is still available in hook_status.
			if (meta?.scriptPath) {
				const parts = meta.scriptPath.split(/[/\\]/).filter(Boolean)
				prefixParts.push(parts.slice(-3).join("/"))
			}
			const prefix = prefixParts.length ? `[${prefixParts.join(" ")}] ` : ""
			await messenger.upsertText(prefix + line)

		}

		// Create and execute hook
		const hook = await hookFactory.createWithStreaming(
			hookName,
			streamCallback,
			isCancellable ? abortController.signal : undefined,
			taskId,
			options.toolName,
		)

		const result = await hook.run({
			taskId,
			...hookInput,
			model: options.model,
		})

		Logger.log(`[${hookName} Hook]`, result)

		// NoOp hooks return proto defaults; preserve the minimal legacy return shape.
		if (result.cancel === false && result.contextModification === "" && result.errorMessage === "") {
			return { wasCancelled: false }
		}

		// Check if hook wants to cancel
		if (result.cancel === true) {
			// Update hook status to cancelled
			if (hookMessageId !== undefined) {
				await updateHookMessage(messageStateHandler, hookMessageId, {
					hookName,
					...(options.toolName && { toolName: options.toolName }),
					status: "cancelled",
					exitCode: 130,
					hasJsonResponse: true,
					scriptPaths: hookInfo.scriptPaths,
				})
			}

			return fromHookOutput(result)
		}

		// Clear active hook execution after successful completion (only if cancellable)
		if (isCancellable && clearActiveHookExecution) {
			await clearActiveHookExecution()
		}

		// Update hook status to completed (only if not cancelled)
		if (hookMessageId !== undefined) {
			await updateHookMessage(messageStateHandler, hookMessageId, {
				hookName,
				...(options.toolName && { toolName: options.toolName }),
				status: "completed",
				exitCode: 0,
				hasJsonResponse: true,
				scriptPaths: hookInfo.scriptPaths,
			})
		}

		return fromHookOutput(result)
	} catch (hookError) {
		// Clear active hook execution (only if cancellable)
		if (isCancellable && clearActiveHookExecution) {
			await clearActiveHookExecution()
		}

		// Check if this was a user cancellation via abort controller
		if (abortController.signal.aborted) {
			// Update hook status to cancelled
			if (hookMessageId !== undefined) {
				await updateHookMessage(messageStateHandler, hookMessageId, {
					hookName,
					status: "cancelled",
					exitCode: 130,
					scriptPaths: hookInfo.scriptPaths,
				})
			}

			return {
				cancel: true,
				wasCancelled: true,
			}
		}

		// Update hook status to failed for actual errors
		// Extract structured error info if available
		const isStructuredError = HookExecutionError.isHookError(hookError)
		const errorInfo = isStructuredError ? hookError.errorInfo : null

		if (hookMessageId !== undefined) {
			await updateHookMessage(messageStateHandler, hookMessageId, {
				hookName,
				status: "failed",
				exitCode: errorInfo?.exitCode ?? 1,
				scriptPaths: hookInfo.scriptPaths,
				...(errorInfo && {
					error: {
						type: errorInfo.type,
						message: errorInfo.message,
						details: errorInfo.details,
						scriptPath: errorInfo.scriptPath,
					},
				}),
			})
		}

		// Log error for non-cancellable hooks or unexpected errors
		Logger.error(`${hookName} hook failed:`, hookError)

		// Return safe defaults for all fields to avoid undefined property access
		return {
			cancel: false,
			contextModification: undefined,
			errorMessage: undefined,
			wasCancelled: false,
		}
	}
}

/**
 * Helper to update hook message status in message state
 */
async function updateHookMessage(
	messageStateHandler: MessageStateHandler,
	hookMessageId: string,
	metadata: Record<string, any>,
): Promise<void> {
	const index = messageStateHandler.findMessageIndexById(hookMessageId)
	if (index !== -1) {
		const msg = messageStateHandler.getDiracMessages()[index]
		if (msg.content.type === DiracMessageType.CARD) {
			msg.content.card.body = JSON.stringify(metadata)
			msg.content.card.status = metadata.status === "completed" ? CardStatus.SUCCESS : 
									 metadata.status === "failed" ? CardStatus.ERROR :
									 metadata.status === "cancelled" ? CardStatus.CANCELLED : CardStatus.RUNNING
			await messageStateHandler.updateDiracMessage(index, msg)
		}
	}
}

/**
 * Reorders hook and tool messages so hook UI appears before tool UI.
 * This is called immediately after a hook message is created.
 */
async function reorderHookAndToolMessages(messageStateHandler: MessageStateHandler): Promise<void> {
	const diracMessages = messageStateHandler.getDiracMessages()

	// Find the most recent tool message (Card with a tool-like header)
	let lastToolMessageIndex = -1
	for (let i = diracMessages.length - 1; i >= 0; i--) {
		const msg = diracMessages[i]
		if (msg.content.type === DiracMessageType.CARD && !msg.content.card.header.startsWith("Hook:")) {
			lastToolMessageIndex = i
			break
		}
	}

	if (lastToolMessageIndex === -1) {
		return // No tool message found, nothing to reorder
	}

	// Check if there are any hook messages after the tool message
	let hasHookMessagesAfterTool = false
	for (let i = lastToolMessageIndex + 1; i < diracMessages.length; i++) {
		const msg = diracMessages[i]
		if (msg.content.type === DiracMessageType.CARD && msg.content.card.header.startsWith("Hook:")) {
			hasHookMessagesAfterTool = true
			break
		}
	}

	if (!hasHookMessagesAfterTool) {
		return // No reordering needed
	}

	// Store the tool message (deep copy to preserve all properties)
	const toolMessage = { ...diracMessages[lastToolMessageIndex] }

	// Delete the tool message at its current position
	await messageStateHandler.deleteDiracMessage(lastToolMessageIndex)

	// Re-add the tool message at the end (after hook messages)
	await messageStateHandler.addToDiracMessages(toolMessage)
}
