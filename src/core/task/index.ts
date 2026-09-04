import { ApiHandler, ApiProviderInfo, buildApiHandler, validateApiConfiguration } from "@core/api"
import { ApiStream } from "@core/api/transform/stream"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"

import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"

import { CommandPermissionController } from "@core/permissions"
import type { SlashCommandDirectAction } from "@core/slash-commands"
import { createDefaultTextCondensationTemplateRegistry } from "@core/text-condensation/templates"
import { isUtilityTextCondensationAvailable } from "@core/text-condensation/UtilityTextCondensationAvailability"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { HostProvider } from "@hosts/host-provider"
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
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
import { telemetryService } from "@services/telemetry"
import { type ApiConfiguration } from "@shared/api"
import type { DiracToolSpec } from "@shared/tools"

import { getExtensionSourceDir } from "@shared/dirac/constants"
import { TaskStatus } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"

import {
	DiracContent,
	DiracStorageMessage,
	DiracTextContentBlock,
	DiracToolResponseContent,
} from "@shared/messages/content"

import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"

import { type Mode } from "@shared/storage/types"

import { DiracAskResponse } from "@shared/WebviewMessage"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { getErrorMessage } from "@/shared/errors"
import { type SkillMetadata } from "@/shared/skills"

import { Controller } from "../controller"
import { StateManager } from "../storage/StateManager"
import { ApiConversationManager } from "./ApiConversationManager"
import { AssistantStreamManager } from "./AssistantStreamManager"
import { activateTaskSkill } from "./activateTaskSkill"
import { ContextLoader } from "./ContextLoader"
import { EnvironmentManager } from "./EnvironmentManager"
import { HookManager } from "./HookManager"
import { LifecycleManager, type ResumeTaskOptions } from "./LifecycleManager"
import { LocalConversationCompaction } from "./LocalConversationCompaction"
import { MessageStateHandler } from "./message-state"
import { ResponseProcessor } from "./ResponseProcessor"

import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { type SteeringClaim } from "./steering"
import { TaskMessenger } from "./TaskMessenger"
import { handleMistakeLimitReached } from "./TaskMistakeLimit"
import { type TaskPromptArtifactsContext, writePromptMetadataArtifacts } from "./TaskPromptArtifacts"
import { type TaskRequestBuilderContext } from "./TaskRequestBuilder"
import {
	handleApiRequestError,
	persistApiStopReason,
	type TaskRequestOutcomeContext,
} from "./TaskRequestOutcome"
import { attemptApiRequest } from "./TaskApiRequestAttempt"
import { recursivelyMakeDiracRequests, type TaskRequestLoopContext } from "./TaskRequestLoop"
import type { TaskConversationPersistenceHooks } from "./TaskConversationPersistence"
import { TaskState } from "./TaskState"
import {
	appendQueuedSteeringToNextApiRequest,
	appendQueuedSteeringToUserContent,
	canAcceptSteeringMessage,
	claimSteeringMessages,
	commitAttemptCompletion,
	commitSteeringClaim,
	enqueueSteeringMessage,
	restoreQueuedSteeringFromTranscript,
	rollbackSteeringClaim,
	settleConsumedSteeringClaim,
	type TaskSteeringContext,
} from "./TaskSteering"
import { ToolExecutor } from "./ToolExecutor"
import { DiracContext } from "./tools/context/DiracContext"
import type { ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import {
	assertTaskMutationAuthorized,
	createTaskRequestRuntime,
	TaskMutationGate,
	type TaskRequestRuntime,
} from "./runtime/TaskRequestRuntime"
import {
	buildTaskWorkingConfigurationUpdate,
	type TaskWorkingConfiguration,
	type TaskWorkingConfigurationPatch,
} from "./runtime/TaskWorkingConfiguration"
import { extractProviderDomainFromUrl } from "./utils"
import { submitCardResponse, waitForFollowUp } from "./TaskUserInput"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"
import type { ToolEnvironmentFactory } from "./tools/interfaces/ToolEnvironmentFactory"
import { SurfaceToolEnvironmentFactory } from "./tools/adapters/SurfaceAdapter"
import {
	serializeTaskError,
	type TaskCancellationIntent,
	type TaskRunOutcome,
} from "./TaskRunOutcome"

export type ToolResponse = DiracToolResponseContent

export type TaskParams = {
	controller: Controller
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	postStateToWebview: () => Promise<void>
	postPresentationToWebview?: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	terminalOutputLineLimit: number
	defaultTerminalProfile: string
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	cwd: string
	stateManager: StateManager
	workingConfiguration: TaskWorkingConfiguration
	workspaceManager?: WorkspaceRootManager
	task?: string
	images?: string[]
	files?: string[]
	historyItem?: HistoryItem
	taskId: string
	conversationUlid?: string
	taskLockAcquired: boolean
	pinnedContext?: string
	getPinnedContext?: () => Promise<string | undefined>
	executionProfile?: TaskExecutionProfile
	toolEnvironmentFactory?: ToolEnvironmentFactory
	toolSelectionPolicy?: import("./tools/runtime/ToolSelectionPolicy").ToolSelectionPolicy
	onContextCompacted?: () => void
	switchToActMode?: () => Promise<boolean>
	enqueuePreRequestSteeringMessages?: () => Promise<void>
	updateBackgroundCommandState?: (running: boolean, taskId: string) => void
	conversationPersistenceHooks?: TaskConversationPersistenceHooks

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
	private workingConfiguration: TaskWorkingConfiguration
	private activeRequestRuntime?: TaskRequestRuntime

	private readonly conversationPersistenceHooks?: TaskConversationPersistenceHooks

	// ONE mutex for ALL state modifications to prevent race conditions
	private stateMutex = new Mutex()
	private readonly mutationGate = new TaskMutationGate()

	/**
	 * Execute function with exclusive lock on all task state
	 * Use this for ANY state modification to prevent races
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	private get steeringContext(): TaskSteeringContext {
		return {
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			taskMessenger: this.taskMessenger,
			allowWhileWaitingForInteraction:
				this.executionProfile === "goal_coordinator" || this.executionProfile === "goal_followup",
			postStateToWebview: () => this.postStateToWebview(),
			withStateLock: (fn) => this.withStateLock(fn),
		}
	}

	private get promptArtifactsContext(): TaskPromptArtifactsContext {
		return {
			taskId: this.taskId,
			cwd: this.cwd,
			writePromptMetadataEnabled: this.workingConfiguration.settings.writePromptMetadataEnabled,
			writePromptMetadataDirectory: this.workingConfiguration.settings.writePromptMetadataDirectory,
		}
	}

	private requestBuilderContext(requestRuntime: TaskRequestRuntime): TaskRequestBuilderContext {
		return {
			taskId: this.taskId,
			cwd: this.cwd,
			terminalExecutionMode: this.terminalExecutionMode,
			stateManager: this.stateManager,
			messageStateHandler: this.messageStateHandler,
			taskMessenger: this.taskMessenger,
			toolExecutor: this.toolExecutor,
			contextManager: this.contextManager,
			apiConversationManager: this.apiConversationManager,
			diracIgnoreController: this.diracIgnoreController,
			workspaceManager: this.workspaceManager,
			taskState: this.taskState,
			executionProfile: this.executionProfile,
			getPinnedContext: this.getPinnedContext,
			writePromptMetadataArtifacts: (params) =>
				writePromptMetadataArtifacts(
					{
						taskId: this.taskId,
						cwd: this.cwd,
						writePromptMetadataEnabled: requestRuntime.workingConfiguration.settings.writePromptMetadataEnabled,
						writePromptMetadataDirectory: requestRuntime.workingConfiguration.settings.writePromptMetadataDirectory,
					},
					params,
				),
		}
	}

	private requestOutcomeContext(requestRuntime: TaskRequestRuntime): TaskRequestOutcomeContext {
		return {
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			taskMessenger: this.taskMessenger,
			api: requestRuntime.api,
			taskId: this.taskId,
			executionProfile: this.executionProfile,
			checkpointManager: this.checkpointManager,
			postStateToWebview: () => this.postStateToWebview(),
			abortTask: () => this.abortTask(),
			handleContextWindowExceededError: () => this.handleContextWindowExceededError(),
			reinitExistingTaskFromId: () => this.reinitExistingTaskFromId(this.taskId),
			attemptApiRequest: (previousApiReqIndex, lastApiReqIndex, shouldCompact) =>
				this.attemptApiRequest(previousApiReqIndex, lastApiReqIndex, shouldCompact),
			recursivelyMakeDiracRequests: (userContent, includeFileDetails) =>
				this.recursivelyMakeDiracRequests(userContent, includeFileDetails),
			handleEmptyAssistantResponse: (params) => this.responseProcessor.handleEmptyAssistantResponse(params),
		}
	}

	private requestLoopContext(requestRuntime: TaskRequestRuntime): TaskRequestLoopContext {
		return {
			...this.requestBuilderContext(requestRuntime),
			...this.requestOutcomeContext(requestRuntime),
			requestRuntime,
			steeringContext: this.steeringContext,
			handleMistakeLimitReached: (userContent) => this.handleMistakeLimitReached(userContent),
			enqueuePreRequestSteeringMessages: () => this.enqueuePreRequestSteeringMessages(),
			resetStreamingState: () => this.resetStreamingState(),
			initializeCheckpoints: (isFirstRequest) => this.initializeCheckpoints(isFirstRequest),
			determineContextCompaction: (previousApiReqIndex) => this.determineContextCompaction(previousApiReqIndex),
			localConversationCompaction: this.localConversationCompaction,
			responseProcessor: this.responseProcessor,
			streamHandler: this.streamHandler,
			modelContextTracker: this.modelContextTracker,
			diffViewProvider: this.diffViewProvider,
			ulid: this.ulid,
			conversationPersistenceHooks: this.conversationPersistenceHooks,

		}
	}

	public canAcceptSteeringMessage(): boolean {
		return canAcceptSteeringMessage(this.steeringContext)
	}

	public async enqueueSteeringMessage(text: string): Promise<string> {
		return enqueueSteeringMessage(this.steeringContext, text)
	}

	private async claimSteeringMessages(): Promise<SteeringClaim | undefined> {
		return claimSteeringMessages(this.steeringContext)
	}

	private async commitSteeringClaim(claimId: string): Promise<void> {
		return commitSteeringClaim(this.steeringContext, claimId)
	}

	private async settleConsumedSteeringClaim(claim: SteeringClaim): Promise<void> {
		return settleConsumedSteeringClaim(this.steeringContext, claim)
	}

	private async rollbackSteeringClaim(claimId: string): Promise<void> {
		return rollbackSteeringClaim(this.steeringContext, claimId)
	}

	private async appendQueuedSteeringToUserContent(userContent: DiracContent[]): Promise<SteeringClaim | undefined> {
		return appendQueuedSteeringToUserContent(this.steeringContext, userContent)
	}

	private async appendQueuedSteeringToNextApiRequest(outboundHistory: DiracStorageMessage[]): Promise<void> {
		return appendQueuedSteeringToNextApiRequest(this.steeringContext, outboundHistory)
	}

	private async commitAttemptCompletion(response: string): Promise<
		import("./tools/interfaces/IToolEnvironment").CompletionCommitResult
	> {
		return commitAttemptCompletion(this.steeringContext, response)
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

	private notifyContextCompacted(): void {
		try {
			this.contextCompactionObserver?.()
		} catch (error) {
			Logger.error("Context compaction observer failed", error)
		}
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
	private localConversationCompaction: LocalConversationCompaction
	private assistantStreamManager: AssistantStreamManager
	private contextCompactionObserver?: () => void
	private switchToActMode: () => Promise<boolean>
	private enqueuePreRequestSteeringMessages: () => Promise<void>

	private responseProcessor: ResponseProcessor

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private postStateToWebview: () => Promise<void>
	private postPresentationToWebview: () => Promise<void>
	private reinitExistingTaskFromId: (taskId: string) => Promise<void>
	private cancelTask: () => Promise<void>

	// Cache service
	private stateManager: StateManager

	// Message and conversation state
	messageStateHandler: MessageStateHandler

	// Workspace manager
	workspaceManager?: WorkspaceRootManager

	// Task Locking (Sqlite)
	readonly executionProfile: TaskExecutionProfile
	private readonly getPinnedContext: () => Promise<string | undefined>

	// Command executor for running shell commands (extracted from executeCommandTool)
	private commandExecutor!: CommandExecutor

	constructor(params: TaskParams) {
		const {
			controller,
			updateTaskHistory,
			postStateToWebview,
			postPresentationToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			vscodeTerminalExecutionMode,
			cwd,
			stateManager,
			workingConfiguration,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			conversationUlid,
			taskLockAcquired,
			updateBackgroundCommandState,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		this.taskState.pinnedContext = params.pinnedContext
		this.taskState.initialTask = task ?? historyItem?.task
		this.executionProfile = params.executionProfile ?? "standalone"
		this.getPinnedContext = params.getPinnedContext ?? (() => Promise.resolve(params.pinnedContext))
		if (this.executionProfile !== "standalone" && workingConfiguration.settings.mode !== "act") {
			throw new Error(`${this.executionProfile} Tasks require an Act-mode working configuration`)
		}
		this.contextCompactionObserver = params.onContextCompacted
		this.controller = controller
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.postPresentationToWebview = postPresentationToWebview ?? postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.stateManager = stateManager
		this.workingConfiguration = workingConfiguration
		this.workspaceManager = workspaceManager
		this.cwd = cwd
		this.taskId = taskId
		this.taskState.taskLockAcquired = taskLockAcquired
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"
		this.switchToActMode = params.switchToActMode ?? (() => this.controller.toggleActModeForYoloMode())
		this.enqueuePreRequestSteeringMessages = params.enqueuePreRequestSteeringMessages ?? (async () => undefined)
		this.conversationPersistenceHooks = params.conversationPersistenceHooks

		this.taskState.pendingModeNotice = { mode: workingConfiguration.settings.mode }

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
			postPresentationToWebview: this.postPresentationToWebview,
			getWorkingConfiguration: () => this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration,
			getRequestRuntime: () => this.activeRequestRuntime,
			taskId: this.taskId,
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
		})

		this.assistantStreamManager = new AssistantStreamManager(this.taskMessenger)

		this.hookManager = new HookManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			getWorkingConfiguration: () => this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration,
			getRequestRuntime: () => this.activeRequestRuntime,
			taskId: this.taskId,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			cancelTask: this.cancelTask,
			withStateLock: this.withStateLock.bind(this),
			shouldRunBackgroundCheck: () => this.commandExecutor.hasActiveBackgroundCommand(),
		})

		this.diracIgnoreController = new DiracIgnoreController(cwd)
		this.diracIgnoreController.yoloMode = !!workingConfiguration.settings.yoloModeToggled

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

		this.urlContentFetcher = new UrlContentFetcher(
			() => (this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration).settings.browserSettings,
		)
		this.browserSession = new BrowserSession(
			() => (this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration).settings.browserSettings,
		)
		this.contextManager = new ContextManager()
		this.streamHandler = new StreamResponseHandler()

		// Prefer the host's DiffViewProvider if available, as it handles both background
		// and interactive edits. Fall back to FileEditProvider for headless environments.
		const hostDiffViewProvider = HostProvider.get().createDiffViewProvider()
		this.diffViewProvider = hostDiffViewProvider || new FileEditProvider()

		// Tool context owns restoration of conversation-scoped anchor state. Reconstructing
		// a Task for the same ULID must not destroy anchors already emitted to the model.
		this.diracContext = new DiracContext(this.taskId, this.stateManager, this.ulid)

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// Check for multiroot workspace and warn about checkpoints
		const isMultiRootWorkspace = this.workspaceManager && this.workspaceManager.getRoots().length > 1
		const checkpointsEnabled = workingConfiguration.settings.enableCheckpointsSetting

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
					enableCheckpoints: workingConfiguration.settings.enableCheckpointsSetting,
					multiRootEnabled: workingConfiguration.executionOptions.multiRootEnabled,
					resetTransientState: this.resetTransientState.bind(this),
				})

				// If multi-root, kick off non-blocking initialization
				// Unreachable for now, leaving in for future multi-root checkpoint support
				if (
					shouldUseMultiRoot({
						workspaceManager: this.workspaceManager,
						enableCheckpoints: workingConfiguration.settings.enableCheckpointsSetting,
						multiRootEnabled: workingConfiguration.executionOptions.multiRootEnabled,
					})
				) {
					this.checkpointManager.initialize?.().catch((error: Error) => {
						Logger.error("Failed to initialize multi-root checkpoint manager:", error)
						this.taskState.checkpointManagerErrorMessage = error?.message || String(error)
					})
				}
			} catch (error) {
				Logger.error("Failed to initialize checkpoint manager:", error)
				if (workingConfiguration.settings.enableCheckpointsSetting) {
					const errorMessage = getErrorMessage(error, "Unknown error")
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Failed to initialize checkpoint manager: ${errorMessage}`,
					})
				}
			}
		}

		// Prepare effective API configuration
		const apiConfiguration = workingConfiguration.apiConfiguration as ApiConfiguration
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
		const mode = workingConfiguration.settings.mode
		const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		// Now that ulid is initialized, we can build the API handler
		this.api = this.createApiHandlerForRuntime(effectiveApiConfiguration, mode)

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
				(updateBackgroundCommandState ?? this.controller.updateBackgroundCommandState.bind(this.controller))(
					isRunning,
					this.taskId,
				),
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
			(browserSession) => {
				this.browserSession = browserSession
				this.lifecycleManager.setBrowserSession(browserSession)
			},
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
			workingConfiguration.executionOptions.multiRootEnabled,
			() => this.workingConfiguration,
			(requestConfiguration, toolName, mutation) =>
				this.withMutationAuthorization(requestConfiguration, toolName, mutation),
			(transition) => this.mutationGate.transitionFromMutation(transition),
			(completion) => this.mutationGate.retainMutationUntil(completion),
			this.commitEnabledToolToggles.bind(this),
			this.saveCheckpointCallback.bind(this),
			this.commitAttemptCompletion.bind(this),
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
			this.notifyContextCompacted.bind(this),
			this.executionProfile,
			params.toolEnvironmentFactory ?? new SurfaceToolEnvironmentFactory(),
			params.toolSelectionPolicy,
		)
		this.environmentManager = new EnvironmentManager({
			cwd: this.cwd,
			terminalManager: this.terminalManager,
			taskState: this.taskState,
			fileContextTracker: this.fileContextTracker,
			api: this.api,
			messageStateHandler: this.messageStateHandler,
			getWorkingConfiguration: () => this.workingConfiguration,
			workspaceManager: this.workspaceManager,
			getRequestRuntime: () => this.activeRequestRuntime,
		})

		this.contextLoader = new ContextLoader({
			ulid: this.ulid,
			stateManager: this.stateManager,
			getRequestRuntime: () => {
				if (!this.activeRequestRuntime) throw new Error("Context loading requires an active request runtime")
				return this.activeRequestRuntime
			},
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
			isTextCondensationAvailable: (template) =>
				isUtilityTextCondensationAvailable(
					{
						utilityModelEnabled: this.workingConfiguration.settings.utilityModelEnabled,
						utilityModelUseCondense: this.workingConfiguration.settings.utilityModelUseCondense,
						utilityModelUseNewTask: this.workingConfiguration.settings.utilityModelUseNewTask,
						utilityModelSelection: this.workingConfiguration.settings.utilityModelSelection,
					},
					template,
					createDefaultTextCondensationTemplateRegistry(),
				),
			commandPermissionController: this.commandPermissionController,
			postStateToWebview: () => this.postStateToWebview(),
		})

		this.lifecycleManager = new LifecycleManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			getWorkingConfiguration: () => this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration,
			getRequestRuntime: () => this.activeRequestRuntime,
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
			restoreQueuedSteeringFromTranscript: this.restoreQueuedSteeringFromTranscript.bind(this),
			recordEnvironment: this.environmentContextTracker.recordEnvironment.bind(this.environmentContextTracker),
			time: () => this.environmentContextTracker.recordEnvironment(),
		})

		this.localConversationCompaction = new LocalConversationCompaction({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			contextManager: this.contextManager,
			getWorkingConfiguration: () => this.activeRequestRuntime?.workingConfiguration ?? this.workingConfiguration,
			taskMessenger: this.taskMessenger,
			getApi: () => this.activeRequestRuntime?.api ?? this.api,
			postStateToWebview: this.postStateToWebview,
			cancelTask: this.cancelTask,
			setActiveHookExecution: this.hookManager.setActiveHookExecution.bind(this.hookManager),
			clearActiveHookExecution: this.hookManager.clearActiveHookExecution.bind(this.hookManager),
			onContextCompacted: this.notifyContextCompacted.bind(this),
		})

		this.apiConversationManager = new ApiConversationManager({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
			contextManager: this.contextManager,
			getWorkingConfiguration: () => this.workingConfiguration,
			getRequestRuntime: () => this.activeRequestRuntime,
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
			activateSkill: (skillId) => activateTaskSkill(this.taskId, this.taskState, skillId),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getEnvironmentDetails: this.getEnvironmentDetails.bind(this),
			getPinnedContext: () => this.taskState.pinnedContext,
			writePromptMetadataArtifacts: (params) => writePromptMetadataArtifacts(this.promptArtifactsContext, params),
			handleHookCancellation: this.hookManager.handleHookCancellation.bind(this.hookManager),
			setActiveHookExecution: this.hookManager.setActiveHookExecution.bind(this.hookManager),
			clearActiveHookExecution: this.hookManager.clearActiveHookExecution.bind(this.hookManager),
			taskInitializationStartTime: this.taskInitializationStartTime,
			cancelTask: this.cancelTask,
			runUserPromptSubmitHook: this.runUserPromptSubmitHook.bind(this),
			onContextCompacted: this.notifyContextCompacted.bind(this),
			runLocalConversationCompaction: (source) => this.localConversationCompaction.run({ source }),
		})

		this.responseProcessor = new ResponseProcessor({
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
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

	/** Read-only task-owned configuration. The value is detached and deeply frozen. */
	public getWorkingConfiguration(): TaskWorkingConfiguration {
		return this.workingConfiguration
	}

	/**
 * Atomically validate and install one explicit update derived from the current
 * task configuration. No StateManager defaults are recaptured. When supplied,
 * `beforeCommit` runs only after the candidate configuration and API handler
 * have been built successfully, while the task-local transition lock is held.
 */
	public async applyWorkingConfigurationUpdate(
		patch:
			| TaskWorkingConfigurationPatch
			| ((current: TaskWorkingConfiguration) => TaskWorkingConfigurationPatch),
		beforeCommit?: (candidate: TaskWorkingConfiguration) => void | Promise<void>,
	): Promise<TaskWorkingConfiguration> {
		return this.mutationGate.withTransition(() =>
			this.withStateLock(async () => {
				const previous = this.workingConfiguration
				const resolvedPatch = typeof patch === "function" ? patch(previous) : patch
				const candidate = buildTaskWorkingConfigurationUpdate(previous, resolvedPatch)
				validateApiConfiguration(candidate.apiConfiguration as ApiConfiguration, candidate.settings.mode)
				const candidateApi = this.createApiHandlerForRuntime(
					candidate.apiConfiguration as ApiConfiguration,
					candidate.settings.mode,
				)

				await beforeCommit?.(candidate)

				if (previous.settings.enableCheckpointsSetting !== candidate.settings.enableCheckpointsSetting) {
					this.checkpointManager?.setEnabled(candidate.settings.enableCheckpointsSetting)
				}

				this.workingConfiguration = candidate
				this.installApiHandler(candidateApi)
				this.applyCommittedModeEffects(previous.settings.mode, candidate.settings.mode)
				this.diracIgnoreController.yoloMode = !!candidate.settings.yoloModeToggled
				if (resolvedPatch.settings && Object.hasOwn(resolvedPatch.settings, "toolToggles")) {
					this.toolExecutor.markToolsDirty("tool_toggles_changed")
				}
				return candidate
			}),
		)
	}

	private async commitEnabledToolToggles(toolIds: readonly string[], finalize?: () => Promise<void>): Promise<void> {
		const enabledToolIds = [...new Set(toolIds)]
		if (enabledToolIds.length === 0) {
			await finalize?.()
			return
		}
		await this.applyWorkingConfigurationUpdate(
			(current) => {
				const toolToggles = { ...current.settings.toolToggles }
				for (const toolId of enabledToolIds) toolToggles[toolId] = true
				return { settings: { toolToggles } }
			},
			async (candidate) => {
				this.stateManager.setGlobalState("toolToggles", structuredClone(candidate.settings.toolToggles))
				await finalize?.()
			},
		)
	}

	private withMutationAuthorization<T>(
		requestConfiguration: TaskWorkingConfiguration,
		toolName: DiracToolSpec["id"] | undefined,
		mutation: () => Promise<T>,
	): Promise<T> {
		return this.mutationGate.withMutation(
			() => assertTaskMutationAuthorized(requestConfiguration, this.workingConfiguration, toolName),
			mutation,
		)
	}

	/** Construct a model runtime without installing it on the task. */
	public createApiHandlerForRuntime(configuration: ApiConfiguration, mode: Mode): ApiHandler {
		return buildApiHandler(
			{
				...configuration,
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
			},
			mode,
		)
	}

	/** Internal propagation of a handler that already matches the committed snapshot. */
	private installApiHandler(api: ApiHandler): void {
		this.api = api
		this.taskMessenger.setApi(api)
		this.hookManager.setApi(api)
		this.toolExecutor.setApi(api)
		this.environmentManager.setApi(api)
		this.lifecycleManager.setApi(api)
		this.apiConversationManager.setApi(api)
		this.responseProcessor.setApi(api)
	}

	private applyCommittedModeEffects(previousMode: Mode, nextMode: Mode): void {
		if (previousMode === nextMode) return
		this.taskState.pendingModeNotice = { mode: nextMode }
		if (previousMode === "plan" && nextMode === "act" && this.taskState.isAwaitingPlanResponse) {
			this.taskState.didRespondToPlanAskBySwitchingMode = true
		}
	}




	async getEnvironmentDetails(includeFileDetails = false): Promise<string> {
		return this.environmentManager.getEnvironmentDetails(includeFileDetails)
	}

	private async persistApiStopReason(stopReason?: string): Promise<void> {
		const runtime = this.activeRequestRuntime ?? createTaskRequestRuntime(this.workingConfiguration, this.api)
		return persistApiStopReason(this.requestOutcomeContext(runtime), stopReason)
	}

	private async handleMistakeLimitReached(
		userContent: DiracContent[],
	): Promise<{ didEndLoop: boolean; userContent: DiracContent[] }> {
		return handleMistakeLimitReached(
			{ taskState: this.taskState, settings: this.workingConfiguration.settings, taskMessenger: this.taskMessenger },
			userContent,
		)
	}

	async loadContext(
		userContent: DiracContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DiracContent[], string, boolean, SkillMetadata[], boolean, string?, SlashCommandDirectAction[]?]> {
		return this.contextLoader.loadContext(userContent, includeFileDetails, useCompactPrompt)
	}

	// Communicate with webview

	public async resetTransientState(): Promise<void> {
		// Compaction clears visibility caches, but anchors remain part of the same
		// conversation protocol and must survive the transient-context reset.
		await this.diracContext.resetTaskContext()
		this.taskState.consecutiveMistakeCount = 0
		this.taskState.didAttemptCompletion = false
		this.taskState.activeVoiceStreamId = undefined
		await this.postStateToWebview()
	}

	private async waitForFollowUp(): Promise<DiracContent[] | undefined> {
		return waitForFollowUp({ taskState: this.taskState })
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
			return submitCardResponse({ taskState: this.taskState }, { cardId, response, text, images, files, value })
		})
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageId?: string): Promise<void> {
		if (isAttemptCompletionMessage) {
			this.taskState.didAttemptCompletion = true
		}
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageId) ?? Promise.resolve()
	}


	private async switchToActModeCallback(): Promise<boolean> {
		return await this.switchToActMode()
	}

	private async runUserPromptSubmitHook(
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		return this.hookManager.runUserPromptSubmitHook(userContent, context)
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<TaskRunOutcome> {
		return this.runTaskLifecycle(async () => {
			await this.toolExecutor.refreshToolsForTask()
			return this.lifecycleManager.startTask(task, images, files)
		})
	}

	public restoreQueuedSteeringFromTranscript(): void {
		restoreQueuedSteeringFromTranscript(this.steeringContext)
	}

	public async resumeTaskFromHistory(
		onRestored?: () => void,
		options: ResumeTaskOptions = {},
	): Promise<TaskRunOutcome> {
		return this.runTaskLifecycle(async () => {
			await this.toolExecutor.refreshToolsForTask()
			return this.lifecycleManager.resumeTaskFromHistory(onRestored, options)
		})
	}

	public markToolsDirty(reason: ToolSnapshotDirtyReason): void {
		this.toolExecutor.markToolsDirty(reason)
	}

	private async initiateTaskLoop(userContent: DiracContent[]): Promise<TaskRunOutcome> {
		let outcome: TaskRunOutcome | undefined
		try {
			let nextUserContent = userContent
			let includeFileDetails = true
			while (!this.taskState.abort) {
				const didEndLoop = await this.recursivelyMakeDiracRequests(nextUserContent, includeFileDetails)
				includeFileDetails = false // we only need file details the first time

				if (!didEndLoop) continue

				// Automatic-condense state survives in-request retries, but not a terminal turn boundary.
				this.taskState.pendingCondenseSource = undefined
				if (this.executionProfile === "standalone" && this.taskState.didAttemptCompletion) {
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
						this.taskState.completionResponse = undefined
						continue
					}
				}
				break
			}
			outcome = this.taskRunOutcomeFromState()
		} catch (error) {
			outcome = this.taskState.abort
				? this.taskRunOutcomeFromState()
				: { kind: "failed", error: serializeTaskError(error), failedAt: Date.now() }
		}

		try {
			// Flush task history at the end of the task loop (turn boundary).
			await this.messageStateHandler.flushTaskHistory()
		} catch (error) {
			outcome = { kind: "failed", error: serializeTaskError(error), failedAt: Date.now() }
		}

		return outcome
	}

	private async runTaskLifecycle(
		run: () => Promise<TaskRunOutcome | undefined>,
	): Promise<TaskRunOutcome> {
		let outcome: TaskRunOutcome
		try {
			outcome = (await run()) ?? this.taskRunOutcomeFromState()
		} catch (error) {
			outcome = { kind: "failed", error: serializeTaskError(error), failedAt: Date.now() }
		}
		return this.settleTaskRun(outcome)
	}

	private taskRunOutcomeFromState(): TaskRunOutcome {
		const intent = this.taskState.cancellationIntent
		if (intent?.kind === "interrupted") {
			return {
				kind: "interrupted",
				reason: intent.reason ?? "Interrupted by Task owner",
				interruptedAt: Date.now(),
			}
		}
		if (intent?.kind === "cancelled" || this.taskState.abort) {
			return { kind: "cancelled", reason: intent?.reason, cancelledAt: Date.now() }
		}
		if (this.taskState.completionResponse !== undefined) {
			return { kind: "completed", response: this.taskState.completionResponse, completedAt: Date.now() }
		}
		if (this.taskState.terminalError) {
			return { kind: "failed", error: this.taskState.terminalError, failedAt: Date.now() }
		}
		return {
			kind: "failed",
			error: serializeTaskError(new Error("Task run ended without a terminal response")),
			failedAt: Date.now(),
		}
	}

	private async settleTaskRun(candidate: TaskRunOutcome): Promise<TaskRunOutcome> {
		let outcome = candidate
		if (this.executionProfile !== "standalone") {
			try {
				await this.lifecycleManager.finalizeTaskRun()
			} catch (error) {
				const failures: unknown[] = [error]
				if (candidate.kind === "failed") {
					failures.unshift(new Error(`${candidate.error.name}: ${candidate.error.message}`))
				}
				outcome = {
					kind: "failed",
					error: serializeTaskError(new AggregateError(failures, "Task termination failed")),
					failedAt: Date.now(),
				}
			}
		}

		return this.withStateLock(() => {
			if (this.taskState.runOutcome) return this.taskState.runOutcome
			this.taskState.runOutcome = outcome
			if (outcome.kind === "failed") this.taskState.terminalError = outcome.error
			if (outcome.kind === "cancelled") {
				this.taskState.cancellationIntent ??= { kind: "cancelled", reason: outcome.reason }
			}
			if (outcome.kind === "interrupted") {
				this.taskState.cancellationIntent ??= { kind: "interrupted", reason: outcome.reason }
			}
			return outcome
		})
	}

	private async shouldRunTaskCancelHook(): Promise<boolean> {
		return this.hookManager.shouldRunTaskCancelHook()
	}

	async abortTask(intent: TaskCancellationIntent = { kind: "cancelled" }): Promise<void> {
		await this.withStateLock(() => {
			if (!this.taskState.runOutcome) this.taskState.cancellationIntent ??= intent
		})
		if (this.taskState.status !== TaskStatus.CANCELLED) {
			this.taskState.status = TaskStatus.CANCELLING
		}

		return this.lifecycleManager.abortTask()
	}

	async retirePersistence(): Promise<void> {
		await this.messageStateHandler.retirePersistence()
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

	private getCurrentProviderInfo(requestRuntime = this.activeRequestRuntime): ApiProviderInfo {
		const configuration = requestRuntime?.workingConfiguration ?? this.workingConfiguration
		const api = requestRuntime?.api ?? this.api
		const model = api.getModel()
		const mode = configuration.settings.mode
		const apiConfig = configuration.apiConfiguration
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		return {
			model,
			providerId,
			customPrompt: configuration.settings.customPrompt,
			mode,
			supportsNativeWebSearch: api.supportsNativeWebSearch?.() === true,
		}
	}

	private async writePromptMetadataArtifacts(params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}): Promise<void> {
		return writePromptMetadataArtifacts(this.promptArtifactsContext, params)
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

	private async handleApiRequestError(params: {
		error: unknown
		previousApiReqIndex: number
		lastApiReqIndex: number
		shouldCompact?: boolean
		model: { id: string; info: { contextWindow?: number } }
		providerId: string
		metricsManager: StreamingMetricsManager
	}): Promise<boolean> {
		const runtime = this.activeRequestRuntime ?? createTaskRequestRuntime(this.workingConfiguration, this.api)
		return handleApiRequestError(this.requestOutcomeContext(runtime), params)
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

	async *attemptApiRequest(previousApiReqIndex: number, lastApiReqIndex: number, shouldCompact?: boolean): ApiStream {
		const runtime = this.activeRequestRuntime ?? createTaskRequestRuntime(this.workingConfiguration, this.api)
		yield* attemptApiRequest(this.requestLoopContext(runtime), previousApiReqIndex, lastApiReqIndex, shouldCompact)
	}

	async presentAssistantMessage() {
		return this.responseProcessor.presentAssistantMessage()
	}

	async recursivelyMakeDiracRequests(userContent: DiracContent[], includeFileDetails = false): Promise<boolean> {
		const runtime = createTaskRequestRuntime(this.workingConfiguration, this.api)
		this.activeRequestRuntime = runtime
		try {
			return await recursivelyMakeDiracRequests(this.requestLoopContext(runtime), userContent, includeFileDetails)
		} finally {
			if (this.activeRequestRuntime === runtime) this.activeRequestRuntime = undefined
		}
	}

	private async initializeCheckpoints(isFirstRequest: boolean): Promise<void> {
		return this.lifecycleManager.initializeCheckpoints(isFirstRequest)
	}

	private async determineContextCompaction(previousApiReqIndex: number): Promise<boolean> {
		return this.apiConversationManager.determineContextCompaction(previousApiReqIndex)
	}

}
