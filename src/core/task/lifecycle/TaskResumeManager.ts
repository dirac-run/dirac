import { formatResponse } from "@core/formatResponse"
import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { ensureTaskDirectoryExists, getSavedApiConversationHistory, getSavedDiracMessages } from "@core/storage/disk"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { findLastIndex } from "@shared/array"
import { DiracStorageMessage } from "@shared/messages"
import { DiracContent } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import { CardStatus, type DiracMessage, TaskStatus } from "@/shared/ExtensionMessage"
import type { LifecycleManagerDependencies } from "../types/lifecycle-manager"
import { buildUserFeedbackContent } from "../utils/buildUserFeedbackContent"

// Manages task resume from history — loads saved messages, waits for user response, runs hooks.
export class TaskResumeManager {
	constructor(private deps: LifecycleManagerDependencies) { }

	// Loads saved conversation, waits for user decision, builds new user content, and initiates task loop.
	async resume(): Promise<void> {
		await this.initializeControllers()
		const savedDiracMessages = await this.loadAndTrimSavedMessages()
		await this.restoreMessageState(savedDiracMessages)
		await ensureTaskDirectoryExists(this.deps.taskId)
		const lastDiracMessage = this.findLastNonResumeMessage()
		const isCompleted = this.isCompletedTask(lastDiracMessage)
		this.prepareTaskStateForResume(isCompleted)
		await this.deps.postStateToWebview()
		if (isCompleted || (await this.waitForUserOrAbort())) return
		const { response, text, images, files } = this.extractUserResponse()
		const newUserContent: DiracContent[] = []
		await this.runTaskResumeHook(newUserContent, lastDiracMessage)
		if (this.deps.taskState.abort) return
		this.appendUserResponse(newUserContent, response, text, images, files)
		const { modifiedApiConversationHistory, modifiedOldUserContent } = this.prepareHistoryForResume()
		newUserContent.push(...modifiedOldUserContent)
		this.appendResumeContext(newUserContent, lastDiracMessage, text, images, files)
		await this.runUserPromptHook(newUserContent)
		if (this.deps.taskState.abort) return
		try {
			await this.deps.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata on resume:", error)
		}
		await this.deps.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.deps.initiateTaskLoop(newUserContent)
	}

	private async initializeControllers() {
		try {
			await this.deps.diracIgnoreController.initialize()
			await this.deps.commandPermissionController.initialize(this.deps.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}
	}

	private async loadAndTrimSavedMessages() {
		const savedDiracMessages = await getSavedDiracMessages(this.deps.taskId)
		const lastRelevantIndex = findLastIndex(
			savedDiracMessages,
			(m) =>
				!(
					m.content.type === "card" &&
					(m.content.card.header === "Resume Task" || m.content.card.header === "Resume Completed Task")
				),
		)
		if (lastRelevantIndex !== -1) savedDiracMessages.splice(lastRelevantIndex + 1)
		const lastApiReqIndex = findLastIndex(savedDiracMessages, (m) => m.content.type === "api_status")
		if (lastApiReqIndex !== -1) {
			const lastApiReq = savedDiracMessages[lastApiReqIndex]
			if (
				lastApiReq.content.type === "api_status" &&
				lastApiReq.content.status.cost === undefined &&
				lastApiReq.content.status.cancelReason === undefined
			)
				savedDiracMessages.splice(lastApiReqIndex, 1)
		}
		return savedDiracMessages
	}

	private async restoreMessageState(savedDiracMessages: any[]) {
		await this.deps.messageStateHandler.overwriteDiracMessages(savedDiracMessages)
		this.deps.messageStateHandler.setDiracMessages(await getSavedDiracMessages(this.deps.taskId))
		this.deps.messageStateHandler.setApiConversationHistory(
			(await getSavedApiConversationHistory(this.deps.taskId)) as DiracStorageMessage[],
		)
	}

	private findLastNonResumeMessage() {
		return this.deps.messageStateHandler
			.getDiracMessages()
			.slice()
			.reverse()
			.find(
				(m) =>
					!(
						m.content.type === "card" &&
						(m.content.card.header === "Resume Task" || m.content.card.header === "Resume Completed Task")
					),
			)
	}

	private isCompletedTask(lastDiracMessage: DiracMessage | undefined): boolean {
		return (
			lastDiracMessage?.content.type === "card" &&
			lastDiracMessage.content.card.header === "Task Completed" &&
			lastDiracMessage.content.card.status === CardStatus.SUCCESS
		)
	}

	private prepareTaskStateForResume(isCompleted: boolean) {
		this.deps.taskState.isInitialized = true
		this.deps.taskState.abort = false
		this.deps.taskState.askResponse = undefined
		this.deps.taskState.askResponseText = undefined
		this.deps.taskState.askResponseImages = undefined
		this.deps.taskState.askResponseFiles = undefined
		this.deps.taskState.status = isCompleted ? TaskStatus.COMPLETED : TaskStatus.CANCELLED
	}

	// Returns true if aborted during wait.
	private async waitForUserOrAbort(): Promise<boolean> {
		await pWaitFor(() => this.deps.taskState.askResponse !== undefined || this.deps.taskState.abort, { interval: 100 })
		return this.deps.taskState.abort
	}

	private extractUserResponse() {
		return {
			response: this.deps.taskState.askResponse as DiracAskResponse | undefined,
			text: this.deps.taskState.askResponseText as string | undefined,
			images: this.deps.taskState.askResponseImages as string[] | undefined,
			files: this.deps.taskState.askResponseFiles as string[] | undefined,
		}
	}

	private async runTaskResumeHook(newUserContent: DiracContent[], lastDiracMessage: any) {
		const hooksEnabled = getHooksEnabledSafe(this.deps.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) return
		const diracMessages = this.deps.messageStateHandler.getDiracMessages()
		const result = await executeHook({
			hookName: "TaskResume",
			hookInput: {
				taskResume: {
					taskMetadata: { taskId: this.deps.taskId, ulid: this.deps.ulid },
					previousState: {
						lastMessageTs: lastDiracMessage?.ts?.toString() || "",
						messageCount: diracMessages.length.toString(),
						conversationHistoryDeleted: (
							this.deps.taskState.conversationHistoryDeletedRange !== undefined
						).toString(),
					},
				},
			},
			isCancellable: true,
			messenger: this.deps.taskMessenger,
			setActiveHookExecution: this.deps.hookManager.setActiveHookExecution.bind(this.deps.hookManager),
			clearActiveHookExecution: this.deps.hookManager.clearActiveHookExecution.bind(this.deps.hookManager),
			messageStateHandler: this.deps.messageStateHandler,
			taskId: this.deps.taskId,
			hooksEnabled,
			model: getHookModelContext(this.deps.api, this.deps.stateManager),
		})
		if (result.cancel === true) {
			await this.deps.hookManager.handleHookCancellation("TaskResume", result.wasCancelled || false)
			await this.deps.cancelTask()
			return
		}
		if (result.contextModification)
			newUserContent.push({
				type: "text",
				text: `<hook_context source="TaskResume" type="general">\n${result.contextModification}\n</hook_context>`,
			})
	}

	private appendUserResponse(
		newUserContent: DiracContent[],
		response: DiracAskResponse | undefined,
		text: string | undefined,
		images: string[] | undefined,
		files: string[] | undefined,
	) {
		if (response === DiracAskResponse.MESSAGE || text || (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0) {
			this.deps.taskMessenger.upsertText(text || "", false, images, files)
		}
	}

	private prepareHistoryForResume() {
		const existing = this.deps.messageStateHandler.getApiConversationHistory()
		if (existing.length === 0) return { modifiedApiConversationHistory: [], modifiedOldUserContent: [] }
		const lastMessage = existing[existing.length - 1]
		if (lastMessage.role === "assistant") return { modifiedApiConversationHistory: [...existing], modifiedOldUserContent: [] }
		if (lastMessage.role === "user") {
			const existingUserContent: DiracContent[] = Array.isArray(lastMessage.content)
				? lastMessage.content
				: [{ type: "text", text: lastMessage.content }]
			return { modifiedApiConversationHistory: existing.slice(0, -1), modifiedOldUserContent: [...existingUserContent] }
		}
		throw new Error("Unexpected: Last message is not a user or assistant message")
	}

	private async appendResumeContext(
		newUserContent: DiracContent[],
		lastDiracMessage: any,
		responseText: string | undefined,
		responseImages: string[] | undefined,
		responseFiles: string[] | undefined,
	) {
		const agoText = this.computeAgoText(lastDiracMessage?.ts ?? Date.now())
		const wasRecent = lastDiracMessage?.ts && Date.now() - lastDiracMessage.ts < 30_000
		const pendingContextWarning = await this.deps.fileContextTracker.retrieveAndClearPendingFileContextWarning()
		const hasWarnings = pendingContextWarning && pendingContextWarning.length > 0
		const mode = this.deps.stateManager.getGlobalSettingsKey("mode")
		const [taskResumptionMessage, userResponseMessage] = formatResponse.taskResumption(
			mode === "plan" ? "plan" : "act",
			agoText,
			this.deps.cwd,
			wasRecent,
			responseText,
			hasWarnings,
		)
		if (taskResumptionMessage) newUserContent.push({ type: "text", text: taskResumptionMessage })
		if (userResponseMessage) newUserContent.push({ type: "text", text: userResponseMessage })
		if (responseImages?.length) newUserContent.push(...formatResponse.imageBlocks(responseImages))
		if (responseFiles?.length) {
			const fileContent = await processFilesIntoText(responseFiles)
			if (fileContent) newUserContent.push({ type: "text", text: fileContent })
		}
		if (pendingContextWarning?.length)
			newUserContent.push({ type: "text", text: formatResponse.fileContextWarning(pendingContextWarning) })
	}

	private computeAgoText(timestamp: number): string {
		const diff = Date.now() - timestamp
		const minutes = Math.floor(diff / 60000)
		const hours = Math.floor(minutes / 60)
		const days = Math.floor(hours / 24)
		if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`
		if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`
		if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
		return "just now"
	}

	private async runUserPromptHook(newUserContent: DiracContent[]) {
		const userFeedbackContent = await buildUserFeedbackContent(undefined, undefined, undefined)
		const result = await this.deps.hookManager.runUserPromptSubmitHook(userFeedbackContent, "resume")
		if (result.cancel === true) {
			await this.deps.cancelTask()
			return
		}
		if (result.contextModification)
			newUserContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${result.contextModification}\n</hook_context>`,
			})
	}
}
