import { formatResponse } from "@core/formatResponse"
import { executeHook } from "@core/hooks/hook-executor"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import {
	ensureTaskDirectoryExists,
	getSavedApiConversationProviderState,
	getSavedApiConversationState,
	getSavedPresentationHistory,
	getTaskMetadata,
} from "@core/storage/disk"
import { HostProvider } from "@hosts/host-provider"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import type { BrowserSession } from "@services/browser/BrowserSession"
import { findLastIndex } from "@shared/array"
import { isResumePromptCard, isSuccessfulTaskCompletionCard } from "@shared/cardIdentity"
import {
	DiracContent,
	DiracImageContentBlock,
	DiracUserContent,
	removeUserInputMarkersFromMessage,
} from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import pWaitFor from "p-wait-for"
import { CardStatus, DiracMessageType, TaskStatus } from "@/shared/ExtensionMessage"
import { getErrorMessage } from "@/shared/errors"
import { getTaskHookModelContext } from "./runtime/TaskRuntimeModelContext"
import { releaseTaskLock } from "./TaskLockUtils"
import type { TaskRunOutcome } from "./TaskRunOutcome"
import { LifecycleManagerDependencies } from "./types/lifecycle-manager"
import { buildUserFeedbackContent } from "./utils/buildUserFeedbackContent"

export interface ResumeTaskOptions {
	/** Synthetic context for the first resumed model turn; never rendered or marked as user input. */
	systemContext?: string
	/** User-authored content that starts the resumed turn without waiting for an interaction callback. */
	initialUserInput?: {
		text: string
		images?: string[]
		files?: string[]
	}
}

export class LifecycleManager {
	private abortPromise?: Promise<void>
	private ownedResourceCleanupPromise?: Promise<void>

	constructor(private dependencies: LifecycleManagerDependencies) {}

	setApi(api: LifecycleManagerDependencies["api"]): void {
		this.dependencies.api = api
	}

	setBrowserSession(browserSession: BrowserSession): void {
		this.dependencies.browserSession = browserSession
	}

	private getOperationalApi(): LifecycleManagerDependencies["api"] {
		return this.dependencies.getRequestRuntime()?.api ?? this.dependencies.api
	}

	public async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		if (
			!isFirstRequest ||
			!this.dependencies.getWorkingConfiguration().settings.enableCheckpointsSetting ||
			!this.dependencies.checkpointManager ||
			!this.dependencies.checkpointManager.isEnabled() ||
			this.dependencies.taskState.checkpointManagerErrorMessage
		) {
			return
		}

		try {
			await ensureCheckpointInitialized({ checkpointManager: this.dependencies.checkpointManager })
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Unknown error")
			Logger.error("Failed to initialize checkpoint manager:", errorMessage)
			this.dependencies.taskState.checkpointManagerErrorMessage = errorMessage // will be displayed right away since we saveDiracMessages next which posts state to webview
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Checkpoint initialization timed out: ${errorMessage}`,
			})
		}

		// Now, if checkpoints are enabled AND tracker was successfully initialized,
		// then say "checkpoint_created" and perform the commit.
		if (!this.dependencies.taskState.checkpointManagerErrorMessage) {
			await this.dependencies.taskMessenger.createCheckpoint()
			const messages = this.dependencies.messageStateHandler.getDiracMessages()
			const lastCheckpointMessageIndex = findLastIndex(messages, (m) => m.content.type === DiracMessageType.CHECKPOINT)
			if (lastCheckpointMessageIndex !== -1) {
				const commitPromise = this.dependencies.checkpointManager!.commit()
				// Store the initial commit promise in Task for unsafe tools to wait on
				// We'll need to expose this or handle it differently.
				// In Task, it was: this.initialCheckpointCommitPromise = commitPromise
				// I'll add a way to set it in Task or just keep it here if it's only used for tools.
				// Wait, ToolExecutor needs it. I'll add it to TaskState or pass it back.
				// Let's add it to TaskState for simplicity as it's a transient state.
				this.dependencies.taskState.initialCheckpointCommitPromise = commitPromise

				commitPromise
					?.then(async (commitHash) => {
						if (commitHash) {
							await this.dependencies.messageStateHandler.updateDiracMessage(lastCheckpointMessageIndex, {
								lastCheckpointHash: commitHash,
							})
						}
					})
					.catch((error) => {
						Logger.error(
							`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.dependencies.taskId}:`,
							error,
						)
					})
			}
		}
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<TaskRunOutcome | undefined> {
		try {
			await this.dependencies.diracIgnoreController.initialize()
			await this.dependencies.commandPermissionController.initialize(this.dependencies.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}
		this.dependencies.messageStateHandler.setDiracMessages([])
		this.dependencies.messageStateHandler.setApiConversationHistory([])
		this.dependencies.messageStateHandler.setApiConversationProviderState({})

		await this.dependencies.postStateToWebview()

		await this.dependencies.taskMessenger.upsertText(task || "", false, images, files, "user")

		this.dependencies.taskState.isInitialized = true

		const imageBlocks: DiracImageContentBlock[] = formatResponse.imageBlocks(images)

		const userContent: DiracUserContent[] = [
			{
				type: "text",
				isUserInput: true,
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		]

		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
		if (hooksEnabled) {
			const taskStartResult = await executeHook({
				hookName: "TaskStart",
				hookInput: {
					taskStart: {
						taskMetadata: {
							taskId: this.dependencies.taskId,
							ulid: this.dependencies.ulid,
							initialTask: task || "",
						},
					},
				},
				isCancellable: true,
				messenger: this.dependencies.taskMessenger,
				setActiveHookExecution: this.dependencies.hookManager.setActiveHookExecution.bind(this.dependencies.hookManager),
				clearActiveHookExecution: this.dependencies.hookManager.clearActiveHookExecution.bind(
					this.dependencies.hookManager,
				),
				messageStateHandler: this.dependencies.messageStateHandler,
				taskId: this.dependencies.taskId,
				hooksEnabled,
				model: getTaskHookModelContext(
					this.getOperationalApi(),
					this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration(),
				),
			})

			if (taskStartResult.cancel === true) {
				await this.dependencies.hookManager.handleHookCancellation("TaskStart", taskStartResult.wasCancelled || false)
				await this.dependencies.cancelTask()
				return
			}

			if (taskStartResult.contextModification) {
				const contextText = taskStartResult.contextModification.trim()
				if (contextText) {
					userContent.push({
						type: "text",
						text: `<hook_context source="TaskStart">\n${contextText}\n</hook_context>`,
					})
				}
			}
		}

		if (this.dependencies.taskState.abort) {
			return
		}

		const userPromptHookResult = await this.dependencies.hookManager.runUserPromptSubmitHook(userContent, "initial_task")

		if (this.dependencies.taskState.abort) {
			return
		}

		if (userPromptHookResult.cancel === true) {
			await this.dependencies.hookManager.handleHookCancellation(
				"UserPromptSubmit",
				userPromptHookResult.wasCancelled ?? false,
			)
			await this.dependencies.cancelTask()
			return
		}

		if (userPromptHookResult.contextModification) {
			userContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		try {
			await this.dependencies.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata:", error)
		}

		return await this.dependencies.initiateTaskLoop(userContent)
	}

	public async resumeTaskFromHistory(
		onRestored?: () => void,
		options: ResumeTaskOptions = {},
	): Promise<TaskRunOutcome | undefined> {
		try {
			await this.dependencies.diracIgnoreController.initialize()
			await this.dependencies.commandPermissionController.initialize(this.dependencies.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}
		if (this.dependencies.taskState.abort) return

		const savedPresentation = await getSavedPresentationHistory(this.dependencies.taskId)
		const savedDiracMessages = savedPresentation.messages
		this.dependencies.messageStateHandler.setDiracMessages(savedDiracMessages, savedPresentation.lastOffset)
		if (this.dependencies.taskState.abort) return

		const lastRelevantMessageIndex = findLastIndex(
			savedDiracMessages,
			(m) => !(m.content.type === DiracMessageType.CARD && isResumePromptCard(m.content.card)),
		)
		if (lastRelevantMessageIndex !== -1) {
			savedDiracMessages.splice(lastRelevantMessageIndex + 1)
		}

		const lastApiReqStartedIndex = findLastIndex(savedDiracMessages, (m) => m.content.type === "api_status")
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = savedDiracMessages[lastApiReqStartedIndex]
			if (lastApiReqStarted.content.type === "api_status") {
				const { cost, cancelReason } = lastApiReqStarted.content.status
				if (cost === undefined && cancelReason === undefined) {
					savedDiracMessages.splice(lastApiReqStartedIndex, 1)
				}
			}
		}

		await this.dependencies.messageStateHandler.overwriteDiracMessages(savedDiracMessages)
		if (this.dependencies.taskState.abort) return
		const persistedPresentation = await getSavedPresentationHistory(this.dependencies.taskId)
		if (this.dependencies.taskState.abort) return
		this.dependencies.messageStateHandler.setDiracMessages(persistedPresentation.messages, persistedPresentation.lastOffset)

		const savedApiConversation = await getSavedApiConversationState(this.dependencies.taskId)
		const savedApiConversationHistory = savedApiConversation.messages.map(removeUserInputMarkersFromMessage)
		if (this.dependencies.taskState.abort) return
		this.dependencies.messageStateHandler.setApiConversationHistory(
			savedApiConversationHistory as any,
			savedApiConversation.lastOffset,
		)
		this.dependencies.messageStateHandler.setApiConversationProviderState(
			await getSavedApiConversationProviderState(this.dependencies.taskId),
		)
		if (this.dependencies.taskState.abort) return
		this.dependencies.restoreQueuedSteeringFromTranscript()

		await ensureTaskDirectoryExists(this.dependencies.taskId)
		if (this.dependencies.taskState.abort) return

		// Restore task-scoped tools from the task directory
		const { refreshTaskTools } = await import("@core/task/tools/registry/refreshToolRegistry")
		this.dependencies.taskState.taskScopedToolIds = await refreshTaskTools(this.dependencies.taskId)
		if (this.dependencies.taskState.abort) return
		const taskMetadata = await getTaskMetadata(this.dependencies.taskId)
		if (this.dependencies.taskState.abort) return
		this.dependencies.taskState.activeSkillIds = taskMetadata.active_skill_ids ?? []

		// Trailing user-authored messages are follow-ups submitted after the run
		// ended; they must not flip a completed restore to CANCELLED.
		const lastDiracMessage = this.dependencies.messageStateHandler
			.getDiracMessages()
			.slice()
			.reverse()
			.find(
				(m) =>
					!(m.content.type === DiracMessageType.CARD && isResumePromptCard(m.content.card)) &&
					!(m.content.type === DiracMessageType.MARKDOWN && m.content.role === "user"),
			)

		this.dependencies.taskState.isInitialized = true
		this.dependencies.taskState.abort = false

		const completedTask =
			lastDiracMessage?.content.type === DiracMessageType.CARD &&
			isSuccessfulTaskCompletionCard(lastDiracMessage.content.card)
		// Reset askResponse state before waiting. Completed tasks remain available for
		// follow-up messages just like cancelled tasks; only their displayed status differs.
		this.dependencies.taskState.askResponse = undefined
		this.dependencies.taskState.askResponseText = undefined
		this.dependencies.taskState.askResponseImages = undefined
		this.dependencies.taskState.askResponseFiles = undefined

		this.dependencies.taskState.status = completedTask ? TaskStatus.COMPLETED : TaskStatus.CANCELLED
		await this.dependencies.postStateToWebview()
		onRestored?.()

		if (options.systemContext === undefined && options.initialUserInput === undefined) {
			await pWaitFor(() => this.dependencies.taskState.askResponse !== undefined || this.dependencies.taskState.abort, {
				interval: 100,
			})
		}

		if (this.dependencies.taskState.abort) return

		const response = options.initialUserInput ? DiracAskResponse.MESSAGE : this.dependencies.taskState.askResponse
		const text = options.initialUserInput?.text ?? this.dependencies.taskState.askResponseText
		const images = options.initialUserInput?.images ?? this.dependencies.taskState.askResponseImages
		const files = options.initialUserInput?.files ?? this.dependencies.taskState.askResponseFiles

		const newUserContent: DiracContent[] = []

		if (options.systemContext !== undefined) {
			newUserContent.push({
				type: "text",
				text: `<system_context source="task_resume">\n${options.systemContext}\n</system_context>`,
			})
		}
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
		if (hooksEnabled) {
			const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
			const taskResumeResult = await executeHook({
				hookName: "TaskResume",
				hookInput: {
					taskResume: {
						taskMetadata: {
							taskId: this.dependencies.taskId,
							ulid: this.dependencies.ulid,
						},
						previousState: {
							lastMessageTs: lastDiracMessage?.ts?.toString() || "",
							messageCount: diracMessages.length.toString(),
							conversationHistoryDeleted: (
								this.dependencies.taskState.conversationHistoryDeletedRange !== undefined
							).toString(),
						},
					},
				},
				isCancellable: true,
				messenger: this.dependencies.taskMessenger,
				setActiveHookExecution: this.dependencies.hookManager.setActiveHookExecution.bind(this.dependencies.hookManager),
				clearActiveHookExecution: this.dependencies.hookManager.clearActiveHookExecution.bind(
					this.dependencies.hookManager,
				),
				messageStateHandler: this.dependencies.messageStateHandler,
				taskId: this.dependencies.taskId,
				hooksEnabled,
				model: getTaskHookModelContext(
					this.getOperationalApi(),
					this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration(),
				),
			})

			if (taskResumeResult.cancel === true) {
				await this.dependencies.hookManager.handleHookCancellation("TaskResume", taskResumeResult.wasCancelled || false)
				await this.dependencies.cancelTask()
				return
			}

			if (taskResumeResult.contextModification) {
				newUserContent.push({
					type: "text",
					text: `<hook_context source="TaskResume" type="general">\n${taskResumeResult.contextModification}\n</hook_context>`,
				})
			}
		}

		if (this.dependencies.taskState.abort) {
			return
		}

		let responseText: string | undefined
		let responseImages: string[] | undefined
		let responseFiles: string[] | undefined
		if (response === DiracAskResponse.MESSAGE || text || (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0) {
			await this.dependencies.taskMessenger.upsertText(text || "", false, images, files, "user")
			responseText = text
			responseImages = images
			responseFiles = files
		}

		const existingApiConversationHistory = this.dependencies.messageStateHandler.getApiConversationHistory()
		let modifiedOldUserContent: DiracContent[]
		let modifiedApiConversationHistory: any[]
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
			if (lastMessage.role === "assistant") {
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else if (lastMessage.role === "user") {
				const existingUserContent: DiracContent[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
				modifiedOldUserContent = [...existingUserContent]
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			modifiedApiConversationHistory = []
			modifiedOldUserContent = []
		}

		const providerState = this.dependencies.messageStateHandler.getApiConversationProviderState()
		if (
			providerState.checkpoint &&
			providerState.checkpoint.compactedThroughHistoryIndex >= modifiedApiConversationHistory.length
		) {
			await this.dependencies.messageStateHandler.overwriteApiConversationProviderState({
				...providerState,
				checkpoint: undefined,
			})
		}

		newUserContent.push(...modifiedOldUserContent)

		const agoText = (() => {
			const timestamp = lastDiracMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)
			if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`
			if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`
			if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			return "just now"
		})()

		const wasRecent = lastDiracMessage?.ts && Date.now() - lastDiracMessage.ts < 30_000
		const pendingContextWarning = await this.dependencies.fileContextTracker.retrieveAndClearPendingFileContextWarning()
		const hasPendingFileContextWarnings = pendingContextWarning && pendingContextWarning.length > 0
		const mode = this.dependencies.getWorkingConfiguration().settings.mode
		const [taskResumptionMessage, userResponseMessage] = formatResponse.taskResumption(
			mode === "plan" ? "plan" : "act",
			agoText,
			this.dependencies.cwd,
			wasRecent,
			responseText,
			hasPendingFileContextWarnings,
		)

		if (taskResumptionMessage !== "") {
			newUserContent.push({
				type: "text",
				text: taskResumptionMessage,
			})
		}
		if (userResponseMessage !== "") {
			newUserContent.push({
				type: "text",
				isUserInput: true,
				text: userResponseMessage,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		if (responseFiles && responseFiles.length > 0) {
			const fileContentString = await processFilesIntoText(responseFiles)
			if (fileContentString) {
				newUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		if (pendingContextWarning && pendingContextWarning.length > 0) {
			const fileContextWarning = formatResponse.fileContextWarning(pendingContextWarning)
			newUserContent.push({
				type: "text",
				text: fileContextWarning,
			})
		}

		if (options.systemContext === undefined || options.initialUserInput !== undefined) {
			const userFeedbackContent = await buildUserFeedbackContent(responseText, responseImages, responseFiles)
			const userPromptHookResult = await this.dependencies.hookManager.runUserPromptSubmitHook(
				userFeedbackContent,
				"resume",
			)

			if (this.dependencies.taskState.abort) return
			if (userPromptHookResult.cancel === true) {
				await this.dependencies.cancelTask()
				return
			}
			if (userPromptHookResult.contextModification) {
				newUserContent.push({
					type: "text",
					text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
				})
			}
		}

		try {
			await this.dependencies.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata on resume:", error)
		}

		await this.dependencies.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		return await this.dependencies.initiateTaskLoop(newUserContent)
	}

	public async abortTask() {
		this.abortPromise ??= this.performAbortTask()
		try {
			await this.abortPromise
		} finally {
			await this.dependencies.messageStateHandler.flushPendingWrites()
		}
	}

	/** Await cancellation teardown, or release normal terminal ownership when no abort is active. */
	public async finalizeTaskRun(): Promise<void> {
		if (this.abortPromise) {
			await this.abortPromise
		} else {
			await this.releaseOwnedTaskResources()
		}
		await this.dependencies.messageStateHandler.flushPendingWrites()
	}

	private async performAbortTask() {
		this.dependencies.taskState.abort = true
		const abortFailures: unknown[] = []
		const cleanupFailures: unknown[] = []

		try {
			this.getOperationalApi().abort?.()
			const shouldRunTaskCancelHook = await this.dependencies.hookManager.shouldRunTaskCancelHook()

			const activeHook = await this.dependencies.hookManager.getActiveHookExecution()
			if (activeHook) {
				try {
					await this.dependencies.hookManager.cancelHookExecution()
					await this.dependencies.hookManager.clearActiveHookExecution()
				} catch (error) {
					Logger.error("Failed to cancel hook during task abort", error)
					await this.dependencies.hookManager.clearActiveHookExecution()
				}
			}

			if (this.dependencies.commandExecutor.hasActiveBackgroundCommand()) {
				try {
					await this.dependencies.commandExecutor.cancelBackgroundCommand()
				} catch (error) {
					Logger.error("Failed to cancel background command during task abort", error)
				}
			}

			const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
			if (hooksEnabled && shouldRunTaskCancelHook) {
				try {
					await executeHook({
						hookName: "TaskCancel",
						hookInput: {
							taskCancel: {
								taskMetadata: {
									taskId: this.dependencies.taskId,
									ulid: this.dependencies.ulid,
									completionStatus: this.dependencies.taskState.abandoned ? "abandoned" : "cancelled",
								},
							},
						},
						isCancellable: false,
						messenger: this.dependencies.taskMessenger,
						messageStateHandler: this.dependencies.messageStateHandler,
						taskId: this.dependencies.taskId,
						hooksEnabled,
						model: getTaskHookModelContext(
							this.getOperationalApi(),
							this.dependencies.getRequestRuntime()?.workingConfiguration ??
								this.dependencies.getWorkingConfiguration(),
						),
					})
				} catch (error) {
					Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
				}
			}

			// Update any stale auto-retry cards whose delay was still in progress.
			// Without this, the "Retrying in" body persists because the task loop
			// never reached the post-delay abort check.
			for (const msg of this.dependencies.messageStateHandler.getDiracMessages()) {
				if (
					msg.content.type === DiracMessageType.CARD &&
					msg.content.card.header === "API Error (Retrying)" &&
					(msg.content.card.status === CardStatus.PENDING || msg.content.card.status === CardStatus.ERROR)
				) {
					const attempt = msg.content.card.body?.match(/attempt (\d+\/\d+)/)?.[1] ?? "?/?"
					await this.dependencies.messageStateHandler.patchCardById(msg.content.card.id, {
						header: "API Error (Cancelled)",
						body: "API Error (attempt " + attempt + "). Cancelled.",
						status: CardStatus.CANCELLED,
						endTime: Date.now(),
					})
				}
			}
			try {
				await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				await this.dependencies.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post state after setting abort flag", error)
			}
		} catch (error) {
			abortFailures.push(error)
		} finally {
			try {
				await this.releaseOwnedTaskResources()
			} catch (error) {
				cleanupFailures.push(error)
			}

			this.dependencies.taskState.endApiRequest()
			this.dependencies.taskState.endFirstChunkWait()
			this.dependencies.taskState.markStreamAbortFinished()
			this.dependencies.taskState.status = TaskStatus.CANCELLED

			try {
				await this.dependencies.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post final state after abort", error)
			}
		}

		const failures = [...abortFailures, ...cleanupFailures]
		if (failures.length === 1) {
			throw failures[0]
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, "Task abort failed")
		}
	}

	private releaseOwnedTaskResources(): Promise<void> {
		this.ownedResourceCleanupPromise ??= this.performOwnedResourceCleanup()
		return this.ownedResourceCleanupPromise
	}

	private async performOwnedResourceCleanup(): Promise<void> {
		const failures: unknown[] = []
		try {
			const { ToolRegistry } = await import("@core/task/tools/registry/ToolRegistry")
			await ToolRegistry.withExclusiveAccess((registry) => {
				registry.removeTaskTools(this.dependencies.taskId)
			})
			this.dependencies.taskState.taskScopedToolIds = []
		} catch (error) {
			failures.push(error)
		}

		failures.push(...(await this.disposeTaskResources()))

		if (this.dependencies.taskState.taskLockAcquired) {
			try {
				await releaseTaskLock(this.dependencies.taskId)
				this.dependencies.taskState.taskLockAcquired = false
				Logger.info(`[Task ${this.dependencies.taskId}] Task lock released`)
			} catch (error) {
				failures.push(error)
			}
		}

		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) throw new AggregateError(failures, "Task resource cleanup failed")
	}

	private async disposeTaskResources(): Promise<unknown[]> {
		const failures: unknown[] = []
		const attempt = async (dispose: () => void | Promise<void>) => {
			try {
				await dispose()
			} catch (error) {
				failures.push(error)
			}
		}

		await attempt(() => this.dependencies.terminalManager.disposeAll())
		await attempt(() => this.dependencies.urlContentFetcher.closeBrowser())
		await attempt(() => this.dependencies.browserSession.dispose())
		await attempt(() => this.dependencies.commandPermissionController.dispose())
		await attempt(() => this.dependencies.diracIgnoreController.dispose())
		await attempt(() => this.dependencies.fileContextTracker.dispose())
		await attempt(() => this.dependencies.diffViewProvider.revertChanges())
		await attempt(() => AnchorStateManager.reset(this.dependencies.ulid))

		return failures
	}
}
