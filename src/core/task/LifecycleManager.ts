import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import { ensureTaskDirectoryExists, getSavedApiConversationHistory, getSavedDiracMessages } from "@core/storage/disk"
import { HostProvider } from "@hosts/host-provider"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { findLastIndex } from "@shared/array"
import { DiracApiReqInfo, DiracAsk } from "@shared/ExtensionMessage"
import { DiracContent, DiracImageContentBlock, DiracUserContent } from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { releaseTaskLock } from "./TaskLockUtils"
import { LifecycleManagerDependencies } from "./types/lifecycle-manager"
import { buildUserFeedbackContent } from "./utils/buildUserFeedbackContent"

export class LifecycleManager {
	constructor(private dependencies: LifecycleManagerDependencies) {}

	public async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		if (
			!isFirstRequest ||
			!this.dependencies.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") ||
			!this.dependencies.checkpointManager ||
			this.dependencies.taskState.checkpointManagerErrorMessage
		) {
			return
		}

		try {
			await ensureCheckpointInitialized({ checkpointManager: this.dependencies.checkpointManager })
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
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
			await this.dependencies.say("checkpoint_created") // Now this is conditional
			const lastCheckpointMessageIndex = findLastIndex(
				this.dependencies.messageStateHandler.getDiracMessages(),
				(m) => m.say === "checkpoint_created",
			)
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

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		try {
			await this.dependencies.diracIgnoreController.initialize()
			await this.dependencies.commandPermissionController.initialize(this.dependencies.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}
		this.dependencies.messageStateHandler.setDiracMessages([])
		this.dependencies.messageStateHandler.setApiConversationHistory([])

		await this.dependencies.postStateToWebview()

		await this.dependencies.say("task", task, images, files)

		this.dependencies.taskState.isInitialized = true

		const imageBlocks: DiracImageContentBlock[] = formatResponse.imageBlocks(images)

		const userContent: DiracUserContent[] = [
			{
				type: "text",
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

		const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
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
				say: this.dependencies.say.bind(this.dependencies),
				setActiveHookExecution: this.dependencies.hookManager.setActiveHookExecution.bind(this.dependencies.hookManager),
				clearActiveHookExecution: this.dependencies.hookManager.clearActiveHookExecution.bind(
					this.dependencies.hookManager,
				),
				messageStateHandler: this.dependencies.messageStateHandler,
				taskId: this.dependencies.taskId,
				hooksEnabled,
				model: getHookModelContext(this.dependencies.api, this.dependencies.stateManager),
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

		await this.dependencies.initiateTaskLoop(userContent)
	}

	public async resumeTaskFromHistory() {
		try {
			await this.dependencies.diracIgnoreController.initialize()
			await this.dependencies.commandPermissionController.initialize(this.dependencies.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}

		const savedDiracMessages = await getSavedDiracMessages(this.dependencies.taskId)

		const lastRelevantMessageIndex = findLastIndex(
			savedDiracMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			savedDiracMessages.splice(lastRelevantMessageIndex + 1)
		}

		const lastApiReqStartedIndex = findLastIndex(savedDiracMessages, (m) => m.type === "say" && m.say === "api_req_started")
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = savedDiracMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: DiracApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				savedDiracMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.dependencies.messageStateHandler.overwriteDiracMessages(savedDiracMessages)
		this.dependencies.messageStateHandler.setDiracMessages(await getSavedDiracMessages(this.dependencies.taskId))

		const savedApiConversationHistory = await getSavedApiConversationHistory(this.dependencies.taskId)
		this.dependencies.messageStateHandler.setApiConversationHistory(savedApiConversationHistory as any)

		const taskDir = await ensureTaskDirectoryExists(this.dependencies.taskId)

		const lastDiracMessage = this.dependencies.messageStateHandler
			.getDiracMessages()
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

		let askType: DiracAsk
		if (lastDiracMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.dependencies.taskState.isInitialized = true
		this.dependencies.taskState.abort = false

		const { response, text, images, files } = await this.dependencies.ask(askType)

		const newUserContent: DiracContent[] = []

		const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
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
				say: this.dependencies.say.bind(this.dependencies),
				setActiveHookExecution: this.dependencies.hookManager.setActiveHookExecution.bind(this.dependencies.hookManager),
				clearActiveHookExecution: this.dependencies.hookManager.clearActiveHookExecution.bind(
					this.dependencies.hookManager,
				),
				messageStateHandler: this.dependencies.messageStateHandler,
				taskId: this.dependencies.taskId,
				hooksEnabled,
				model: getHookModelContext(this.dependencies.api, this.dependencies.stateManager),
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
		if (response === "messageResponse" || text || (images && images.length > 0) || (files && files.length > 0)) {
			await this.dependencies.say("user_feedback", text, images, files)
			await this.dependencies.checkpointManager?.saveCheckpoint()
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
		const mode = this.dependencies.stateManager.getGlobalSettingsKey("mode")
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

		const userFeedbackContent = await buildUserFeedbackContent(responseText, responseImages, responseFiles)
		const userPromptHookResult = await this.dependencies.hookManager.runUserPromptSubmitHook(userFeedbackContent, "resume")

		if (this.dependencies.taskState.abort) {
			return
		}

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

		try {
			await this.dependencies.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata on resume:", error)
		}

		await this.dependencies.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.dependencies.initiateTaskLoop(newUserContent)
	}

	public async abortTask() {
		try {
			const shouldRunTaskCancelHook = await this.dependencies.hookManager.shouldRunTaskCancelHook()

			this.dependencies.taskState.abort = true

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

			const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
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
						say: this.dependencies.say.bind(this.dependencies),
						messageStateHandler: this.dependencies.messageStateHandler,
						taskId: this.dependencies.taskId,
						hooksEnabled,
						model: getHookModelContext(this.dependencies.api, this.dependencies.stateManager),
					})

					const lastDiracMessage = this.dependencies.messageStateHandler
						.getDiracMessages()
						.slice()
						.reverse()
						.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

					let askType: DiracAsk
					if (lastDiracMessage?.ask === "completion_result") {
						askType = "resume_completed_task"
					} else {
						askType = "resume_task"
					}

					this.dependencies.ask(askType).catch((error) => {
						Logger.log("[TaskCancel] Resume ask failed (task may have been cleared):", error)
					})
				} catch (error) {
					Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
				}
			}

			try {
				await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				await this.dependencies.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post state after setting abort flag", error)
			}


			this.dependencies.terminalManager.disposeAll()
			this.dependencies.urlContentFetcher.closeBrowser()
			await this.dependencies.browserSession.dispose()
			this.dependencies.diracIgnoreController.dispose()
			this.dependencies.fileContextTracker.dispose()
			await this.dependencies.diffViewProvider.revertChanges()
			AnchorStateManager.reset(this.dependencies.taskId)
		} finally {
			if (this.dependencies.taskState.taskLockAcquired) {
				try {
					await releaseTaskLock(this.dependencies.taskId)
					this.dependencies.taskState.taskLockAcquired = false
					Logger.info(`[Task ${this.dependencies.taskId}] Task lock released`)
				} catch (error) {
					Logger.error(`[Task ${this.dependencies.taskId}] Failed to release task lock:`, error)
				}
			}

			try {
				await this.dependencies.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post final state after abort", error)
			}
		}
	}
}
