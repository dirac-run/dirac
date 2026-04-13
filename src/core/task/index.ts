import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiHandler, ApiProviderInfo, buildApiHandler } from "@core/api"
import { ApiStream } from "@core/api/transform/stream"
import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"

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
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"

import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"

import { CommandPermissionController } from "@core/permissions"

import { formatResponse } from "@core/prompts/responses"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { getSystemPrompt } from "@core/prompts/system-prompt"
import { detectBestShell } from "@/utils/shell-detection"
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
import { ApiConfiguration } from "@shared/api"
import { findLastIndex } from "@shared/array"
import { DiracClient } from "@shared/dirac"
import { DiracApiReqCancelReason, DiracApiReqInfo, DiracAsk, DiracSay, MultiCommandState } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import {
	DiracContent,
	DiracStorageMessage,
	DiracTextContentBlock,
	DiracToolResponseContent,
	DiracUserContent,
} from "@shared/messages/content"
import { DiracMessageModelInfo } from "@shared/messages/metrics"
import { ApiFormat } from "@shared/proto/dirac/models"
import { ShowMessageType } from "@shared/proto/index.host"
import { convertDiracMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Logger } from "@shared/services/Logger"
import { Session } from "@shared/services/Session"
import { DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { isFrontierModel, isLocalModel, isParallelToolCallingEnabled } from "@utils/model-utils"
import fs from "fs/promises"
import Mutex from "p-mutex"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { ulid } from "ulid"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"

import { discoverSkills, getAvailableSkills } from "../context/instructions/user-instructions/skills"

import { Controller } from "../controller"

import { StateManager } from "../storage/StateManager"
import { ApiConversationManager } from "./ApiConversationManager"
import { ContextLoader } from "./ContextLoader"
import { EnvironmentManager } from "./EnvironmentManager"
import { HookManager } from "./HookManager"
import { LifecycleManager } from "./LifecycleManager"
import { MessageStateHandler } from "./message-state"
import { ResponseProcessor } from "./ResponseProcessor"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { TaskMessenger } from "./TaskMessenger"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
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
	taskLockAcquired: boolean
}

export class Task {
	// Core task variables
	readonly taskId: string
	readonly ulid: string
	private taskIsFavorited?: boolean
	private cwd: string
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
			taskLockAcquired,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		if (stateManager.getGlobalSettingsKey("mode") === "act") {
			this.taskState.didSwitchToActMode = true
		}
		this.controller = controller
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.diracIgnoreController = new DiracIgnoreController(cwd)
		this.diracIgnoreController.yoloMode = !!stateManager.getGlobalSettingsKey("yoloModeToggled")

		this.commandPermissionController = new CommandPermissionController()
		this.taskLockAcquired = taskLockAcquired
		// Determine terminal execution mode and create appropriate terminal manager
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"

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
		this.cwd = cwd
		this.stateManager = stateManager
		this.workspaceManager = workspaceManager

		// DiffViewProvider opens Diff Editor during edits while FileEditProvider performs
		// edits in the background without stealing user's editor's focus.
		const backgroundEditEnabled = this.stateManager.getGlobalSettingsKey("backgroundEditEnabled")
		this.diffViewProvider = backgroundEditEnabled ? new FileEditProvider() : HostProvider.get().createDiffViewProvider()

		this.taskId = taskId
		AnchorStateManager.reset(this.taskId)

		// Initialize taskId first
		if (historyItem) {
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			this.ulid = ulid()
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
					say: this.say.bind(this),
					cancelTask: this.cancelTask,
					postStateToWebview: this.postStateToWebview,
					initialConversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					initialCheckpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
					stateManager: this.stateManager,
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
				const diracMessages = this.messageStateHandler.getDiracMessages()
				const lastApiReqStartedIndex = findLastIndex(diracMessages, (m) => m.say === "api_req_started")
				if (lastApiReqStartedIndex !== -1) {
					try {
						const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[lastApiReqStartedIndex].text || "{}")
						currentApiReqInfo.retryStatus = {
							attempt: attempt, // attempt is already 1-indexed from retry.ts
							maxAttempts: maxRetries, // total attempts
							delaySec: Math.round(delay / 1000),
							errorSnippet: error?.message ? `${String(error.message).substring(0, 50)}...` : undefined,
						}
						// Clear previous cancelReason and streamingFailedMessage if we are retrying
						delete currentApiReqInfo.cancelReason
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateDiracMessage(lastApiReqStartedIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})

						// Post the updated state to the webview so the UI reflects the retry attempt
						await this.postStateToWebview().catch((e) =>
							Logger.error("Error posting state to webview in onRetryAttempt:", e),
						)
					} catch (e) {
						Logger.error(`[Task ${this.taskId}] Error updating api_req_started with retryStatus:`, e)
					}
				}
			},
		}
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		// Now that ulid is initialized, we can build the API handler
		this.api = buildApiHandler(effectiveApiConfiguration, mode)

		// Set ulid on browserSession for telemetry tracking
		this.browserSession.setUlid(this.ulid)

		// Note: Task initialization (startTask/resumeTaskFromHistory) is now called
		// from Controller.initTask() AFTER the task instance is fully assigned.
		// This prevents race conditions where hooks run before controller.task is ready.


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
			say: this.say.bind(this) as CommandExecutorCallbacks["say"],
			ask: async (type: string, text?: string, partial?: boolean) => {
				const result = await this.ask(type as DiracAsk, text, partial)
				return {
					response: result.response,
					text: result.text,
					images: result.images,
					files: result.files,
					askTs: result.askTs,
				}
			},
			updateBackgroundCommandState: (isRunning: boolean) =>
				this.controller.updateBackgroundCommandState(isRunning, this.taskId),
			updateDiracMessage: async (index: number, updates: { commandCompleted?: boolean; text?: string }) => {
				await this.messageStateHandler.updateDiracMessage(index, updates)
				await this.postStateToWebview()
			},
			getDiracMessages: () => this.messageStateHandler.getDiracMessages() as Array<{ ask?: string; say?: string }>,
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
			this.stateManager,
			cwd,
			this.taskId,
			this.ulid,
			this.terminalExecutionMode,
			this.workspaceManager,
			isMultiRootEnabled(this.stateManager),
			this.say.bind(this),
			this.ask.bind(this),
			this.saveCheckpointCallback.bind(this),
			this.sayAndCreateMissingParamError.bind(this),
			this.removeLastPartialMessageIfExistsWithType.bind(this),
			this.executeCommandTool.bind(this),
			this.cancelBackgroundCommand.bind(this),
			() => this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			this.switchToActModeCallback.bind(this),
			this.cancelTask,
			this.postStateToWebview.bind(this),
			// Atomic hook state helpers for ToolExecutor
			this.setActiveHookExecution.bind(this),
			this.clearActiveHookExecution.bind(this),
			this.getActiveHookExecution.bind(this),
			this.runUserPromptSubmitHook.bind(this),
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
			controller: this.controller,
			cwd: this.cwd,
			urlContentFetcher: this.urlContentFetcher,
			fileContextTracker: this.fileContextTracker,
			workspaceManager: this.workspaceManager,
			diracIgnoreController: this.diracIgnoreController,
			taskState: this.taskState,
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getEnvironmentDetails: this.getEnvironmentDetails.bind(this),
		})

		this.taskMessenger = new TaskMessenger({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			postStateToWebview: this.postStateToWebview,
			stateManager: this.stateManager,
			taskId: this.taskId,
			api: this.api,
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
		})

		this.hookManager = new HookManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			stateManager: this.stateManager,
			api: this.api,
			taskId: this.taskId,
			ulid: this.ulid,
			say: this.say.bind(this),
			postStateToWebview: this.postStateToWebview,
			cancelTask: this.cancelTask,
			withStateLock: this.withStateLock.bind(this),
			shouldRunBackgroundCheck: () => this.commandExecutor.hasActiveBackgroundCommand(),
		})

		this.lifecycleManager = new LifecycleManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			stateManager: this.stateManager,
			api: this.api,
			taskId: this.taskId,
			ulid: this.ulid,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
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
			cwd: this.cwd,
			hookManager: this.hookManager,
			initiateTaskLoop: this.initiateTaskLoop.bind(this),
			recordEnvironment: () => this.environmentContextTracker.recordEnvironment(),
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
			say: this.say.bind(this),
			ask: this.ask.bind(this),
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
		})

		this.responseProcessor = new ResponseProcessor({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
			stateManager: this.stateManager,
			taskId: this.taskId,
			ulid: this.ulid,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
			postStateToWebview: this.postStateToWebview,
			diffViewProvider: this.diffViewProvider,
			streamHandler: this.streamHandler,
			withStateLock: this.withStateLock.bind(this),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getApiRequestIdSafe: this.getApiRequestIdSafe.bind(this),
			toolExecutor: this.toolExecutor,
		})
	}

	// Communicate with webview

	async ask(type: DiracAsk, text?: string, partial?: boolean, multiCommandState?: MultiCommandState) {
		return this.taskMessenger.ask(type, text, partial, multiCommandState)
	}

	async handleWebviewAskResponse(askResponse: DiracAskResponse, text?: string, images?: string[], files?: string[]) {
		return this.taskMessenger.handleWebviewAskResponse(askResponse, text, images, files)
	}

	async say(
		type: DiracSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
	): Promise<number | undefined> {
		return this.taskMessenger.say(type, text, images, files, partial)
	}

	async sayAndCreateMissingParamError(toolName: DiracDefaultTool, paramName: string, relPath?: string) {
		return this.taskMessenger.sayAndCreateMissingParamError(toolName, paramName, relPath)
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: DiracAsk | DiracSay) {
		return this.taskMessenger.removeLastPartialMessageIfExistsWithType(type, askOrSay)
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void> {
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageTs) ?? Promise.resolve()
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

	private async handleHookCancellation(hookName: string, wasCancelled: boolean): Promise<void> {
		return this.hookManager.handleHookCancellation(hookName, wasCancelled)
	}

	private calculatePreCompactDeletedRange(apiConversationHistory: DiracStorageMessage[]): [number, number] {
		return this.apiConversationManager.calculatePreCompactDeletedRange(apiConversationHistory)
	}

	private async runUserPromptSubmitHook(
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		return this.hookManager.runUserPromptSubmitHook(userContent, context)
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		return this.lifecycleManager.startTask(task, images, files)
	}

	public async resumeTaskFromHistory() {
		return this.lifecycleManager.resumeTaskFromHistory()
	}

	private async initiateTaskLoop(userContent: DiracContent[]): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.taskState.abort) {
			const didEndLoop = await this.recursivelyMakeDiracRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // we only need file details the first time

			//  The way this agentic loop works is that dirac will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			}
			// this.say(
			// 	"tool",
			// 	"Dirac responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
			// )
			nextUserContent = [
				{
					type: "text",
					text: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
				},
			]
			this.taskState.consecutiveMistakeCount++
		}
	}

	private async shouldRunTaskCancelHook(): Promise<boolean> {
		return this.hookManager.shouldRunTaskCancelHook()
	}

	async abortTask() {
		return this.lifecycleManager.abortTask()
	}

	// Tools
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, DiracToolResponseContent]> {
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
			const configuredDir =
				process.env.DIRAC_PROMPT_ARTIFACT_DIR?.trim() ||
				this.stateManager.getGlobalSettingsKey("writePromptMetadataDirectory")?.trim()
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? configuredDir
					: path.resolve(this.cwd, configuredDir)
				: path.resolve(this.cwd, ".dirac-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })

			const ts = new Date().toISOString()
			const debugPath = path.join(artifactDir, `task-${this.taskId}-debug.md`)

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
								markdown += `${block.text}\n\n`
							} else if (block.type === "thinking") {
								markdown += `**Thinking:**\n${block.thinking}\n\n`
							} else if (block.type === "redacted_thinking") {
								markdown += `**Thinking:** [Redacted]\n\n`
							} else if (block.type === "tool_use") {
								markdown += `**Tool Use:** \`${block.name}\` (\`${block.id}\`)\n`
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

	async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
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

		const { globalToggles, localToggles } = await refreshDiracRulesToggles(this.controller, this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.controller,
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
		const allSkills = await discoverSkills(this.cwd)
		const resolvedSkills = getAvailableSkills(allSkills)

		// Filter skills by toggle state (enabled by default)
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
			// If toggle exists, use it; otherwise default to enabled (true)
			return toggles[skill.path] !== false
		})

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
			enableNativeToolCalls:
				providerInfo.model.info.apiFormat === ApiFormat.OPENAI_RESPONSES ||
				this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			terminalExecutionMode: this.terminalExecutionMode,
			activeShellType: shellInfo.type,
			activeShellPath: shellInfo.path,
			activeShellIsPosix: shellInfo.isPosix,
		}

		// Notify user if any conditional rules were applied for this request
		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			await this.say("conditional_rules_applied", JSON.stringify({ rules: activatedConditionalRules }))
		}

		const { systemPrompt, tools } = await getSystemPrompt(promptContext)
		this.taskState.useNativeToolCalls = !!tools?.length

		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getDiracMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			previousApiReqIndex,
			await ensureTaskDirectoryExists(this.taskId),
			this.stateManager.getGlobalSettingsKey("useAutoCondense") && isFrontierModel(this.api.getModel().id),
		)

		await this.writePromptMetadataArtifacts({
			systemPrompt,
			providerInfo,
			tools,
			fullHistory: this.messageStateHandler.getApiConversationHistory(),
			deletedRange: this.taskState.conversationHistoryDeletedRange,
		})

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			// saves task history item which we use to keep track of conversation history deleted range
		}

		// Response API requires native tool calls to be enabled
		const stream = this.api.createMessage(systemPrompt, contextManagementMetadata.truncatedConversationHistory as any, tools)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			// awaiting first chunk to see if it will throw an error
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.taskState.isWaitingForFirstChunk = false
		} catch (error) {
			const isContextWindowExceededError = checkContextWindowExceededError(error)
			const { model, providerId } = this.getCurrentProviderInfo()
			const diracError = ErrorService.get().toDiracError(error, model.id, providerId)

			// Capture provider failure telemetry using diracError
			ErrorService.get().logMessage(diracError.message)

			if (isContextWindowExceededError && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				await this.handleContextWindowExceededError()
			} else {
				// request failed after retrying automatically once, ask user if they want to retry again
				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

				if (isContextWindowExceededError) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
					)

					// If the conversation has more than 3 messages, we can truncate again. If not, then the conversation is bricked.
					// ToDo: Allow the user to change their input if this is the case.
					if (truncatedConversationHistory.length > 3) {
						diracError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = diracError.serialize()

				// Update the 'api_req_started' message to reflect final failure before asking user to manually retry
				const lastApiReqStartedIndex = findLastIndex(
					this.messageStateHandler.getDiracMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const diracMessages = this.messageStateHandler.getDiracMessages()
					const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[lastApiReqStartedIndex].text || "{}")
					delete currentApiReqInfo.retryStatus

					await this.messageStateHandler.updateDiracMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
							// cancelReason: "retries_exhausted", // Indicate that automatic retries failed
							streamingFailedMessage,
						} satisfies DiracApiReqInfo),
					})
					// this.ask will trigger postStateToWebview, so this change should be picked up.
				}

				const isAuthError = diracError.isErrorType(DiracErrorType.Auth)

				// Check if this is a Dirac provider insufficient credits error - don't auto-retry these
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
				// Skip auto-retry for Dirac provider insufficient credits or auth errors
				if (!isDiracProviderInsufficientCredits && !isAuthError && this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

					await updateApiReqMsg({
						messageStateHandler: this.messageStateHandler,
						lastApiReqIndex: lastApiReqStartedIndex,
						inputTokens: 0,
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

					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: streamingFailedMessage,
						}),
					)

					// Clear streamingFailedMessage now that error_retry contains it
					// This prevents showing the error in both ErrorRow and error_retry
					const autoRetryApiReqIndex = findLastIndex(
						this.messageStateHandler.getDiracMessages(),
						(m) => m.say === "api_req_started",
					)
					if (autoRetryApiReqIndex !== -1) {
						const diracMessages = this.messageStateHandler.getDiracMessages()
						const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[autoRetryApiReqIndex].text || "{}")
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateDiracMessage(autoRetryApiReqIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})
					}

					await setTimeoutPromise(delay)
				} else {
					// Show error_retry with failed flag to indicate all retries exhausted (but not for insufficient credits)
					if (!isDiracProviderInsufficientCredits && !isAuthError) {
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true, // Special flag to indicate retries exhausted
								errorMessage: streamingFailedMessage,
							}),
						)
					}
					const askResult = await this.ask("api_req_failed", streamingFailedMessage)
					response = askResult.response
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}

				// Clear streamingFailedMessage when user manually retries
				const manualRetryApiReqIndex = findLastIndex(
					this.messageStateHandler.getDiracMessages(),
					(m) => m.say === "api_req_started",
				)
				if (manualRetryApiReqIndex !== -1) {
					const diracMessages = this.messageStateHandler.getDiracMessages()
					const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[manualRetryApiReqIndex].text || "{}")
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateDiracMessage(manualRetryApiReqIndex, {
						text: JSON.stringify(currentApiReqInfo),
					})
				}

				await this.say("api_req_retried")

				// Reset the automatic retry flag so the request can proceed
				this.taskState.didAutomaticallyRetryFailedApiRequest = false
			}
			// delegate generator output from the recursive call
			yield* this.attemptApiRequest(previousApiReqIndex)
			return
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		yield* iterator
	}

	async presentAssistantMessage() {
		return this.responseProcessor.presentAssistantMessage()
	}

	async recursivelyMakeDiracRequests(userContent: DiracContent[], includeFileDetails = false): Promise<boolean> {
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

		const previousApiReqIndex = findLastIndex(this.messageStateHandler.getDiracMessages(), (m) => m.say === "api_req_started")
		const isFirstRequest = this.messageStateHandler.getDiracMessages().filter((m) => m.say === "api_req_started").length === 0
		await this.initializeCheckpoints(isFirstRequest)

		const useCompactPrompt = customPrompt === "compact" && isLocalModel(this.getCurrentProviderInfo())
		const shouldCompact = await this.determineContextCompaction(previousApiReqIndex)

		const apiRequestData = await this.prepareApiRequest({
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
		this.taskState.didSwitchToActMode = false // Reset after use
		userContent = apiRequestData.userContent
		const lastApiReqIndex = apiRequestData.lastApiReqIndex

		try {
			const taskMetrics: {
				cacheWriteTokens: number
				cacheReadTokens: number
				inputTokens: number
				outputTokens: number
				totalCost: number | undefined
			} = { cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: undefined }
			let didFinalizeApiReqMsg = false
			let usageChunkSideEffectsQueue = Promise.resolve()

			const updateApiReqMsgFromMetrics = async (
				cancelReason?: DiracApiReqCancelReason,
				streamingFailedMessage?: string,
			) => {
				const modelInfo = this.api.getModel().info
				const contextWindow = modelInfo.contextWindow
				const totalTokens =
					taskMetrics.inputTokens +
					taskMetrics.outputTokens +
					(taskMetrics.cacheWriteTokens || 0) +
					(taskMetrics.cacheReadTokens || 0)
				const contextUsagePercentage = contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined
				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					api: this.api,
					totalCost: taskMetrics.totalCost,
					cancelReason,
					streamingFailedMessage,
					contextWindow,
					contextUsagePercentage,
				})
			}

			const queueUsageChunkSideEffects = (
				usageInputTokens: number,
				usageOutputTokens: number,
				chunkOptions?: { cacheWriteTokens?: number; cacheReadTokens?: number; totalCost?: number; stopReason?: string },
			) => {
				usageChunkSideEffectsQueue = usageChunkSideEffectsQueue
					.then(async () => {
						if (didFinalizeApiReqMsg || this.taskState.abort) {
							return
						}

						await updateApiReqMsgFromMetrics()
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
					.catch((error) => {
						Logger.debug(`[Task ${this.taskId}] Failed to process usage chunk side effects: ${error}`)
					})
			}

			const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				didFinalizeApiReqMsg = true
				await usageChunkSideEffectsQueue
				await updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)
			}

			const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()

				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges()
				}

				const lastMessage = this.messageStateHandler.getDiracMessages().at(-1)
				if (lastMessage?.partial) {
					lastMessage.partial = false
					Logger.log("updating partial message", lastMessage)
				}
				await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
				await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()

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
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
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

			// reset streaming state
			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskState.didRejectTool = false
			this.taskState.didAlreadyUseTool = false
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()
			this.streamHandler.reset()
			this.taskState.toolUseIdMap.clear()

			const { toolUseHandler, reasonsHandler } = this.streamHandler.getHandlers()
			const stream = this.attemptApiRequest(previousApiReqIndex)

			let assistantMessageId = ""
			let assistantMessage = ""
			let assistantTextOnly = ""
			let assistantTextSignature: string | undefined

			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			let stopReason: string | undefined
			let didFinalizeReasoningForUi = false

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				const pendingReasoningIndex = findLastIndex(
					this.messageStateHandler.getDiracMessages(),
					(message) => message.type === "say" && message.say === "reasoning" && message.partial === true,
				)

				if (pendingReasoningIndex === -1) {
					return false
				}

				await this.messageStateHandler.updateDiracMessage(pendingReasoningIndex, {
					text: thinking,
					partial: false,
				})
				const completedReasoning = this.messageStateHandler.getDiracMessages()[pendingReasoningIndex]
				if (completedReasoning) {
					await sendPartialMessageEvent(convertDiracMessageToProto(completedReasoning))
					await this.postStateToWebview()
				}
				return true
			}

			Session.get().startApiCall()
			let streamCoordinator: StreamChunkCoordinator | undefined

			try {
				streamCoordinator = new StreamChunkCoordinator(stream, {
					onUsageChunk: (chunk) => {
						this.streamHandler.setRequestId(chunk.id)
						didReceiveUsageChunk = true
						taskMetrics.inputTokens += chunk.inputTokens
						taskMetrics.outputTokens += chunk.outputTokens
						taskMetrics.cacheWriteTokens += chunk.cacheWriteTokens ?? 0
						taskMetrics.cacheReadTokens += chunk.cacheReadTokens ?? 0
						taskMetrics.totalCost = chunk.totalCost ?? taskMetrics.totalCost
						stopReason = chunk.stopReason ?? stopReason
						queueUsageChunkSideEffects(chunk.inputTokens, chunk.outputTokens, {
							cacheWriteTokens: chunk.cacheWriteTokens,
							cacheReadTokens: chunk.cacheReadTokens,
							totalCost: chunk.totalCost,
							stopReason: chunk.stopReason,
						})
					},
				})

				let shouldInterruptStream = false

				while (true) {
					const chunk = await streamCoordinator.nextChunk()
					if (chunk) {
					}
					if (!chunk) {
						break
					}
					if (!this.taskState.taskFirstTokenTimeMs) {
						this.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.taskState.taskStartTimeMs)
					}

					switch (chunk.type) {
						case "reasoning": {
							const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
							reasonsHandler.processReasoningDelta({
								id: chunk.id,
								reasoning: chunk.reasoning,
								signature: chunk.signature,
								details,
								redacted_data: chunk.redacted_data,
							})

							if (!this.taskState.abort) {
								const thinkingBlock = reasonsHandler.getCurrentReasoning()
								if (thinkingBlock?.thinking && chunk.reasoning && assistantMessage.length === 0) {
									await this.say("reasoning", thinkingBlock.thinking, undefined, undefined, true)
								}
							}
							break
						}
						case "tool_calls": {
							toolUseHandler.processToolUseDelta(
								{
									id: chunk.tool_call.function?.id,
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: chunk.tool_call.function?.arguments,
									signature: chunk?.signature,
								},
								chunk.tool_call.call_id,
							)
							if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
								this.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
							}

							await this.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())
							break
						}
						case "text": {
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const finalizedReasoning = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (finalizedReasoning) {
									didFinalizeReasoningForUi = true
								}
							}
							if (chunk.signature) {
								assistantTextSignature = chunk.signature
							}
							if (chunk.id) {
								assistantMessageId = chunk.id
							}
							assistantMessage += chunk.text
							assistantTextOnly += chunk.text
							const prevLength = this.taskState.assistantMessageContent.length

							this.taskState.assistantMessageContent = parseAssistantMessageV2(assistantMessage)

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false
							}
							break
						}
					}

					await this.presentAssistantMessage().catch((error) =>
						Logger.debug("[Task] Failed to present message: " + error),
					)

					if (this.taskState.abort) {
						this.api.abort?.()
						if (!this.taskState.abandoned) {
							await abortStream("user_cancelled")
						}
						shouldInterruptStream = true
						break
					}

					if (this.taskState.didRejectTool) {
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						shouldInterruptStream = true
						break
					}
				}

				if (shouldInterruptStream) {
					await streamCoordinator.stop()
				} else {
					await streamCoordinator.waitForCompletion()
				}
				await usageChunkSideEffectsQueue

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						const finalizedPendingReasoning = await finalizePendingReasoningMessage(finalReasoning.thinking)
						if (!finalizedPendingReasoning) {
							await this.say("reasoning", finalReasoning.thinking, undefined, undefined, false)
						}
						didFinalizeReasoningForUi = true
					}
				}
			} catch (error) {
				await streamCoordinator?.stop()
				if (!this.taskState.abandoned) {
					const diracError = ErrorService.get().toDiracError(error, this.api.getModel().id)
					const errorMessage = diracError.serialize()
					if (this.taskState.autoRetryAttempts < 3) {
						this.taskState.autoRetryAttempts++

						const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: this.taskState.autoRetryAttempts,
								maxAttempts: 3,
								delaySeconds: delay / 1000,
								errorMessage,
							}),
						)

						setTimeoutPromise(delay).then(async () => {
							if (this.controller.task) {
								this.controller.task.taskState.autoRetryAttempts = this.taskState.autoRetryAttempts
								await this.controller.task.handleWebviewAskResponse("yesButtonClicked", "", [])
							}
						})
					} else if (this.taskState.autoRetryAttempts >= 3) {
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true,
								errorMessage,
							}),
						)
					}

					this.abortTask()
					await abortStream("streaming_failed", errorMessage)
					await this.reinitExistingTaskFromId(this.taskId)
				}
			} finally {
				this.taskState.isStreaming = false
				Session.get().endApiCall()
			}

			if (!didReceiveUsageChunk) {
				const apiStreamUsage = await this.api.getApiStreamUsage?.()
				if (apiStreamUsage) {
					taskMetrics.inputTokens += apiStreamUsage.inputTokens
					taskMetrics.outputTokens += apiStreamUsage.outputTokens
					taskMetrics.cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
					taskMetrics.cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
					taskMetrics.totalCost = apiStreamUsage.totalCost ?? taskMetrics.totalCost
					queueUsageChunkSideEffects(apiStreamUsage.inputTokens, apiStreamUsage.outputTokens, {
						cacheWriteTokens: apiStreamUsage.cacheWriteTokens,
						cacheReadTokens: apiStreamUsage.cacheReadTokens,
						totalCost: apiStreamUsage.totalCost,
						stopReason: apiStreamUsage.stopReason,
					})
				}
			}

			await finalizeApiReqMsg()
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
				taskMetrics,
				modelInfo,
				toolUseHandler,
			})

			let didEndLoop = false
			if (assistantHasContent) {
				await pWaitFor(() => this.taskState.userMessageContentReady)
				await this.checkpointManager?.saveCheckpoint()

				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")
				const hitTokenLimit = stopReason === "MAX_TOKENS" || stopReason === "max_tokens" || stopReason === "length"

				if (!didToolUse) {
					this.taskState.userMessageContent.push({
						type: "text",
						text: hitTokenLimit
							? "You have reached the output token limit. Please continue your response from where you left off. If you were in the middle of a tool call, start over with that tool call. If you were finished, call attempt_completion."
							: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
					})
					this.taskState.consecutiveMistakeCount++
				}

				this.taskState.autoRetryAttempts = 0
				const recDidEndLoop = await this.recursivelyMakeDiracRequests(this.taskState.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				return await this.handleEmptyAssistantResponse({
					modelInfo,
					taskMetrics,
					providerId,
					model,
				})
			}

			return didEndLoop
		} catch (_error) {
			return true
		}
	}

	async loadContext(
		userContent: DiracContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DiracContent[], string, boolean]> {
		return this.contextLoader.loadContext(userContent, includeFileDetails, useCompactPrompt)
	}

	async processNativeToolCalls(assistantTextOnly: string, toolBlocks: ToolUse[]) {
		return this.responseProcessor.processNativeToolCalls(assistantTextOnly, toolBlocks)
	}

	async getEnvironmentDetails(includeFileDetails = false): Promise<string> {
		return this.environmentManager.getEnvironmentDetails(includeFileDetails)
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
			await this.say("error", errorMessage)
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

		const { response, text, images, files } = await this.ask(
			"mistake_limit_reached",
				 `Tool use failure. Can potentially be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
				,
		)

		if (response === "messageResponse") {
			// Display the user's message in the chat UI
			await this.say("user_feedback", text, images, files)

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
		this.taskState.autoRetryAttempts = 0 // need to reset this if the user chooses to manually retry after the mistake limit is reached
		return { didEndLoop: false, userContent }
	}

	private async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		return this.lifecycleManager.initializeCheckpoints(isFirstRequest)
	}

	private async determineContextCompaction(previousApiReqIndex: number): Promise<boolean> {
		return this.apiConversationManager.determineContextCompaction(previousApiReqIndex)
	}

	private async prepareApiRequest(params: {
		userContent: DiracContent[]
		shouldCompact: boolean
		includeFileDetails: boolean
		useCompactPrompt: boolean
		previousApiReqIndex: number
		isFirstRequest: boolean
		providerId: string
		modelId: string
		mode: string
	}): Promise<{ userContent: DiracContent[]; lastApiReqIndex: number }> {
		return this.apiConversationManager.prepareApiRequest(params)
	}

	private async processAssistantResponse(params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: string
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
		return this.responseProcessor.processAssistantResponse(params)
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
