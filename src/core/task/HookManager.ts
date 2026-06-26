import { ApiHandler } from "@core/api"

import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { DiracContent } from "@shared/messages/content"
import { DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { HookExecution } from "./types/HookExecution"
import { HookManagerDependencies, UserPromptHookResult } from "./types/hook-manager"

export class HookManager {
	constructor(private dependencies: HookManagerDependencies) {}

	public setApi(api: ApiHandler) {
		this.dependencies.api = api
	}

	public setUlid(ulid: string) {
		this.dependencies.ulid = ulid
	}

	public async setActiveHookExecution(hookExecution: HookExecution | undefined): Promise<void> {
		await this.dependencies.withStateLock(() => {
			this.dependencies.taskState.activeHookExecution = hookExecution
		})
	}

	public async clearActiveHookExecution(): Promise<void> {
		await this.dependencies.withStateLock(() => {
			this.dependencies.taskState.activeHookExecution = undefined
		})
	}

	public async getActiveHookExecution(): Promise<HookExecution | undefined> {
		return await this.dependencies.withStateLock(() => {
			return this.dependencies.taskState.activeHookExecution
		})
	}

	public async cancelHookExecution(): Promise<boolean> {
		const activeHook = await this.getActiveHookExecution()
		if (!activeHook) {
			return false
		}

		const { hookName, toolName, messageId, abortController } = activeHook

		try {
			// Abort the hook process
			abortController.abort()

			// Update hook message status to "cancelled"
			const hookMessageIndex = this.dependencies.messageStateHandler.findMessageIndexById(messageId)
			if (hookMessageIndex !== -1) {
				const cancelledMetadata = {
					hookName,
					toolName,
					status: "cancelled",
					exitCode: 130, // Standard SIGTERM exit code
				}
				await this.dependencies.messageStateHandler.updateDiracMessage(hookMessageIndex, {
					content: { type: DiracMessageType.MARKDOWN, content: JSON.stringify(cancelledMetadata) },
				})
			}

			// Notify UI that hook was cancelled
			await this.dependencies.taskMessenger.upsertText("\nHook execution cancelled by user")

			// Return success - let caller (abortTask) handle next steps
			return true
		} catch (error) {
			Logger.error("Failed to cancel hook execution", error)
			return false
		}
	}

	public async shouldRunTaskCancelHook(): Promise<boolean> {
		// Atomically check for active hook execution (work happening now)
		const activeHook = await this.getActiveHookExecution()
		if (activeHook) {
			return true
		}

		// Run if the API is currently streaming (work happening now)
		if (this.dependencies.taskState.isApiRequestActive || !!this.dependencies.taskState.activeVoiceStreamId) {
			return true
		}

		// Run if we're waiting for the first chunk (work happening now)
		if (this.dependencies.taskState.isWaitingForFirstChunk) {
			return true
		}

		// Run if there's active background command (work happening now)
		if (this.dependencies.shouldRunBackgroundCheck()) {
			return true
		}

		// Check if we're at a button-only state (no active work, just waiting for user action)
		const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
		const lastMessage = diracMessages.at(-1)
		const isAtButtonOnlyState =
			this.dependencies.taskState.status === TaskStatus.CANCELLED ||
			(lastMessage?.content.type === "card" && lastMessage.content.card.header === "Task Completed")

		if (isAtButtonOnlyState) {
			// At button-only state - DON'T run hook because we're just waiting for user input
			// These button states appear when:
			// 1. Opening from history (resume_task/resume_completed_task)
			// 2. After task completion (completion_result with "Start New Task" button)
			// 3. After cancelling during active work (but work already stopped)
			// In all cases, we shouldn't run TaskCancel hook
			return false
		}

		// Not at a button-only state - we're in the middle of work or just finished something
		// Run the hook since cancelling would interrupt actual work
		return true
	}

	public async handleHookCancellation(hookName: string, wasCancelled: boolean): Promise<void> {
		// ALWAYS save state, regardless of cancellation source
		this.dependencies.taskState.didFinishAbortingStream = true

		// Save conversation state to disk
		await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		await this.dependencies.messageStateHandler.overwriteApiConversationHistory(
			this.dependencies.messageStateHandler.getApiConversationHistory(),
		)

		// Update UI
		await this.dependencies.postStateToWebview()

		// Log for debugging/telemetry
		Logger.log(`[Task ${this.dependencies.taskId}] ${hookName} hook cancelled (userInitiated: ${wasCancelled})`)
	}

	public async runUserPromptSubmitHook(
		userContent: DiracContent[],
		_context: "initial_task" | "resume" | "feedback",
	): Promise<UserPromptHookResult> {
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))

		if (!hooksEnabled) {
			return {}
		}

		const { extractUserPromptFromContent } = await import("./utils/extractUserPromptFromContent")

		// Extract clean user prompt from content, stripping system wrappers and metadata
		const promptText = extractUserPromptFromContent(userContent)

		const userPromptResult = await executeHook({
			hookName: "UserPromptSubmit",
			hookInput: {
				userPromptSubmit: {
					prompt: promptText,
					attachments: [],
				},
			},
			isCancellable: true,
			messenger: this.dependencies.taskMessenger,
			setActiveHookExecution: this.setActiveHookExecution.bind(this),
			clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
			messageStateHandler: this.dependencies.messageStateHandler,
			taskId: this.dependencies.taskId,
			hooksEnabled,
			model: getHookModelContext(this.dependencies.api!, this.dependencies.stateManager),
		})

		// Handle cancellation from hook
		if (userPromptResult.cancel === true && userPromptResult.wasCancelled) {
			// Set flag to allow Controller.cancelTask() to proceed
			this.dependencies.taskState.didFinishAbortingStream = true
			// Save BOTH files so Controller.cancelTask() can find the task
			await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.dependencies.messageStateHandler.overwriteApiConversationHistory(
				this.dependencies.messageStateHandler.getApiConversationHistory(),
			)
			await this.dependencies.postStateToWebview()
		}

		return {
			cancel: userPromptResult.cancel,
			contextModification: userPromptResult.contextModification,
			errorMessage: userPromptResult.errorMessage,
		}
	}
}
