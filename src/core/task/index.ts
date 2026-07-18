import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiHandler, ApiProviderInfo, buildApiHandler } from "@core/api"
import { ApiStream } from "@core/api/transform/stream"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"
import {
	getGlobalDiracRules,
	getLocalDiracRules,
	refreshDiracRulesToggles,
} from "@core/context/instructions/user-instructions/dirac-rules"
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { formatResponse } from "@core/formatResponse"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { CommandPermissionController } from "@core/permissions"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { getSystemPrompt } from "@core/prompts/system-prompt"
import { ensureRulesDirectoryExists, ensureTaskDirectoryExists } from "@core/storage/disk"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { HostProvider } from "@hosts/host-provider"
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import {
	type CommandExecutionOptions,
	type CommandExecutionResult,
	CommandExecutor,
	CommandExecutorCallbacks,
	FullCommandExecutorConfig,
	StandaloneTerminalManager,
} from "@integrations/terminal"
import { ITerminalManager } from "@integrations/terminal/types"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { DiracError, DiracErrorType, ErrorService } from "@services/error"
import { featureFlagsService } from "@services/feature-flags"
import { telemetryService } from "@services/telemetry"
import { recordSuccessfulModelProviderPreset } from "@core/models/modelProviderPresets"
import { ApiConfiguration } from "@shared/api"
import { findLastIndex } from "@shared/array"
import { DiracClient } from "@shared/dirac"
import { getExtensionSourceDir } from "@shared/dirac/constants"
import { CardStatus, DiracApiReqCancelReason, DiracMessageContent, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import { DiracContent, DiracTextContentBlock, DiracToolResponseContent, DiracUserContent } from "@shared/messages/content"
import { DiracMessageModelInfo } from "@shared/messages/metrics"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import { Session } from "@shared/services/Session"
import { type Mode } from "@shared/storage/types"
import { isMutatingTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { isLocalModel, isParallelToolCallingEnabled } from "@utils/model-utils"
import fs from "fs/promises"
import Mutex from "p-mutex"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { ulid } from "ulid"
import { SkillMetadata } from "@/shared/skills"
import { getAvailableCores } from "@/utils/os"
import { detectBestShell } from "@/utils/shell-detection"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { getOrDiscoverSkills } from "../context/instructions/user-instructions/skills"
import { Controller } from "../controller"
import { StateManager } from "../storage/StateManager"
import { ApiConversationManager } from "./ApiConversationManager"
import { AssistantStreamManager } from "./AssistantStreamManager"
import { ContextLoader } from "./ContextLoader"
import { EnvironmentManager } from "./EnvironmentManager"
import { HookManager } from "./HookManager"
import { LifecycleManager } from "./LifecycleManager"
import { MessageStateHandler } from "./message-state"
import { ResponseProcessor } from "./ResponseProcessor"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { TaskMessenger } from "./TaskMessenger"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
import { DiracContext } from "./tools/context/DiracContext"
import type { ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import { ToolSkippedByUserMessage } from "./tools/types/ToolSkippedByUserMessage"
import { extractProviderDomainFromUrl, updateApiReqMsg } from "./utils"

export type ToolResponse = DiracToolResponseContent

type TaskParams = {
	controller: Controller
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	terminalOutputLineLimit: number
	defaultTerminalProfile: string
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	cwd: string
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	task?: string
	images?: string[]
	files?: string[]
	historyItem?: HistoryItem
	taskId: string
	conversationUlid?: string
	taskLockAcquired: boolean
	pinnedContext?: string
	onContextCompacted?: () => void
}

export class Task {
	// Core task variables
	readonly taskId: string
	private diracContext: DiracContext
	readonly ulid: string
	private taskIsFavorited?: boolean
	public cwd: string
	private taskInitializationStartTime: number

	taskState: TaskState

	// ONE mutex for ALL state modifications to prevent race conditions
	private stateMutex = new Mutex()

	/**
	 * Execute function with exclusive lock on all task state
	 * Use this for ANY state modification to prevent races
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	public async setActiveHookExecution(hookExecution: NonNullable<typeof this.taskState.activeHookExecution>): Promise<void> {
		return this.hookManager.setActiveHookExecution(hookExecution)
	}

	public async clearActiveHookExecution(): Promise<void> {
		return this.hookManager.clearActiveHookExecution()
	}

	/** Observe automatic and recovery context compaction for the owning ACP session. */
	public setContextCompactionObserver(observer: () => void): void {
		this.contextCompactionObserver = observer
	}

	public async getActiveHookExecution(): Promise<typeof this.taskState.activeHookExecution> {
		return this.hookManager.getActiveHookExecution()
	}

	// Core dependencies
	private controller: Controller

	// Service handlers
	api: ApiHandler
	terminalManager: ITerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	private diffViewProvider: DiffViewProvider
	public checkpointManager?: ICheckpointManager
	private initialCheckpointCommitPromise?: Promise<string | undefined>
	private diracIgnoreController: DiracIgnoreController
	private commandPermissionController: CommandPermissionController
	private toolExecutor: ToolExecutor
	/**
	 * Whether the task is using native tool calls.
	 * This is used to determine how we would format response.
	 * Example: We don't add noToolsUsed response when native tool call is used
	 * because of the expected format from the tool calls is different.
	 */

	private streamHandler: StreamResponseHandler

	private terminalExecutionMode: "vscodeTerminal" | "backgroundExec"

	// Metadata tracking
	private fileContextTracker: FileContextTracker
	private modelContextTracker: ModelContextTracker
	private environmentContextTracker: EnvironmentContextTracker
	private environmentManager: EnvironmentManager
	private contextLoader: ContextLoader
	private taskMessenger: TaskMessenger
	private hookManager: HookManager
	private lifecycleManager: LifecycleManager
	private apiConversationManager: ApiConversationManager
	private assistantStreamManager: AssistantStreamManager
	private contextCompactionObserver?: () => void

	private responseProcessor: ResponseProcessor

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private postStateToWebview: () => Promise<void>
	private reinitExistingTaskFromId: (taskId: string) => Promise<void>
	private cancelTask: () => Promise<void>

	// Cache service
	private stateManager: StateManager

	// Message and conversation state
	messageStateHandler: MessageStateHandler

	// Workspace manager
	workspaceManager?: WorkspaceRootManager

	// Task Locking (Sqlite)
	private taskLockAcquired: boolean

	// Command executor for running shell commands (extracted from executeCommandTool)
	private commandExecutor!: CommandExecutor

	constructor(params: TaskParams) {
		const {
			controller,
			updateTaskHistory,
			postStateToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			vscodeTerminalExecutionMode,
			cwd,
			stateManager,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			conversationUlid,
			taskLockAcquired,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		this.taskState.pinnedContext = params.pinnedContext
		this.contextCompactionObserver = params.onContextCompacted
		this.controller = controller
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.stateManager = stateManager
		this.workspaceManager = workspaceManager
		this.cwd = cwd
		this.taskId = taskId
		this.taskLockAcquired = taskLockAcquired
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"

		if (stateManager.getGlobalSettingsKey("mode") === "act") {
			this.taskState.didSwitchToActMode = true
		}

		// Initialize ULID and task state from history or new task params
		if (historyItem) {
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			this.ulid = conversationUlid ?? ulid()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.messageStateHandler = new MessageStateHandler({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
			workspaceRootPath: this.workspaceManager?.getPrimaryRoot()?.path,
		})

		this.taskMessenger = new TaskMessenger({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			postStateToWebview: this.postStateToWebview,
			stateManager: this.stateManager,
			taskId: this.taskId,
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
		})

		this.assistantStreamManager = new AssistantStreamManager(this.taskMessenger)

		this.hookManager = new HookManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			stateManager: this.stateManager,
			taskId: this.taskId,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			cancelTask: this.cancelTask,
			withStateLock: this.withStateLock.bind(this),
			shouldRunBackgroundCheck: () => this.commandExecutor.hasActiveBackgroundCommand(),
		})

		this.diracIgnoreController = new DiracIgnoreController(cwd)
		this.diracIgnoreController.yoloMode = !!stateManager.getGlobalSettingsKey("yoloModeToggled")

		this.commandPermissionController = new CommandPermissionController()

		// Determine terminal execution mode and create appropriate terminal manager
		// When backgroundExec mode is selected, use StandaloneTerminalManager for hidden execution
		// Otherwise, use the HostProvider's terminal manager (VSCode terminal in VSCode, standalone in CLI)
		if (this.terminalExecutionMode === "backgroundExec") {
			// Import StandaloneTerminalManager for background execution
			this.terminalManager = new StandaloneTerminalManager()
			Logger.info(`[Task ${taskId}] Using StandaloneTerminalManager for backgroundExec mode`)
		} else {
			// Use the host-provided terminal manager (VSCode terminal in VSCode environment)
			this.terminalManager = HostProvider.get().createTerminalManager()
			Logger.info(`[Task ${taskId}] Using HostProvider terminal manager for vscodeTerminal mode`)
		}
		this.terminalManager.setShellIntegrationTimeout(shellIntegrationTimeout)
		this.terminalManager.setTerminalReuseEnabled(terminalReuseEnabled ?? true)
		this.terminalManager.setTerminalOutputLineLimit(terminalOutputLineLimit)
		this.terminalManager.setDefaultTerminalProfile(defaultTerminalProfile)

		this.urlContentFetcher = new UrlContentFetcher()
		this.browserSession = new BrowserSession(stateManager)
		this.contextManager = new ContextManager()
		this.streamHandler = new StreamResponseHandler()

		// Prefer the host's DiffViewProvider if available, as it handles both background
		// and interactive edits. Fall back to FileEditProvider for headless environments.
		const hostDiffViewProvider = HostProvider.get().createDiffViewProvider()
		this.diffViewProvider = hostDiffViewProvider || new FileEditProvider()

		this.diracContext = new DiracContext(this.taskId, this.stateManager)
		AnchorStateManager.reset(this.ulid)

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// Check for multiroot workspace and warn about checkpoints
		const isMultiRootWorkspace = this.workspaceManager && this.workspaceManager.getRoots().length > 1
		const checkpointsEnabled = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

		if (isMultiRootWorkspace && checkpointsEnabled) {
			// Set checkpoint manager error message to display warning in TaskHeader
			this.taskState.checkpointManagerErrorMessage = "Checkpoints are not currently supported in multi-root workspaces."
		}

		// Initialize checkpoint manager based on workspace configuration
		if (!isMultiRootWorkspace) {
			try {
				this.checkpointManager = buildCheckpointManager({
					taskId: this.taskId,
					messageStateHandler: this.messageStateHandler,
					fileContextTracker: this.fileContextTracker,
					diffViewProvider: this.diffViewProvider,
					taskState: this.taskState,
					workspaceManager: this.workspaceManager,
					updateTaskHistory: this.updateTaskHistory,
					taskMessenger: this.taskMessenger,
					cancelTask: this.cancelTask,
					postStateToWebview: this.postStateToWebview,
					initialConversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					initialCheckpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
					stateManager: this.stateManager,
					resetTransientState: this.resetTransientState.bind(this),
				})

				// If multi-root, kick off non-blocking initialization
				// Unreachable for now, leaving in for future multi-root checkpoint support
				if (
					shouldUseMultiRoot({
						workspaceManager: this.workspaceManager,
						enableCheckpoints: this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
						stateManager: this.stateManager,
					})
				) {
					this.checkpointManager.initialize?.().catch((error: Error) => {
						Logger.error("Failed to initialize multi-root checkpoint manager:", error)
						this.taskState.checkpointManagerErrorMessage = error?.message || String(error)
					})
				}
			} catch (error) {
				Logger.error("Failed to initialize checkpoint manager:", error)
				if (this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Failed to initialize checkpoint manager: ${errorMessage}`,
					})
				}
			}
		}

		// Prepare effective API configuration
		const apiConfiguration = this.stateManager.getApiConfiguration()
		const effectiveApiConfiguration: ApiConfiguration = {
			...apiConfiguration,
			ulid: this.ulid,
			onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: any) => {
				await this.taskMessenger.upsertApiStatus({
					retryStatus: {
						attempt,
						maxAttempts: maxRetries,
						delaySec: Math.round(delay / 1000),
						errorSnippet: error?.message ? `${String(error.message).substring(0, 50)}...` : undefined,
					},
				})
			},
		}
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		// Now that ulid is initialized, we can build the API handler
		this.api = buildApiHandler(effectiveApiConfiguration, mode)

		// Update taskMessenger and hookManager with the initialized api
		this.taskMessenger.setApi(this.api)
		this.hookManager.setApi(this.api)
		this.hookManager.setUlid(this.ulid)

		// Set ulid on browserSession for telemetry tracking
		this.browserSession.setUlid(this.ulid)

		// initialize telemetry
		// Extract domain of the provider endpoint if using OpenAI Compatible provider
		let openAiCompatibleDomain: string | undefined
		if (currentProvider === "openai" && apiConfiguration.openAiBaseUrl) {
			openAiCompatibleDomain = extractProviderDomainFromUrl(apiConfiguration.openAiBaseUrl)
		}

		if (historyItem) {
			// Open task from history
			telemetryService.captureTaskRestarted(this.ulid, currentProvider, openAiCompatibleDomain)
		} else {
			// New task started
			telemetryService.captureTaskCreated(this.ulid, currentProvider, openAiCompatibleDomain)
		}

		// Initialize command executor with config and callbacks
		const commandExecutorConfig: FullCommandExecutorConfig = {
			cwd: this.cwd,
			terminalExecutionMode: this.terminalExecutionMode,
			terminalManager: this.terminalManager,
			taskId: this.taskId,
			ulid: this.ulid,
		}

		const commandExecutorCallbacks: CommandExecutorCallbacks = {
			taskMessenger: this.taskMessenger,
			updateBackgroundCommandState: (isRunning: boolean) =>
				this.controller.updateBackgroundCommandState(isRunning, this.taskId),
			updateDiracMessage: async (index: number, updates: Partial<import("@shared/ExtensionMessage").DiracMessage>) => {
				await this.messageStateHandler.updateDiracMessage(index, updates)
				await this.postStateToWebview()
			},
			getDiracMessages: () => this.messageStateHandler.getDiracMessages(),
			addToUserMessageContent: (content: { type: string; text: string }) => {
				// Cast to DiracTextContentBlock which is compatible with DiracContent
				this.taskState.userMessageContent.push({ type: "text", text: content.text } as DiracTextContentBlock)
			},
			getEnvironmentVariables: (cwd: string) => HostProvider.get().getEnvironmentVariables(cwd),
		}

		this.commandExecutor = new CommandExecutor(commandExecutorConfig, commandExecutorCallbacks)

		this.toolExecutor = new ToolExecutor(
			this.taskState,
			this.messageStateHandler,
			this.api,
			this.urlContentFetcher,
			this.browserSession,
			this.diffViewProvider,
			this.fileContextTracker,
			this.diracIgnoreController,
			this.commandPermissionController,
			this.contextManager,
			this.taskMessenger,
			this.stateManager,
			cwd,
			this.taskId,
			this.ulid,
			this.terminalExecutionMode,
			this.workspaceManager,
			isMultiRootEnabled(this.stateManager),
			this.saveCheckpointCallback.bind(this),
			this.executeCommandTool.bind(this),
			this.cancelBackgroundCommand.bind(this),
			() => this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			this.switchToActModeCallback.bind(this),
			this.cancelTask,
			this.postStateToWebview.bind(this),
			this.setActiveHookExecution.bind(this),
			this.clearActiveHookExecution.bind(this),
			this.getActiveHookExecution.bind(this),
			this.runUserPromptSubmitHook.bind(this),
			this.diracContext,
			this.resetTransientState.bind(this),
		)
		this.environmentManager = new EnvironmentManager({
			cwd: this.cwd,
			terminalManager: this.terminalManager,
			taskState: this.taskState,
			fileContextTracker: this.fileContextTracker,
			api: this.api,
			messageStateHandler: this.messageStateHandler,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
		})

		this.contextLoader = new ContextLoader({
			ulid: this.ulid,
			stateManager: this.stateManager,
			cwd: this.cwd,
			urlContentFetcher: this.urlContentFetcher,
			fileContextTracker: this.fileContextTracker,
			workspaceManager: this.workspaceManager,
			diracIgnoreController: this.diracIgnoreController,
			taskState: this.taskState,
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			extensionPath: HostProvider.get().extensionFsPath,
			sourceDir: getExtensionSourceDir(),
			getEnvironmentDetails: this.getEnvironmentDetails.bind(this),
			commandPermissionController: this.commandPermissionController,
			yoloModeToggled: !!this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			postStateToWebview: () => this.postStateToWebview(),
		})

		this.lifecycleManager = new LifecycleManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			stateManager: this.stateManager,
			api: this.api,
			taskId: this.taskId,
			ulid: this.ulid,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			cancelTask: this.cancelTask,
			checkpointManager: this.checkpointManager,
			diracIgnoreController: this.diracIgnoreController,
			terminalManager: this.terminalManager,
			urlContentFetcher: this.urlContentFetcher,
			browserSession: this.browserSession,
			diffViewProvider: this.diffViewProvider,
			fileContextTracker: this.fileContextTracker,
			contextManager: this.contextManager,
			commandExecutor: this.commandExecutor,
			commandPermissionController: this.commandPermissionController,
			cwd: this.cwd,
			hookManager: this.hookManager,
			initiateTaskLoop: this.initiateTaskLoop.bind(this),
			recordEnvironment: this.environmentContextTracker.recordEnvironment.bind(this.environmentContextTracker),
			time: () => this.environmentContextTracker.recordEnvironment(),
		})

		this.apiConversationManager = new ApiConversationManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
			contextManager: this.contextManager,
			stateManager: this.stateManager,
			taskId: this.taskId,
			ulid: this.ulid,
			cwd: this.cwd,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			diffViewProvider: this.diffViewProvider,
			toolExecutor: this.toolExecutor,
			streamHandler: this.streamHandler,
			withStateLock: this.withStateLock.bind(this),
			loadContext: this.loadContext.bind(this),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getEnvironmentDetails: this.getEnvironmentDetails.bind(this),
			writePromptMetadataArtifacts: this.writePromptMetadataArtifacts.bind(this),
			handleHookCancellation: this.hookManager.handleHookCancellation.bind(this.hookManager),
			setActiveHookExecution: this.hookManager.setActiveHookExecution.bind(this.hookManager),
			clearActiveHookExecution: this.hookManager.clearActiveHookExecution.bind(this.hookManager),
			taskInitializationStartTime: this.taskInitializationStartTime,
			cancelTask: this.cancelTask,
			runUserPromptSubmitHook: this.runUserPromptSubmitHook.bind(this),
			onContextCompacted: () => this.contextCompactionObserver?.(),
		})

		this.responseProcessor = new ResponseProcessor({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
			stateManager: this.stateManager,
			taskId: this.taskId,
			ulid: this.ulid,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			diffViewProvider: this.diffViewProvider,
			streamHandler: this.streamHandler,
			withStateLock: this.withStateLock.bind(this),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getApiRequestIdSafe: this.getApiRequestIdSafe.bind(this),
			toolExecutor: this.toolExecutor,
			assistantStreamManager: this.assistantStreamManager,
		})
	}

	async getEnvironmentDetails(includeFileDetails = false): Promise<string> {
		return this.environmentManager.getEnvironmentDetails(includeFileDetails)
	}

	private async persistApiStopReason(stopReason?: string): Promise<void> {
		if (!stopReason) return

		const lastApiRequestIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(message) => message.content.type === DiracMessageType.API_STATUS,
		)
		if (lastApiRequestIndex === -1) return

		const message = this.messageStateHandler.getDiracMessages()[lastApiRequestIndex]
		if (message.content.type !== DiracMessageType.API_STATUS) return

		await this.messageStateHandler.updateDiracMessage(lastApiRequestIndex, {
			content: {
				type: DiracMessageType.API_STATUS,
				status: { ...message.content.status, stopReason },
			},
		})
	}

	private async handleMistakeLimitReached(
		userContent: DiracContent[],
	): Promise<{ didEndLoop: boolean; userContent: DiracContent[] }> {
		if (this.taskState.consecutiveMistakeCount < this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")) {
			return { didEndLoop: false, userContent }
		}

		// In yolo mode, don't wait for user input - fail the task
		if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			const errorMessage =
				`[YOLO MODE] Task failed: Too many consecutive mistakes (${this.taskState.consecutiveMistakeCount}). ` +
				`The model may not be capable enough for this task. Consider using a more capable model.`
			const card = await this.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "Task Failed",
				body: errorMessage,
			})
			await card.finalize(CardStatus.ERROR)
			// End the task loop with failure
			return { didEndLoop: true, userContent } // didEndLoop = true, signals task completion/failure
		}

		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		if (autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Error",
				message: "Dirac is having trouble. Would you like to continue the task?",
			})
		}

		const cardHandle = await this.taskMessenger.createCard({
			header: "Mistake Limit Reached",
			body: `Tool use failure. Can potentially be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`,
			requireFeedback: true,
			feedbackPlaceholder: "Provide guidance to Dirac...",
		})
		let response: DiracAskResponse
		let text: string | undefined
		let images: string[] | undefined
		let files: string[] | undefined
		try {
			const result = await cardHandle.waitForInteraction()
			response = result.response
			text = result.text
			images = result.images
			files = result.files
		} catch (error) {
			if (error instanceof ToolSkippedByUserMessage) {
				await cardHandle.finalize(CardStatus.CANCELLED)
				this.taskState.pendingUserMessage = error.userMessage
				this.taskState.pendingUserImages = error.userImages
				this.taskState.pendingUserFiles = error.userFiles
				this.taskState.consecutiveMistakeCount = 0
				return { didEndLoop: false, userContent }
			}
			throw error
		}

		await cardHandle.finalize(CardStatus.SUCCESS)

		if (response === DiracAskResponse.MESSAGE) {
			// Display the user's message in the chat UI
			await this.taskMessenger.upsertText(text || "", false, images, files, "user")

			// This userContent is for the *next* API call.
			const feedbackUserContent: DiracUserContent[] = []
			feedbackUserContent.push({
				type: "text",
				text: formatResponse.tooManyMistakes(text),
			})

			if (images && images.length > 0) {
				feedbackUserContent.push(...formatResponse.imageBlocks(images))
			}

			let fileContentString = ""
			if (files && files.length > 0) {
				fileContentString = await processFilesIntoText(files)
			}

			if (fileContentString) {
				feedbackUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}

			userContent = feedbackUserContent
		}

		this.taskState.consecutiveMistakeCount = 0
		this.taskState.apiErrorRetryAttempts = 0
		this.taskState.emptyResponseRetryAttempts = 0
		return { didEndLoop: false, userContent }
	}

	async loadContext(
		userContent: DiracContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DiracContent[], string, boolean, SkillMetadata[], boolean, string?]> {
		return this.contextLoader.loadContext(userContent, includeFileDetails, useCompactPrompt)
	}

	// Communicate with webview

	public async resetTransientState(): Promise<void> {
		await this.diracContext.resetTaskContext()
		AnchorStateManager.reset(this.ulid)
		this.taskState.consecutiveMistakeCount = 0
		this.taskState.didAttemptCompletion = false
		this.taskState.activeVoiceStreamId = undefined
		await this.postStateToWebview()
	}

	private async waitForFollowUp(): Promise<DiracContent[] | undefined> {
		this.taskState.status = TaskStatus.AWAITING_USER_INPUT

		const messageTs = Date.now()
		this.taskState.lastMessageTs = messageTs
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined

		await pWaitFor(
			() => {
				return (
					this.taskState.askResponse !== undefined || this.taskState.lastMessageTs !== messageTs || this.taskState.abort
				)
			},
			{ interval: 100 },
		)

		if (this.taskState.abort || this.taskState.lastMessageTs !== messageTs) {
			return undefined
		}

		const text = this.taskState.askResponseText || ""
		const images = this.taskState.askResponseImages as string[] | undefined
		const files = this.taskState.askResponseFiles as string[] | undefined

		const userContent: DiracContent[] = [{ type: "text", text }]
		if (images && images.length > 0) {
			userContent.push(...formatResponse.imageBlocks(images))
		}
		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({ type: "text", text: fileContentString })
			}
		}

		return userContent
	}

	/** Persist a project-scoped tool permission rule for an ACP “always” decision. */
	public async addPermissionRule(rule: import("@core/permissions/types").ToolPermissionRule): Promise<void> {
		await this.commandPermissionController.addRule(rule)
	}

	/** List project-scoped ACP permission rules. */
	public async listPermissionRules(): Promise<import("@core/permissions/types").ToolPermissionRule[]> {
		return await this.commandPermissionController.listRules()
	}

	/** Delete one project-scoped ACP permission rule. */
	public async deletePermissionRule(rule: import("@core/permissions/types").ToolPermissionRule): Promise<void> {
		await this.commandPermissionController.deleteRule(rule)
	}

	public async submitCardResponse(
		cardId: string,
		response: DiracAskResponse | string,
		text?: string,
		images?: string[],
		files?: string[],
		value?: string,
	) {
		await this.withStateLock(async () => {
			if (cardId && this.taskState.lastWaitingCardId && this.taskState.lastWaitingCardId !== cardId) {
				Logger.warn(`[Task] Received response for card ${cardId}, but waiting for ${this.taskState.lastWaitingCardId}`)
				return
			}
			const isStandardResponse = Object.values(DiracAskResponse).includes(response as DiracAskResponse)
			this.taskState.askResponse = isStandardResponse ? (response as DiracAskResponse) : undefined
			this.taskState.askResponseText = text
			this.taskState.askResponseImages = images
			this.taskState.askResponseFiles = files
			this.taskState.askResponseAction = response as string
			this.taskState.askResponseValue = value
			// When user sends a text message while a card is awaiting approval,
			// signal that the tool should be skipped and forward to LLM.
			if (response === DiracAskResponse.MESSAGE && text && this.taskState.status !== TaskStatus.CANCELLED) {
				this.taskState.didRejectTool = true
			}
		})
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageId?: string): Promise<void> {
		if (isAttemptCompletionMessage) {
			this.taskState.didAttemptCompletion = true
		}
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageId) ?? Promise.resolve()
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	private isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const providerInfo = this.getCurrentProviderInfo()
		return isParallelToolCallingEnabled(enableParallelSetting, providerInfo)
	}

	private async switchToActModeCallback(): Promise<boolean> {
		return await this.controller.toggleActModeForYoloMode()
	}

	private async runUserPromptSubmitHook(
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		return this.hookManager.runUserPromptSubmitHook(userContent, context)
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		await this.toolExecutor.refreshToolsForTask()
		return this.lifecycleManager.startTask(task, images, files)
	}

	public async resumeTaskFromHistory() {
		await this.toolExecutor.refreshToolsForTask()
		return this.lifecycleManager.resumeTaskFromHistory()
	}

	public markToolsDirty(reason: ToolSnapshotDirtyReason): void {
		this.toolExecutor.markToolsDirty(reason)
	}

	private async initiateTaskLoop(userContent: DiracContent[]): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.taskState.abort) {
			const didEndLoop = await this.recursivelyMakeDiracRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // we only need file details the first time

			if (didEndLoop) {
				if (this.taskState.didAttemptCompletion) {
					const followUp = await this.waitForFollowUp()
					if (followUp) {
						await this.taskMessenger.upsertText(
							this.taskState.askResponseText || "",
							false,
							this.taskState.askResponseImages,
							this.taskState.askResponseFiles,
							"user",
						)
						nextUserContent = [...this.taskState.userMessageContent, ...followUp]
						this.taskState.didAttemptCompletion = false
						continue
					}
				}
				break
			}
		}
		// Flush task history at the end of the task loop (turn boundary)
		await this.messageStateHandler.flushTaskHistory()
	}

	private async shouldRunTaskCancelHook(): Promise<boolean> {
		return this.hookManager.shouldRunTaskCancelHook()
	}

	async abortTask() {
		this.taskState.status = TaskStatus.CANCELLING

		return this.lifecycleManager.abortTask()
	}

	// Tools
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<CommandExecutionResult> {
		return this.commandExecutor.execute(command, timeoutSeconds, options)
	}

	/**
	 * Cancel a background command that is running in the background
	 * @returns true if a command was cancelled, false if no command was running
	 */
	public async cancelBackgroundCommand(): Promise<boolean> {
		return this.commandExecutor.cancelBackgroundCommand()
	}

	public async cancelHookExecution(): Promise<boolean> {
		return this.hookManager.cancelHookExecution()
	}

	private getCurrentProviderInfo(): ApiProviderInfo {
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		return { model, providerId, customPrompt, mode }
	}

	private async writePromptMetadataArtifacts(params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}): Promise<void> {
		const enabledSetting = this.stateManager.getGlobalSettingsKey("writePromptMetadataEnabled")
		const enabledFlag = process.env.DIRAC_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
		const enabled =
			enabledSetting ||
			enabledFlag === "1" ||
			enabledFlag === "true" ||
			enabledFlag === "yes" ||
			process.env.IS_DEV === "true"
		if (!enabled) {
			return
		}

		try {
			// Env var is OS-level (user-controlled, safe to allow absolute); workspace setting is the exfiltration vector.
			const envDir = process.env.DIRAC_PROMPT_ARTIFACT_DIR?.trim()
			const settingDir = this.stateManager.getGlobalSettingsKey("writePromptMetadataDirectory")?.trim()
			const cwdResolved = path.resolve(this.cwd)
			// Setting-configured dirs must resolve under cwd to prevent workspace settings from exfiltrating prompts.
			// Only validate the setting when no env var is provided — env takes precedence and is trusted.
			if (!envDir && settingDir) {
				const resolved = path.isAbsolute(settingDir) ? path.resolve(settingDir) : path.resolve(this.cwd, settingDir)
				if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + path.sep)) {
					Logger.warn(`[Task ${this.taskId}] writePromptMetadataDirectory outside cwd rejected: ${resolved}`)
					return
				}
			}
			const configuredDir = envDir || settingDir
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? path.resolve(configuredDir)
					: path.resolve(this.cwd, configuredDir)
				: path.resolve(this.cwd, ".dirac-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })
			// Defense-in-depth: re-check the boundary after mkdir resolves any symlinks in the path,
			// so a workspace-planted symlink can't exfiltrate prompts outside cwd.
			// Only enforced for setting-derived paths — env vars are OS-level and may legitimately point anywhere.
			let writeDir = artifactDir
			if (!envDir) {
				const realArtifactDir = await fs.realpath(artifactDir)
				if (realArtifactDir !== cwdResolved && !realArtifactDir.startsWith(cwdResolved + path.sep)) {
					Logger.warn(
						`[Task ${this.taskId}] artifact dir resolves outside cwd (symlink?), rejected: ${realArtifactDir}`,
					)
					return
				}
				writeDir = realArtifactDir
			}
			// Ensure the artifact dir is git-ignored so debug dumps don't get committed.
			const gitignorePath = path.join(writeDir, ".gitignore")
			await fs.writeFile(gitignorePath, "*\n!.gitignore\n", "utf8").catch(() => {})

			const debugPath = path.join(writeDir, `task-${this.taskId}-debug.md`)

			let markdown = `## System Prompt\n\n${params.systemPrompt}\n\n`

			if (params.tools) {
				markdown += `## Tools\n\n\`\`\`json\n${JSON.stringify(params.tools, null, 2)}\n\`\`\`\n\n`
			}

			if (params.fullHistory) {
				markdown += `## Conversation History\n\n`
				const [deletedStart, deletedEnd] = params.deletedRange || [-1, -1]

				for (let i = 0; i < params.fullHistory.length; i++) {
					const message = params.fullHistory[i]
					const isTruncated = i >= deletedStart && i <= deletedEnd

					markdown += `### [${message.role.toUpperCase()}]${isTruncated ? " [TRUNCATED]" : ""}\n`

					if (typeof message.content === "string") {
						markdown += `${message.content}\n\n`
					} else if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "text") {
								markdown += `**Text:** ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n${block.text}\n\n`
							} else if (block.type === "thinking") {
								markdown += `**Thinking:** ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n${block.thinking}\n\n`
							} else if (block.type === "redacted_thinking") {
								markdown += `**Thinking:** [Redacted] ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n\n`
							} else if (block.type === "tool_use") {
								markdown += `**Tool Use:** \`${block.name}\` (\`id: ${block.id}\`, \`call_id: ${block.call_id}\`)\n`
								markdown += `\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\`\n\n`
							} else if (block.type === "tool_result") {
								markdown += `**Tool Result:** (\`${block.tool_use_id}\`)\n`
								if (typeof block.content === "string") {
									markdown += `${block.content}\n\n`
								} else if (Array.isArray(block.content)) {
									for (const contentBlock of block.content) {
										if (contentBlock.type === "text") {
											markdown += `${contentBlock.text}\n\n`
										} else if (contentBlock.type === "image") {
											markdown += `[Image: ${contentBlock.source?.type}]\n\n`
										}
									}
								}
							} else if (block.type === "image") {
								markdown += `[Image: ${block.source?.type}]\n\n`
							}
						}
					}
					markdown += "---\n\n"
				}
			}

			await fs.writeFile(debugPath, markdown, "utf8")
		} catch (error) {
			Logger.error("Failed to write prompt metadata artifacts:", error)
		}
	}

	private getApiRequestIdSafe(): string | undefined {
		const apiLike = this.api as Partial<{
			getLastRequestId: () => string | undefined
			lastGenerationId?: string
		}>
		return apiLike.getLastRequestId?.() ?? apiLike.lastGenerationId
	}

	private async handleContextWindowExceededError(): Promise<void> {
		return this.apiConversationManager.handleContextWindowExceededError()
	}

	/**
	 * Build the system prompt, tool snapshot, and context management metadata
	 * for an API request. Extracted from attemptApiRequest for single-responsibility.
	 */
	private async buildApiRequestParams(params: { previousApiReqIndex: number; shouldCompact?: boolean }) {
		const providerInfo = this.getCurrentProviderInfo()
		const host = await HostProvider.env.getHostVersion({})
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.diracType === DiracClient.Cli
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		// dirac browser tool uses image recognition for navigation (requires model image support).
		const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool // only enable browser use if the model supports it and the user hasn't disabled it
		const preferredLanguageRaw = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshDiracRulesToggles(this.stateManager, this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.stateManager,
			this.cwd,
		)

		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.cwd,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
		})

		const globalDiracRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalDiracRules(globalDiracRulesFilePath, globalToggles, { evaluationContext })
		const globalDiracRulesFileInstructions = globalRules.instructions
		const localRules = await getLocalDiracRules(this.cwd, localToggles, { evaluationContext })
		const localDiracRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.cwd, windsurfLocalToggles)
		const localAgentsRulesFileInstructions = await getLocalAgentsRules(this.cwd, agentsLocalToggles)
		this.diracIgnoreController.yoloMode = !!this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const isYolo = !!this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const diracIgnoreContent = this.diracIgnoreController.diracIgnoreContent
		let diracIgnoreInstructions: string | undefined
		if (diracIgnoreContent && !isYolo) {
			diracIgnoreInstructions = formatResponse.diracIgnoreInstructions(diracIgnoreContent)
		}
		// Prepare multi-root workspace information if enabled
		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		if (multiRootEnabled && this.workspaceManager) {
			workspaceRoots = this.workspaceManager.getRoots().map((root) => ({
				path: root.path,
				name: root.name || path.basename(root.path), // Fallback to basename if name is undefined
				vcs: root.vcs as string | undefined, // Cast VcsType to string
			}))
		}
		// Discover and filter available skills
		const resolvedSkills = await getOrDiscoverSkills(this.cwd, this.taskState)
		// Filter skills by toggle state (enabled by default)
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
			// If toggle exists, use it; otherwise default to enabled (true)
			return toggles[skill.path] !== false
		})
		this.taskState.availableSkills = availableSkills
		// Snapshot editor tabs so prompt tools can decide whether to include
		// filetype-specific instructions (e.g. notebooks) without adding bespoke flags.
		const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
		const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
		const cap = 50
		const editorTabs = {
			open: openTabPaths.slice(0, cap),
			visible: visibleTabPaths.slice(0, cap),
		}
		const shellInfo = detectBestShell()
		const promptContext: SystemPromptContext = {
			cwd: this.cwd,
			ide,
			providerInfo,
			editorTabs,
			supportsBrowserUse,
			skills: availableSkills,
			globalDiracRulesFileInstructions,
			localDiracRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			diracIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			subagentsEnabled: this.stateManager.getGlobalSettingsKey("subagentsEnabled"),
			diracWebToolsEnabled:
				this.stateManager.getGlobalSettingsKey("diracWebToolsEnabled") && featureFlagsService.getWebtoolsEnabled(),
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isSubagentRun: false,
			isCliEnvironment,
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			terminalExecutionMode: this.terminalExecutionMode,
			activeShellType: shellInfo.type,
			activeShellPath: shellInfo.path,
			activeShellIsPosix: shellInfo.isPosix,
			availableCores: getAvailableCores(),
			shouldCompact: params.shouldCompact,
		}
		// Notify user if any conditional rules were applied for this request
		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			await this.taskMessenger.upsertText(JSON.stringify({ rules: activatedConditionalRules }))
		}
		const toolSnapshot = await this.toolExecutor.getSnapshotForRequest(promptContext)
		const { systemPrompt } = await getSystemPrompt(promptContext, toolSnapshot)
		this.toolExecutor.activateSnapshot(toolSnapshot)
		this.taskState.useNativeToolCalls = toolSnapshot.nativeTools.length > 0
		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getDiracMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			params.previousApiReqIndex,
			await ensureTaskDirectoryExists(this.taskId),
			this.stateManager.getGlobalSettingsKey("useAutoCondense"),
		)

		await this.writePromptMetadataArtifacts({
			systemPrompt,
			providerInfo,
			tools: toolSnapshot.nativeTools,
			fullHistory: this.messageStateHandler.getApiConversationHistory(),
			deletedRange: this.taskState.conversationHistoryDeletedRange,
		})

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		}

		// If we're not using auto-condense, we should explicitly notify the model that history was truncated
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (!useAutoCondense) {
			const lastMessage =
				contextManagementMetadata.truncatedConversationHistory[
					contextManagementMetadata.truncatedConversationHistory.length - 1
				]
			if (lastMessage && lastMessage.role === "user") {
				const notice = formatResponse.contextTruncationNotice()
				if (typeof lastMessage.content === "string") {
					lastMessage.content += `\n\n${notice}`
				} else if (Array.isArray(lastMessage.content)) {
					lastMessage.content.push({
						type: "text",
						text: notice,
					})
				}
			}
		}

		return { systemPrompt, toolSnapshot, contextManagementMetadata, providerInfo }
	}

	private async handleApiRequestError(params: {
		error: unknown
		previousApiReqIndex: number
		lastApiReqIndex: number
		shouldCompact?: boolean
		model: { id: string; info: { contextWindow?: number } }
		providerId: string
		metricsManager: StreamingMetricsManager
	}): Promise<boolean> {
		const { error, model, providerId } = params
		const diracError = DiracError.transform(error, model.id, providerId)

		if (diracError.isErrorType(DiracErrorType.ContextWindowExceeded)) {
			await this.handleContextWindowExceededError()
			const truncatedConversationHistory = this.messageStateHandler.getDiracMessages()
			if (truncatedConversationHistory.length > 3) {
				diracError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
			}
		}

		const streamingFailedMessage = diracError.serialize()

		const lastApiReqStartedIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(m) => m.content.type === DiracMessageType.API_STATUS,
		)
		if (lastApiReqStartedIndex !== -1) {
			const diracMessages = this.messageStateHandler.getDiracMessages()
			const msg = diracMessages[lastApiReqStartedIndex]
			if (msg.content.type === DiracMessageType.API_STATUS) {
				const currentApiReqInfo = { ...msg.content.status }
				delete currentApiReqInfo.retryStatus

				await this.messageStateHandler.updateDiracMessage(lastApiReqStartedIndex, {
					content: {
						type: DiracMessageType.API_STATUS,
						status: {
							...currentApiReqInfo,
							streamingFailedMessage,
						},
					},
				})
			}
		}

		const isAuthError = diracError.isErrorType(DiracErrorType.Auth)

		const isDiracProviderInsufficientCredits = (() => {
			if (providerId !== "dirac") {
				return false
			}
			try {
				const parsedError = DiracError.transform(error, model.id, providerId)
				return parsedError.isErrorType(DiracErrorType.Balance)
			} catch {
				return false
			}
		})()

		let response: DiracAskResponse
		if (!isDiracProviderInsufficientCredits && !isAuthError && this.taskState.apiErrorRetryAttempts < 3) {
			this.taskState.apiErrorRetryAttempts++
			const delay = 2000 * 2 ** (this.taskState.apiErrorRetryAttempts - 1)

			await updateApiReqMsg({
				messageStateHandler: this.messageStateHandler,
				lastApiReqIndex: lastApiReqStartedIndex,
				inputTokens: 0,
				reasoningTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: undefined,
				api: this.api,
				cancelReason: "streaming_failed",
				streamingFailedMessage,
			})
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.postStateToWebview()

			response = DiracAskResponse.APPROVE
			const autoRetryCard = await this.taskMessenger.createCard({
				status: CardStatus.PENDING,
				header: "API Error (Retrying)",
				body: `API Error (attempt ${this.taskState.apiErrorRetryAttempts}/3). Retrying in ${delay / 1000}s...`,
			})

			const autoRetryApiReqIndex = findLastIndex(
				this.messageStateHandler.getDiracMessages(),
				(m) => m.content.type === DiracMessageType.API_STATUS,
			)
			if (autoRetryApiReqIndex !== -1) {
				const diracMessages = this.messageStateHandler.getDiracMessages()
				const msg = diracMessages[autoRetryApiReqIndex]
				if (msg.content.type === DiracMessageType.API_STATUS) {
					const currentApiReqInfo = { ...msg.content.status }
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateDiracMessage(autoRetryApiReqIndex, {
						content: {
							type: DiracMessageType.API_STATUS,
							status: currentApiReqInfo,
						},
					})
				}
			}

			const deadline = Date.now() + delay
			while (Date.now() < deadline && !this.taskState.abort) {
				await setTimeoutPromise(Math.min(200, deadline - Date.now()))
			}
			// If the user aborted during the retry delay, stop retrying
			if (this.taskState.abort) {
				await autoRetryCard.update({
					header: "API Error (Cancelled)",
					body: `API Error (attempt ${this.taskState.apiErrorRetryAttempts}/3). Cancelled.`,
				})
				await autoRetryCard.finalize(CardStatus.CANCELLED)
				throw new Error("Task instance aborted")
			}
			await autoRetryCard.update({ body: `API Error (attempt ${this.taskState.apiErrorRetryAttempts}/3). Retrying...` })
			await autoRetryCard.finalize(CardStatus.ERROR)
		} else {
			if (!isDiracProviderInsufficientCredits && !isAuthError) {
				await this.taskMessenger.createCard({
					status: CardStatus.ERROR,
					header: "API Error (Retries Exhausted)",
					body: `The API request failed after 3 attempts. ${diracError.toDisplayMessage()}`,
				})
			}
			if (isAuthError) {
				await this.taskMessenger.createCard({
					status: CardStatus.ERROR,
					header: "API Error (Authentication)",
					body: diracError.toDisplayMessage(),
				})
			}
			this.taskState.status = TaskStatus.AWAITING_USER_INPUT

			const cardHandle = await this.taskMessenger.createCard({
				requireApproval: true,
				header: "API Request Failed",
				body: diracError.toDisplayMessage(),
				actions: [
					{ label: "Retry", value: DiracAskResponse.APPROVE, primary: true },
					{ label: "Cancel", value: DiracAskResponse.REJECT },
				],
			})
			try {
				const askResult = await cardHandle.waitForInteraction()
				response = askResult.response
			} catch (error) {
				if (error instanceof ToolSkippedByUserMessage) {
					await cardHandle.finalize(CardStatus.CANCELLED)
					this.taskState.pendingUserMessage = error.userMessage
					this.taskState.pendingUserImages = error.userImages
					this.taskState.pendingUserFiles = error.userFiles
					response = DiracAskResponse.APPROVE
				} else {
					throw error
				}
			}
			if (response === DiracAskResponse.APPROVE) {
				this.taskState.apiErrorRetryAttempts = 0
			}
		}

		if (response !== DiracAskResponse.APPROVE) {
			throw new Error("API request failed")
		}

		const manualRetryApiReqIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(m) => m.content.type === DiracMessageType.API_STATUS,
		)
		if (manualRetryApiReqIndex !== -1) {
			const diracMessages = this.messageStateHandler.getDiracMessages()
			const msg = diracMessages[manualRetryApiReqIndex]
			if (msg.content.type === DiracMessageType.API_STATUS) {
				const currentApiReqInfo = { ...msg.content.status }
				delete currentApiReqInfo.streamingFailedMessage
				await this.messageStateHandler.updateDiracMessage(manualRetryApiReqIndex, {
					content: {
						type: DiracMessageType.API_STATUS,
						status: currentApiReqInfo,
					},
				})
			}
		}

		await this.taskMessenger.upsertText("Retrying API request...")

		return true
	}

	private async resetStreamingState(): Promise<void> {
		this.responseProcessor.resetStreamState()
		this.taskState.assistantMessageContent = []
		this.taskState.didCompleteReadingStream = false
		this.taskState.userMessageContent = []
		this.taskState.userMessageContentReady = false
		this.taskState.didRejectTool = false
		this.taskState.didAlreadyUseTool = false
		await this.diffViewProvider.reset()
		this.streamHandler.reset()
		this.taskState.toolUseIdMap.clear()
		this.taskState.activeVoiceStreamId = undefined
	}

	private async processStreamResult(params: {
		assistantHasContent: boolean
		stopReason?: string
		userContent: DiracContent[]
		metricsManager: StreamingMetricsManager
		modelInfo: DiracMessageModelInfo
		providerId: string
		model: { id: string }
	}): Promise<boolean> {
		if (params.assistantHasContent) {
			this.taskState.status = TaskStatus.AWAITING_USER_INPUT

			await pWaitFor(() => this.taskState.userMessageContentReady)
			const hasMutatingTools = this.taskState.assistantMessageContent.some(
				(block) => block.type === "tool_use" && isMutatingTool(block.name),
			)
			if (hasMutatingTools) {
				await this.checkpointManager?.saveCheckpoint()
			}

			const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")
			if (this.taskState.didAttemptCompletion) {
				this.taskState.status = TaskStatus.COMPLETED
				await this.postStateToWebview()
				return true
			}
			const hitTokenLimit =
				params.stopReason === "MAX_TOKENS" || params.stopReason === "max_tokens" || params.stopReason === "length"

			if (!didToolUse) {
				this.taskState.userMessageContent.push({
					type: "text",
					text: hitTokenLimit
						? "You have reached the output token limit. Please continue your response from where you left off. If you were in the middle of a tool call, start over with that tool call. If you were finished, call attempt_completion."
						: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
				})
				this.taskState.consecutiveMistakeCount++
			}

			this.taskState.apiErrorRetryAttempts = 0
			this.taskState.emptyResponseRetryAttempts = 0

			if (this.taskState.pendingUserMessage) {
				this.taskState.userMessageContent.push({
					type: "text",
					text: this.taskState.pendingUserMessage,
				})
				if (this.taskState.pendingUserImages?.length) {
					this.taskState.userMessageContent.push(...formatResponse.imageBlocks(this.taskState.pendingUserImages))
				}
				if (this.taskState.pendingUserFiles?.length) {
					const fileContent = await processFilesIntoText(this.taskState.pendingUserFiles)
					if (fileContent) {
						this.taskState.userMessageContent.push({ type: "text", text: fileContent })
					}
				}
				this.taskState.pendingUserMessage = undefined
				this.taskState.pendingUserImages = undefined
				this.taskState.pendingUserFiles = undefined
			}

			return await this.recursivelyMakeDiracRequests(this.taskState.userMessageContent)
		}
		const taskMetrics = params.metricsManager.getMetrics()
		const shouldRetry = await this.handleEmptyAssistantResponse({
			modelInfo: params.modelInfo,
			taskMetrics,
			providerId: params.providerId,
			model: params.model,
		})
		if (shouldRetry === false) {
			this.taskState.consecutiveMistakeCount = 0
			return await this.recursivelyMakeDiracRequests(params.userContent)
		}
		return true
	}

	async *attemptApiRequest(previousApiReqIndex: number, lastApiReqIndex: number, shouldCompact?: boolean): ApiStream {
		const { systemPrompt, toolSnapshot, contextManagementMetadata, providerInfo } = await this.buildApiRequestParams({
			previousApiReqIndex,
			shouldCompact,
		})
		const { model, providerId } = providerInfo

		const metricsManager = new StreamingMetricsManager(this.messageStateHandler, lastApiReqIndex, this.api)

		const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
			await metricsManager.updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)
			await this.messageStateHandler.updateDiracMessage(lastApiReqIndex, {})
			this.taskState.isApiRequestActive = false
			this.taskState.activeVoiceStreamId = undefined
		}

		const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
			this.taskState.didFinishAbortingStream = true
			await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
			this.taskState.isApiRequestActive = false
			this.taskState.activeVoiceStreamId = undefined
		}

		const stream = this.api.createMessage(
			systemPrompt,
			contextManagementMetadata.truncatedConversationHistory as any,
			toolSnapshot.nativeTools,
		)
		const iterator = stream[Symbol.asyncIterator]()

		try {
			this.taskState.status = TaskStatus.WAITING_FOR_API

			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			this.taskState.isWaitingForFirstChunk = false

			if (firstChunk.done) {
				await finalizeApiReqMsg()
				return
			}

			yield firstChunk.value

			for await (const chunk of iterator) {
				if (this.taskState.abort) {
					await abortStream("user_cancelled")
					return
				}

				if (chunk.type === "usage") {
					metricsManager.updateFromChunk(chunk)
					yield chunk
					continue
				}

				yield chunk
			}

			recordSuccessfulModelProviderPreset(
				this.stateManager,
				providerId as import("@shared/api").ApiProvider,
				model.id,
				model.info,
				providerInfo.mode,
			)
			await finalizeApiReqMsg()
		} catch (error) {
			const shouldRetry = await this.handleApiRequestError({
				error,
				previousApiReqIndex,
				lastApiReqIndex,
				shouldCompact,
				model,
				providerId,
				metricsManager,
			})
			if (shouldRetry) {
				yield* this.attemptApiRequest(previousApiReqIndex, lastApiReqIndex, shouldCompact)
			}
			return
		}
	}

	async presentAssistantMessage() {
		return this.responseProcessor.presentAssistantMessage()
	}

	async recursivelyMakeDiracRequests(userContent: DiracContent[], includeFileDetails = false): Promise<boolean> {
		this.taskState.status = TaskStatus.PREPARING

		if (this.taskState.abort) {
			throw new Error("Task instance aborted")
		}

		const { model, providerId, customPrompt, mode } = this.getCurrentProviderInfo()
		if (providerId && model.id) {
			try {
				await this.modelContextTracker.recordModelUsage(providerId, model.id, mode)
			} catch {}
		}

		const modelInfo: DiracMessageModelInfo = {
			modelId: model.id,
			providerId: providerId,
			mode: mode,
		}

		const mistakeResult = await this.handleMistakeLimitReached(userContent)
		if (mistakeResult.didEndLoop) {
			return true
		}
		userContent = mistakeResult.userContent

		const previousApiReqIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(m) => m.content.type === DiracMessageType.API_STATUS,
		)
		const isFirstRequest =
			this.messageStateHandler.getDiracMessages().filter((m) => m.content.type === DiracMessageType.API_STATUS).length === 0

		await this.initializeCheckpoints(isFirstRequest)

		const useCompactPrompt = customPrompt === "compact" && isLocalModel(this.getCurrentProviderInfo())
		const shouldCompact = await this.determineContextCompaction(previousApiReqIndex)

		this.taskState.status = TaskStatus.BUILDING_REQUEST

		const apiRequestData = await this.apiConversationManager.prepareApiRequest({
			userContent,
			shouldCompact,
			includeFileDetails,
			useCompactPrompt,
			previousApiReqIndex,
			isFirstRequest,
			providerId,
			modelId: model.id,
			mode: modelInfo.mode,
		})
		userContent = apiRequestData.userContent
		const lastApiReqIndex = apiRequestData.lastApiReqIndex

		if (apiRequestData.isDirectResponse && apiRequestData.directResponseText) {
			await this.taskMessenger.upsertText(apiRequestData.directResponseText)
			return true
		}

		try {
			const metricsManager = new StreamingMetricsManager(this.messageStateHandler, lastApiReqIndex, this.api)
			let didFinalizeApiReqMsg = false
			let usageChunkSideEffectsQueue = Promise.resolve()

			const queueUsageChunkSideEffects = (
				usageInputTokens: number,
				usageOutputTokens: number,
				chunkOptions?: { cacheWriteTokens?: number; cacheReadTokens?: number; totalCost?: number; stopReason?: string },
			) => {
				usageChunkSideEffectsQueue = usageChunkSideEffectsQueue.then(async () => {
					if (didFinalizeApiReqMsg || this.taskState.abort) {
						return
					}

					await metricsManager.updateApiReqMsgFromMetrics()
					await this.postStateToWebview()
					await telemetryService.captureTokenUsage(
						this.ulid,
						usageInputTokens,
						usageOutputTokens,
						providerId,
						model.id,
						chunkOptions,
					)
				})
			}

			const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				didFinalizeApiReqMsg = true
				await usageChunkSideEffectsQueue
				await metricsManager.updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)

				const metrics = metricsManager.getMetrics()
				this.taskState.totalInputTokens += metrics.inputTokens
				this.taskState.totalOutputTokens += metrics.outputTokens
				this.taskState.totalReasoningTokens += metrics.reasoningTokens
				this.taskState.totalCacheWriteTokens += metrics.cacheWriteTokens
				this.taskState.totalCacheReadTokens += metrics.cacheReadTokens
				this.taskState.totalCost += metricsManager.getTotalCost()

				const currentApiReqIndex = findLastIndex(
					this.messageStateHandler.getDiracMessages(),
					(m) => m.content.type === DiracMessageType.API_STATUS,
				)
				if (currentApiReqIndex !== -1) {
					this.taskState.isApiRequestActive = false
					this.taskState.activeVoiceStreamId = undefined
				}
			}

			const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()

				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges()
				}

				const diracMessages = this.messageStateHandler.getDiracMessages()
				diracMessages.forEach((msg) => {
					Logger.log("updating partial message", msg)
				})
				this.taskState.isApiRequestActive = false
				this.taskState.activeVoiceStreamId = undefined
				await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
				await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()

				const metrics = metricsManager.getMetrics()
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
					modelInfo,
					metrics: {
						tokens: {
							prompt: metrics.inputTokens,
							completion: metrics.outputTokens,
							cached: (metrics.cacheWriteTokens ?? 0) + (metrics.cacheReadTokens ?? 0),
						},
						cost: metrics.totalCost,
					},
					ts: Date.now(),
				})

				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					modelInfo.modelId,
					"assistant",
					modelInfo.mode,
					undefined,
					this.taskState.useNativeToolCalls,
				)

				this.taskState.didFinishAbortingStream = true
			}

			await this.resetStreamingState()

			const { toolUseHandler, reasonsHandler } = this.streamHandler.getHandlers()
			const stream = this.attemptApiRequest(previousApiReqIndex, lastApiReqIndex, shouldCompact)

			let assistantMessageId = ""
			let assistantMessage = ""
			let assistantTextOnly = ""
			let assistantTextSignature: string | undefined

			let didReceiveUsageChunk = false
			let stopReason: string | undefined
			let didFinalizeReasoningForUi = false

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				const activeVoiceStreamId = this.taskState.activeVoiceStreamId
				if (!activeVoiceStreamId) {
					return false
				}

				const messages = this.messageStateHandler.getDiracMessages()
				const pendingReasoningIndex = messages.findIndex((m) => m.id === activeVoiceStreamId)

				if (pendingReasoningIndex !== -1) {
					const msg = messages[pendingReasoningIndex]
					if (msg.content.type === DiracMessageType.MARKDOWN && msg.content.isReasoning) {
						await this.messageStateHandler.updateDiracMessage(pendingReasoningIndex, {
							content: { type: DiracMessageType.MARKDOWN, content: thinking, isReasoning: true },
						})
						const completedReasoning = this.messageStateHandler.getDiracMessages()[pendingReasoningIndex]
						if (completedReasoning) {
							await this.postStateToWebview()
						}
						this.taskState.activeVoiceStreamId = undefined
						return true
					}
				}
				return false
			}

			Session.get().startApiCall()
			this.taskState.isApiRequestActive = true
			let streamCoordinator: StreamChunkCoordinator | undefined

			try {
				streamCoordinator = new StreamChunkCoordinator(stream, {
					onUsageChunk: (chunk) => {
						this.streamHandler.setRequestId(chunk.id)
						didReceiveUsageChunk = true
						metricsManager.updateFromChunk(chunk)
						stopReason = chunk.stopReason ?? stopReason
						queueUsageChunkSideEffects(chunk.inputTokens, chunk.outputTokens, {
							cacheWriteTokens: chunk.cacheWriteTokens,
							cacheReadTokens: chunk.cacheReadTokens,
							totalCost: chunk.totalCost,
							stopReason: chunk.stopReason,
						})
					},
				})

				const streamResult = await this.responseProcessor.consumeStream(streamCoordinator, {
					abortStream,
					finalizePendingReasoningMessage,
					apiAbort: () => this.api.abort?.(),
				})

				assistantMessage = streamResult.assistantMessage
				assistantTextOnly = streamResult.assistantTextOnly
				assistantTextSignature = streamResult.assistantTextSignature
				assistantMessageId = streamResult.assistantMessageId
				didFinalizeReasoningForUi = streamResult.didFinalizeReasoningForUi
				const shouldInterruptStream = streamResult.shouldInterruptStream

				if (shouldInterruptStream) {
					await streamCoordinator.stop()
				} else {
					await streamCoordinator.waitForCompletion()
				}
				await usageChunkSideEffectsQueue

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						await finalizePendingReasoningMessage(finalReasoning.thinking)
						didFinalizeReasoningForUi = true
					}
				}
			} catch (error) {
				await streamCoordinator?.stop()
				if (!this.taskState.abandoned) {
					const diracError = ErrorService.get().toDiracError(error, this.api.getModel().id)
					const errorMessage = diracError.serialize()
					this.abortTask()
					await abortStream("streaming_failed", errorMessage)
					await this.reinitExistingTaskFromId(this.taskId)
				}
			} finally {
				Session.get().endApiCall()
			}

			if (!didReceiveUsageChunk) {
				const apiStreamUsage = await this.api.getApiStreamUsage?.()
				if (apiStreamUsage) {
					metricsManager.updateFromChunk(apiStreamUsage)
					queueUsageChunkSideEffects(apiStreamUsage.inputTokens, apiStreamUsage.outputTokens, {
						cacheWriteTokens: apiStreamUsage.cacheWriteTokens,
						cacheReadTokens: apiStreamUsage.cacheReadTokens,
						totalCost: apiStreamUsage.totalCost,
						stopReason: apiStreamUsage.stopReason,
					})
				}
			}

			const autoRetryApiReqIndex = findLastIndex(
				this.messageStateHandler.getDiracMessages(),
				(m) => m.content.type === DiracMessageType.API_STATUS,
			)
			if (autoRetryApiReqIndex !== -1) {
				const diracMessages = this.messageStateHandler.getDiracMessages()
				const msg = diracMessages[autoRetryApiReqIndex]
				if (msg.content.type === DiracMessageType.API_STATUS) {
					const content = msg.content as Extract<DiracMessageContent, { type: DiracMessageType.API_STATUS }>
					const currentApiReqInfo = { ...content.status }
					delete currentApiReqInfo.retryStatus
					await this.messageStateHandler.updateDiracMessage(autoRetryApiReqIndex, {
						content: {
							type: DiracMessageType.API_STATUS,
							status: currentApiReqInfo,
						},
					})
				}
			}

			await finalizeApiReqMsg()
			await this.persistApiStopReason(stopReason)
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.postStateToWebview()

			if (this.taskState.abort) {
				throw new Error("Dirac instance aborted")
			}

			const assistantHasContent = await this.processAssistantResponse({
				assistantMessage,
				assistantTextOnly,
				assistantTextSignature,
				assistantMessageId,
				providerId,
				modelId: model.id,
				mode: modelInfo.mode,
				taskMetrics: metricsManager.getMetrics(),
				modelInfo,
				toolUseHandler,
			})

			return await this.processStreamResult({
				assistantHasContent,
				stopReason,
				userContent,
				metricsManager,
				modelInfo,
				providerId,
				model,
			})
		} catch (error) {
			if (this.taskState.abort) {
				// User-initiated abort — not a fatal error, no card needed
				return true
			}
			const diracError = ErrorService.get().toDiracError(error)
			Logger.error("[Task] Fatal error in task loop:", diracError.serialize())
			try {
				const card = await this.taskMessenger.createCard({
					status: CardStatus.ERROR,
					header: "Task Error",
					body: `The task encountered an unexpected error and had to stop.\n\n${diracError.toDisplayMessage()}`,
				})
				await card.finalize(CardStatus.ERROR)
			} catch (sayError) {
				Logger.error("[Task] Failed to emit error message:", sayError)
			}
			return true
		}
	}
	private async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		return this.lifecycleManager.initializeCheckpoints(isFirstRequest)
	}

	private async determineContextCompaction(previousApiReqIndex: number): Promise<boolean> {
		return this.apiConversationManager.determineContextCompaction(previousApiReqIndex)
	}

	private async processAssistantResponse(params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: Mode
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		modelInfo: DiracMessageModelInfo
		toolUseHandler: ReturnType<StreamResponseHandler["getHandlers"]>["toolUseHandler"]
	}): Promise<boolean> {
		return this.responseProcessor.routeAssistantResponse(params)
	}

	private async handleEmptyAssistantResponse(params: {
		modelInfo: DiracMessageModelInfo
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: any
	}): Promise<boolean> {
		return this.responseProcessor.handleEmptyAssistantResponse(params)
	}
}
