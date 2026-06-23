import type { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo } from "@shared/api"
import type { ChatContent } from "@shared/ChatContent"
import { type ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Mode } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { BannerService } from "@/services/banner/BannerService"
import { DiracExtensionContext } from "@/shared/dirac"
import { Logger } from "@/shared/services/Logger"
import { StateManager } from "../storage/StateManager"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { Task } from "../task"
import { WorkspaceController } from "./workspace/WorkspaceController"
import { AuthController } from "./auth/AuthController"
import { StateController } from "./state/StateController"
import { checkCliInstallation } from "./state/checkCliInstallation"
import { sendChatButtonClickedEvent } from "./ui/subscribeToChatButtonClicked"
import { getStateToPostToWebview as getUiState } from "./ui/UiController"
import { sendStateUpdate } from "./state/subscribeToState"
import { SkillMetadata } from "@/shared/skills"
import { TaskController } from "./task/TaskController"
import { fingerprintAvailableTools } from "@shared/utils/tool-fingerprint"
import { Initializer, type InitializerConfig } from "./index-initializer"

export class Controller {
	public discoveredSkillsCache?: SkillMetadata[]
	readonly stateManager: StateManager
	private availableToolsFingerprint?: string

	// NEW: Add workspace manager (optional initially)
	private workspaceManager?: WorkspaceRootManager

	private authController!: AuthController
	private stateController!: StateController
	private workspaceController!: WorkspaceController
	private taskController!: TaskController
	private taskHistoryController!: import("./TaskHistoryController").TaskHistoryController
	private initializerConfig!: InitializerConfig

	get task(): Task | undefined {
		return this.taskController?.task
	}

	set task(value: Task | undefined) {
		this.taskController!.task = value
	}

	// Public getter for workspace manager with lazy initialization - To get workspaces when task isn't initialized (Used by file mentions)
	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		const manager = await this.workspaceController.ensureWorkspaceManager()
		if (manager && !this.workspaceManager) {
			this.workspaceManager = manager
		}
		return this.workspaceManager
	}

	// Synchronous getter for workspace manager
	getWorkspaceManager(): WorkspaceRootManager | undefined {
		const tm = this.taskController.workspaceManager
		if (tm) {
			this.workspaceManager = tm
		}
		return this.workspaceManager || this.taskController.workspaceManager
	}

	constructor(readonly context: DiracExtensionContext) {
		const initializer = new Initializer(context)
		this.initializerConfig = initializer.createConfig(this)
		Object.assign(this, this.initializerConfig)
		this.stateManager = this.initializerConfig.stateManager

		BannerService.initialize(this)

		// Clean up legacy checkpoints
		cleanupLegacyCheckpoints().catch((error) => {
			Logger.error("Failed to cleanup legacy checkpoints:", error)
		})

		// Check CLI installation status once on startup
		checkCliInstallation(this)

		// Initialize workspace manager in background
		this.ensureWorkspaceManager().then(() => {
			this.postStateToWebview()
		})
	}

	/*
    VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
    - https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
    - https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
    */
	async dispose() {
		await this.clearTask()

		Logger.error("Controller disposed")
	}

	// Task lifecycle delegation (via TaskController)

	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: any,
		conversationUlid?: string,
		_watcherFactory?: any,
	): Promise<string> {
		return this.taskController.initTask(task, images, files, historyItem, taskSettings, conversationUlid, _watcherFactory)
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		return this.taskController.reinitExistingTaskFromId(taskId)
	}

	async cancelTask(): Promise<void> {
		return this.taskController.cancelTask()
	}

	updateBackgroundCommandState(running: boolean, taskId?: string): void {
		this.taskController.updateBackgroundCommandState(running, taskId)
	}

	get backgroundCommandRunning(): boolean {
		return this.taskController.backgroundCommandRunning
	}

	get backgroundCommandTaskId(): string | undefined {
		return this.taskController.backgroundCommandTaskId
	}

	async cancelBackgroundCommand(): Promise<void> {
		return this.taskController.cancelBackgroundCommand()
	}

	async clearTask(): Promise<void> {
		await this.taskController.clearTask()
	}

	async createTask(prompt: string) {
		await sendChatButtonClickedEvent()
		await this.initTask(prompt)
	}

	// OpenRouter

	async completeOpenRouterAuth(code: string) {
		return this.authController.completeOpenRouterAuth(code)
	}

	// GitHub Copilot
	async completeGithubLogin() {
		return this.authController.completeGithubLogin()
	}

	// Requesty

	async completeRequestyAuth(code: string) {
		return this.authController.completeRequestyAuth(code)
	}

	// Read OpenRouter models from disk cache (delegates to TaskHistoryController)
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		return this.taskHistoryController.readOpenRouterModels()
	}

	// Task history (delegates to TaskHistoryController)

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		return this.taskHistoryController.getTaskWithId(id)
	}

	async exportTaskWithId(id: string) {
		return this.taskHistoryController.exportTaskWithId(id)
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		const updated = await this.taskHistoryController.deleteTaskFromState(id)
		await this.postStateToWebview()
		return updated
	}

	async postStateToWebview(): Promise<void> {
		const state = await getUiState({
			stateManager: this.stateManager,
			task: this.task,
			workspaceManager: this.workspaceManager,
			backgroundCommandRunning: this.backgroundCommandRunning,
			backgroundCommandTaskId: this.backgroundCommandTaskId,
		})
		await sendStateUpdate(state)
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const previousAvailableToolsFingerprint = this.availableToolsFingerprint

		const state = await getUiState({
			stateManager: this.stateManager,
			task: this.task,
			workspaceManager: this.workspaceManager,
			backgroundCommandRunning: this.backgroundCommandRunning,
			backgroundCommandTaskId: this.backgroundCommandTaskId,
		})

		const nextAvailableToolsFingerprint = await fingerprintAvailableTools(state.availableTools)
		if (this.task && previousAvailableToolsFingerprint !== nextAvailableToolsFingerprint) {
			this.task.markToolsDirty("settings_refresh_detected_change")
		}
		this.availableToolsFingerprint = nextAvailableToolsFingerprint

		return state
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		return this.taskHistoryController.updateTaskHistory(item)
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting): Promise<void> {
		return this.stateController.updateTelemetrySetting(telemetrySetting)
	}

	async toggleActModeForYoloMode(): Promise<boolean> {
		return this.stateController.toggleActModeForYoloMode()
	}

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		return this.stateController.togglePlanActMode(modeToSwitchTo, chatContent)
	}
}
