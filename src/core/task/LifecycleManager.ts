import { formatResponse } from "@core/formatResponse"
import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { HostProvider } from "@hosts/host-provider"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { findLastIndex } from "@shared/array"
import { DiracImageContentBlock, DiracUserContent } from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import { DiracMessageType } from "@/shared/ExtensionMessage"
import { TaskAbortManager } from "./lifecycle/TaskAbortManager"
import { TaskResumeManager } from "./lifecycle/TaskResumeManager"
import { LifecycleManagerDependencies } from "./types/lifecycle-manager"

// Manages task lifecycle: checkpoint initialization, task start, resume, and abort.
// Delegates resume and abort to focused managers for SRP.
export class LifecycleManager {
	private resumeManager: TaskResumeManager
	private abortManager: TaskAbortManager

	constructor(private deps: LifecycleManagerDependencies) {
		this.resumeManager = new TaskResumeManager(deps)
		this.abortManager = new TaskAbortManager(deps)
	}

	public async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		if (
			!isFirstRequest ||
			!this.deps.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") ||
			!this.deps.checkpointManager ||
			this.deps.taskState.checkpointManagerErrorMessage
		)
			return
		try {
			await ensureCheckpointInitialized({ checkpointManager: this.deps.checkpointManager })
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error("Failed to initialize checkpoint manager:", errorMessage)
			this.deps.taskState.checkpointManagerErrorMessage = errorMessage
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Checkpoint initialization timed out: ${errorMessage}`,
			})
		}
		if (this.deps.taskState.checkpointManagerErrorMessage) return
		await this.deps.taskMessenger.createCheckpoint()
		const messages = this.deps.messageStateHandler.getDiracMessages()
		const lastCheckpointIndex = findLastIndex(messages, (m) => m.content.type === DiracMessageType.CHECKPOINT)
		if (lastCheckpointIndex === -1) return
		const commitPromise = this.deps.checkpointManager!.commit()
		this.deps.taskState.initialCheckpointCommitPromise = commitPromise
		commitPromise
			?.then(async (commitHash) => {
				if (commitHash)
					await this.deps.messageStateHandler.updateDiracMessage(lastCheckpointIndex, {
						lastCheckpointHash: commitHash,
					})
			})
			.catch((error) =>
				Logger.error(`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.deps.taskId}:`, error),
			)
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		try {
			await this.deps.diracIgnoreController.initialize()
			await this.deps.commandPermissionController.initialize(this.deps.cwd)
		} catch (error) {
			Logger.error("Failed to initialize DiracIgnoreController:", error)
		}
		this.deps.messageStateHandler.setDiracMessages([])
		this.deps.messageStateHandler.setApiConversationHistory([])
		await this.deps.postStateToWebview()
		await this.deps.taskMessenger.upsertText(task || "", false, images, files, "user")
		this.deps.taskState.isInitialized = true
		const userContent = await this.buildInitialUserContent(task, images, files)
		await this.runTaskStartHook(userContent, task)
		if (this.deps.taskState.abort) return
		const userPromptHookResult = await this.deps.hookManager.runUserPromptSubmitHook(userContent, "initial_task")
		if (this.deps.taskState.abort) return
		if (userPromptHookResult.cancel === true) {
			await this.deps.hookManager.handleHookCancellation("UserPromptSubmit", userPromptHookResult.wasCancelled ?? false)
			await this.deps.cancelTask()
			return
		}
		if (userPromptHookResult.contextModification)
			userContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		try {
			await this.deps.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata:", error)
		}
		await this.deps.initiateTaskLoop(userContent)
	}

	public async resumeTaskFromHistory() {
		await this.resumeManager.resume()
	}
	public async abortTask() {
		await this.abortManager.abort()
	}

	private async buildInitialUserContent(task?: string, images?: string[], files?: string[]): Promise<DiracUserContent[]> {
		const imageBlocks: DiracImageContentBlock[] = formatResponse.imageBlocks(images)
		const userContent: DiracUserContent[] = [{ type: "text", text: `<task>\n${task}\n</task>` }, ...imageBlocks]
		if (files?.length) {
			const fileContent = await processFilesIntoText(files)
			if (fileContent) userContent.push({ type: "text", text: fileContent })
		}
		return userContent
	}

	private async runTaskStartHook(userContent: DiracUserContent[], task?: string) {
		const hooksEnabled = getHooksEnabledSafe(this.deps.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) return
		const result = await executeHook({
			hookName: "TaskStart",
			hookInput: {
				taskStart: { taskMetadata: { taskId: this.deps.taskId, ulid: this.deps.ulid, initialTask: task || "" } },
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
			await this.deps.hookManager.handleHookCancellation("TaskStart", result.wasCancelled || false)
			await this.deps.cancelTask()
			return
		}
		if (result.contextModification) {
			const contextText = result.contextModification.trim()
			if (contextText)
				userContent.push({ type: "text", text: `<hook_context source="TaskStart">\n${contextText}\n</hook_context>` })
		}
	}
}
