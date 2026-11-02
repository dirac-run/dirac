import { getSavedApiConversationState, getSavedPresentationHistory } from "@core/storage/conversationHistory"
import { saveTaskletEvents, saveTaskletRecord, type TaskletRecord } from "@core/storage/taskStorage"
import { createTaskletId } from "@shared/taskletId"
import { ApiHandler, ApiProviderInfo, buildApiHandler, validateApiConfiguration } from "@core/api"
import { ApiStream } from "@core/api/transform/stream"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"

import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"

import { CommandPermissionController } from "@core/permissions"
import type { SlashCommandDirectAction } from "@core/slash-commands"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
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
import { getExtensionSourceDir } from "@shared/dirac/constants"
import { TaskStatus } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { DiracContent, DiracStorageMessage, DiracTextContentBlock, DiracToolResponseContent } from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import { type Mode } from "@shared/storage/types"
import type { DiracToolSpec } from "@shared/tools"

import { DiracAskResponse } from "@shared/WebviewMessage"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { getErrorMessage } from "@/shared/errors"
import { type SkillMetadata } from "@/shared/skills"

import { StateManager } from "../storage/StateManager"
import type { ITaskHost } from "./types/task-host"
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
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { type SteeringClaim } from "./steering"
import { attemptApiRequest } from "./TaskApiRequestAttempt"
import type { TaskConversationPersistenceHooks } from "./TaskConversationPersistence"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"
import { TaskMessenger, TaskletEscalationCleanupError } from "./TaskMessenger"
import { handleMistakeLimitReached } from "./TaskMistakeLimit"
import { type TaskPromptArtifactsContext, writePromptMetadataArtifacts } from "./TaskPromptArtifacts"
import { type TaskRequestBuilderContext } from "./TaskRequestBuilder"
import { recursivelyMakeDiracRequests, type TaskRequestLoopContext } from "./TaskRequestLoop"
import { handleApiRequestError, persistApiStopReason, type TaskRequestOutcomeContext } from "./TaskRequestOutcome"
import { serializeTaskError, type SerializedTaskError, type TaskCancellationIntent, type TaskRunOutcome } from "./TaskRunOutcome"
import { type ReadonlyTaskState, TaskState } from "./TaskState"
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
import { submitCardResponse, waitForFollowUp } from "./TaskUserInput"
import { submitContextualInput } from "./TaskContextualInput"
import type { ContextualInput, ContextualInputRoute } from "@shared/messages/contextualInput"
import { ToolExecutor } from "./ToolExecutor"
import { SurfaceToolEnvironmentFactory } from "./tools/adapters/SurfaceAdapter"
import { DiracContext } from "./tools/context/DiracContext"
import type { ToolEnvironmentFactory } from "./tools/interfaces/ToolEnvironmentFactory"
import type {
	TaskletInteraction, TaskletInspection, TaskletTranscript, TaskletInteractionResult,
	TaskletInteractionDecision, TaskletResolution,
} from "./tools/interfaces/IToolEnvironment"
import type { ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import { extractProviderDomainFromUrl } from "./utils"
export type {
	TaskletInteraction, TaskletInspection, TaskletTranscript, TaskletInteractionResult,
	TaskletInteractionDecision, TaskletResolution,
} from "./tools/interfaces/IToolEnvironment"

export type ToolResponse = DiracToolResponseContent

import type { TaskCounterparty, TaskInteractionRequest } from "./types/task-messenger"
import type { ResponseArguments } from "@shared/responseTool"

/** Private owner bindings; a tasklet never falls back to foreground publication. */
export interface TaskletExecutionBindings {
	counterparty: TaskCounterparty
	storageAddress: Extract<TaskStorageAddress, { kind: "tasklet" }>
	postStateToOwner: () => Promise<void>
	postPresentationToOwner?: () => Promise<void>
	updateBackgroundCommandState: (running: boolean, taskId: string) => void
}

export type TaskParams = {
	controller: ITaskHost
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
	releaseTaskLock?: () => Promise<void>
	pinnedContext?: string
	getPinnedContext?: () => Promise<string | undefined>
	executionProfile?: TaskExecutionProfile
	tasklet?: TaskletExecutionBindings
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
	readonly storageAddress: TaskStorageAddress
	// Sequence number for prompt-metadata debug artifacts — see promptArtifactsContext.
	// Each API request within a task gets its own file instead of overwriting the last.
	private promptArtifactSeq = 0
	private diracContext: DiracContext
	readonly ulid: string
	private taskIsFavorited?: boolean
	public cwd: string
	private taskInitializationStartTime: number

	taskState: TaskState
	private workingConfiguration: TaskWorkingConfiguration
	private activeRequestRuntime?: TaskRequestRuntime

	/** Read-only view of task state for consumers outside the task layer. */
	get stateView(): ReadonlyTaskState {
		return this.taskState
	}

	private readonly conversationPersistenceHooks?: TaskConversationPersistenceHooks
	private readonly releaseTaskLock?: () => Promise<void>
	private persistenceRetirementPromise?: Promise<void>
	readonly taskletHost?: TaskletHost

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
			getCompletionBlocker: () => {
				const active = this.taskletHost?.listActive() ?? []
				if (!active.length) return undefined
				return `Active tasklets: ${active.map(({ id, title }) => `${id} (${title})`).join(", ")}. Let them finish or interrupt them before completing.`
			},
		}
	}

	private get promptArtifactsContext(): TaskPromptArtifactsContext {
		return {
			taskId: this.taskId,
			storageAddress: this.storageAddress,
			// Each call gets its own sequence number so a multi-call turn (e.g. the
			// noToolsUsed retry loop) leaves one debug artifact per API request
			// instead of the last request overwriting all earlier ones.
			requestSeq: ++this.promptArtifactSeq,
			cwd: this.cwd,
			writePromptMetadataEnabled: this.workingConfiguration.settings.writePromptMetadataEnabled,
			writePromptMetadataDirectory: this.workingConfiguration.settings.writePromptMetadataDirectory,
		}
	}

	private requestBuilderContext(requestRuntime: TaskRequestRuntime): TaskRequestBuilderContext {
		return {
			taskId: this.taskId,
			storageAddress: this.storageAddress,
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
						storageAddress: this.storageAddress,
						requestSeq: ++this.promptArtifactSeq,
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
			mode: requestRuntime.workingConfiguration.settings.mode,
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
			deliverTaskletEvents: (history) => this.deliverTaskletEvents(history),
		}
	}

	public canAcceptSteeringMessage(): boolean {
		return canAcceptSteeringMessage(this.steeringContext)
	}

	public submitContextualInput(input: ContextualInput, route: ContextualInputRoute, assertOwner: () => void) {
		return submitContextualInput(
			{
				...this.steeringContext,
				canAcceptSteering: () => this.canAcceptSteeringMessage(),
				submitResponse: (cardId, value) =>
					submitCardResponse({ taskState: this.taskState }, { cardId, value, response: DiracAskResponse.MESSAGE }),
			},
			input,
			route,
			assertOwner,
		)
	}

	public async enqueueSteeringMessage(text: string): Promise<string> {
		return enqueueSteeringMessage(this.steeringContext, text)
	}

	/** Called only at the existing serial provider-dispatch boundary, never by event arrival. */
	private async deliverTaskletEvents(outboundHistory: DiracStorageMessage[]): Promise<void> {
		const delivery = await this.taskletHost?.prepareEventDelivery()
		if (!delivery) return
		let outboundUserMessage = outboundHistory.at(-1)
		if (!outboundUserMessage || outboundUserMessage.role !== "user") {
			throw new Error("Cannot deliver tasklet events without a final user message")
		}
		const history = this.messageStateHandler.getApiConversationHistory()
		const checkpoint = this.messageStateHandler.getApiConversationProviderState().checkpoint
		const eventIds = (message: DiracStorageMessage): string[] => Array.isArray(message.content)
			? message.content.flatMap((block) => block.type === "text" ? (block as DiracTextContentBlock).taskletEventIds ?? [] : [])
			: []
		const recordedIds = new Set(history.flatMap(eventIds))
		const newContent = delivery.content.filter((block) => !recordedIds.has(block.taskletEventIds![0]))
		// A checkpoint is an opaque snapshot: mutating its final user message cannot
		// update that snapshot. Preserve it and append new communications after its boundary.
		if (newContent.length && checkpoint && checkpoint.compactedThroughHistoryIndex >= history.length - 1) {
			await this.messageStateHandler.addToApiConversationHistory({ role: "user", content: newContent })
			outboundUserMessage = history.at(-1)!
			if (outboundHistory !== history) outboundHistory.push(outboundUserMessage)
		} else {
			for (const block of newContent) await this.messageStateHandler.appendToLastApiConversationUserMessage(block)
		}
		for (const block of delivery.content) {
			const id = block.taskletEventIds![0]
			if (outboundHistory.some((message) => eventIds(message).includes(id))) continue
			const recordedIndex = history.findIndex((message) => eventIds(message).includes(id))
			// Receipt-only retries must not put checkpointed input into the suffix again.
			if (checkpoint && recordedIndex <= checkpoint.compactedThroughHistoryIndex) continue
			if (typeof outboundUserMessage.content === "string") {
				outboundUserMessage.content = [{ type: "text", text: outboundUserMessage.content }, block]
			} else {
				outboundUserMessage.content.push(block)
			}
		}
		// A failed flush leaves the receipt in the write buffer, but the host event stays pending.
		// Retrying flush/ack must not append another copy to the parent's persisted conversation.
		await this.messageStateHandler.flushPendingWrites()
		await delivery.acknowledge()
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

	private async commitAttemptCompletion(
		response: string,
	): Promise<import("./tools/interfaces/IToolEnvironment").CompletionCommitResult> {
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
	private host: ITaskHost

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
			releaseTaskLock,
			updateBackgroundCommandState,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		this.taskState.pinnedContext = params.pinnedContext
		this.executionProfile = params.executionProfile ?? "standalone"
		this.getPinnedContext = params.getPinnedContext ?? (() => Promise.resolve(params.pinnedContext))
		if (this.executionProfile.startsWith("goal_") && workingConfiguration.settings.mode !== "act") {
			throw new Error(`${this.executionProfile} Tasks require an Act-mode working configuration`)
		}
		this.contextCompactionObserver = params.onContextCompacted
		this.host = controller
		const contained = params.tasklet
		if ((this.executionProfile === "tasklet") !== !!contained) {
			throw new Error("Tasklet execution requires private owner bindings and the tasklet profile")
		}
		if (contained && (contained.storageAddress.taskletId !== taskId || releaseTaskLock)) {
			throw new Error("Tasklet identity must match its storage address and cannot own a root Task lock")
		}
		this.storageAddress = Object.freeze(contained ? { ...contained.storageAddress } : { kind: "task", taskId })
		getTaskDirectoryPath(this.storageAddress)
		this.updateTaskHistory = contained ? async () => [] : updateTaskHistory
		this.postStateToWebview = contained ? contained.postStateToOwner : postStateToWebview
		this.postPresentationToWebview = contained
			? contained.postPresentationToOwner ?? contained.postStateToOwner
			: postPresentationToWebview ?? postStateToWebview
		this.reinitExistingTaskFromId = contained
			? async () => {
				throw new Error("Tasklets are reconstructed only by their owner")
			}
			: reinitExistingTaskFromId
		this.cancelTask = contained ? () => this.abortTask() : cancelTask
		this.stateManager = stateManager
		this.workingConfiguration = workingConfiguration
		this.workspaceManager = workspaceManager
		this.cwd = cwd
		this.taskId = taskId
		this.releaseTaskLock = releaseTaskLock
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"
		this.switchToActMode = contained
			? async () => {
				await this.applyWorkingConfigurationUpdate({ settings: { mode: "act" } })
				return true
			}
			: params.switchToActMode ?? (() => this.host.toggleActModeForYoloMode())
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
			storageAddress: this.storageAddress,
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
			counterparty: contained?.counterparty,
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
		this.diracContext = new DiracContext(this.storageAddress, this.stateManager, this.ulid)

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(stateManager, this.taskId, undefined, this.storageAddress)
		this.modelContextTracker = new ModelContextTracker(this.taskId, this.storageAddress)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId, this.storageAddress)

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
					storageAddress: this.storageAddress,
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
				(contained
					? contained.updateBackgroundCommandState
					: updateBackgroundCommandState ?? this.host.updateBackgroundCommandState.bind(this.host))(isRunning, this.taskId),
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
				this.lifecycleManager.setBrowserSession(browserSession)
				this.browserSession = browserSession
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
			this.storageAddress,
			() => {
				const host = this.taskletHost
				if (!host) return undefined
				return {
					start: (input) => host.start(input),
					list: () => host.list(),
					inspect: (id) => host.inspect(id),
					readTranscript: (id) => host.readTranscript(id),
					steer: (id, message) => host.steer(id, message),
					interrupt: (id, reason) => host.interrupt(id, reason),
					resolveInteraction: (id, requestId, decision) => host.resolveInteraction(id, requestId, decision),
				}
			},
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
			diracIgnoreController: this.diracIgnoreController,
		})

		this.contextLoader = new ContextLoader({
			executionProfile: this.executionProfile,
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
			storageAddress: this.storageAddress,
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
			storageAddress: this.storageAddress,
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
			storageAddress: this.storageAddress,
			ulid: this.ulid,
			cwd: this.cwd,
			taskMessenger: this.taskMessenger,
			postStateToWebview: this.postStateToWebview,
			diffViewProvider: this.diffViewProvider,
			toolExecutor: this.toolExecutor,
			streamHandler: this.streamHandler,
			withStateLock: this.withStateLock.bind(this),
			loadContext: this.loadContext.bind(this),
			activateSkill: (skillId) => activateTaskSkill(this.storageAddress, this.taskState, skillId),
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

		if (this.executionProfile === "standalone") {
			const root = this
			this.taskletHost = new TaskletHost({
				taskId: this.taskId, executionProfile: this.executionProfile,
				authorizePermission: (request, signal) => this.toolExecutor.authorizeTaskletPermission(request, signal),
				assertPermissionAllowed: (request) => this.toolExecutor.assertTaskletPermissionAllowed(request),
				escalateInteraction: (child, request, signal) => this.taskMessenger.escalateTaskletInteraction(child, request, signal),
			}, {
				controller,
				cwd,
				stateManager,
				workspaceManager,
				shellIntegrationTimeout,
				terminalReuseEnabled,
				terminalOutputLineLimit,
				defaultTerminalProfile,
				vscodeTerminalExecutionMode,
				get workingConfiguration() {
					return root.getWorkingConfiguration()
				},
				get pinnedContext() {
					return root.taskState.pinnedContext
				},
				toolSelectionPolicy: params.toolSelectionPolicy,
				toolEnvironmentFactory: params.toolEnvironmentFactory,
			})
		}
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
		patch: TaskWorkingConfigurationPatch | ((current: TaskWorkingConfiguration) => TaskWorkingConfigurationPatch),
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
				if (this.executionProfile !== "tasklet") {
					this.stateManager.setGlobalState("toolToggles", structuredClone(candidate.settings.toolToggles))
				}
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
			{
				taskState: this.taskState,
				settings: this.workingConfiguration.settings,
				taskMessenger: this.taskMessenger,
				postStateToWebview: () => this.postStateToWebview(),
			},
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
		this.taskState.detachVoiceStream()
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

	public async resumeTaskFromHistory(onRestored?: () => void, options: ResumeTaskOptions = {}): Promise<TaskRunOutcome> {
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
						// Contextual follow-ups already have a durable user transcript entry.
						if (followUp.length) {
							await this.taskMessenger.upsertText(
								this.taskState.askResponseText || "",
								false,
								this.taskState.askResponseImages,
								this.taskState.askResponseFiles,
								"user",
							)
						}
						nextUserContent = [...this.taskState.userMessageContent, ...followUp]
						this.taskState.didAttemptCompletion = false
						this.taskState.clearCompletionResponse()
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

	private async runTaskLifecycle(run: () => Promise<TaskRunOutcome | undefined>): Promise<TaskRunOutcome> {
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
		const failures: unknown[] = []
		if (this.executionProfile === "standalone") {
			// Ordinary completion waits for follow-up inside the run. Reaching this boundary
			// means the run actually closed, including provider/startup failures.
			try {
				await this.taskletHost?.shutdown()
			} catch (error) {
				failures.push(error)
			}
		} else {
			try {
				await this.lifecycleManager.finalizeTaskRun()
			} catch (error) {
				failures.push(error)
			}
			try {
				await this.retirePersistence()
			} catch (error) {
				failures.push(error)
			}
		}
		if (failures.length > 0) {
			if (candidate.kind === "failed") {
				failures.unshift(new Error(`${candidate.error.name}: ${candidate.error.message}`))
			}
			outcome = {
				kind: "failed",
				error: serializeTaskError(new AggregateError(failures, "Task termination failed")),
				failedAt: Date.now(),
			}
		}

		return this.withStateLock(() => {
			// settleTaskRun is idempotent: an already-settled outcome wins over the candidate.
			if (this.taskState.runOutcome) return this.taskState.runOutcome
			return this.taskState.settleRunOutcome(outcome)
		})
	}

	private async shouldRunTaskCancelHook(): Promise<boolean> {
		return this.hookManager.shouldRunTaskCancelHook()
	}

	async abortTask(intent: TaskCancellationIntent = { kind: "cancelled" }): Promise<void> {
		await this.withStateLock(() => this.taskState.captureCancellationIntent(intent))
		if (this.taskState.status !== TaskStatus.CANCELLED) {
			this.taskState.status = TaskStatus.CANCELLING
		}

		// Stop both owners before joining either; a child failure cannot skip root cleanup.
		const results = await Promise.allSettled([this.taskletHost?.shutdown(), this.lifecycleManager.abortTask()])
		const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
		if (failures.length === 1) throw failures[0]
		if (failures.length) throw new AggregateError(failures, "Root and tasklet abort failed")
	}

	/** Retires this writer before releasing exclusive ownership, once per task instance. */
	async retirePersistence(): Promise<void> {
		this.persistenceRetirementPromise ??= this.retirePersistenceAndReleaseLock()
		await this.persistenceRetirementPromise
	}

	private async retirePersistenceAndReleaseLock(): Promise<void> {
		const failures: unknown[] = []
		try {
			await this.taskletHost?.shutdown()
		} catch (error) {
			failures.push(error)
		}
		try {
			await this.messageStateHandler.flushPendingWrites()
		} catch (error) {
			failures.push(error)
		}
		// Even a failed final flush must close writer admission; report the lost persistence.
		try {
			await this.messageStateHandler.retirePersistence()
		} catch (error) {
			failures.push(error)
		}
		// A failed shutdown/retirement is not permission to delete the owned tree.
		if (failures.length === 1) throw failures[0]
		if (failures.length) throw new AggregateError(failures, "Root and tasklet persistence retirement failed")
		await this.releaseTaskLock?.()
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
		this.taskState.resetStreamRead()
		this.taskState.userMessageContent = []
		this.taskState.userMessageContentReady = false
		this.taskState.didRejectTool = false
		this.taskState.didAlreadyUseTool = false
		await this.diffViewProvider.reset()
		this.streamHandler.reset()
		this.taskState.toolUseIdMap.clear()
		this.taskState.detachVoiceStream()
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

/** Construction data only; foreground callbacks and root lock ownership cannot be inherited. */
export type TaskletTaskOptions = Pick<
	TaskParams,
	| "controller"
	| "cwd"
	| "stateManager"
	| "workingConfiguration"
	| "workspaceManager"
	| "shellIntegrationTimeout"
	| "terminalReuseEnabled"
	| "terminalOutputLineLimit"
	| "defaultTerminalProfile"
	| "vscodeTerminalExecutionMode"
	| "pinnedContext"
	| "toolSelectionPolicy"
	| "toolEnvironmentFactory"
>


export interface TaskletOwner extends Pick<Task, "taskId" | "executionProfile"> {
	authorizePermission: ToolExecutor["authorizeTaskletPermission"]
	assertPermissionAllowed: ToolExecutor["assertTaskletPermissionAllowed"]
	escalateInteraction: TaskMessenger["escalateTaskletInteraction"]
}


interface PendingTaskletInteraction {
	record: TaskletInteraction
	cancellation: AbortController
	resolving: boolean
	resolve: (result: TaskletInteractionResult) => void
	retire: () => void
}

interface TaskletEvent {
	id: string
	taskletId: string
	createdAt: number
	deliveredAt?: number
	communication: { type: "response"; response: ResponseArguments } | { type: "interaction"; request: TaskletInteraction }
}

interface OwnedTasklet {
	events: TaskletEvent[]
	eventWrites: Promise<void>
	interactions: Map<string, PendingTaskletInteraction>
	interactionsClosed: boolean
	record: TaskletRecord
	task?: Task
	failedTranscript?: TaskletTranscript
	settlement?: Promise<void>
	backgroundCommandRunning: boolean
	outcomePersisted: boolean
	settlementError?: SerializedTaskError
}

/**
 * One ordinary root Task's in-memory child owner, retained through shutdown.
 * Co-located with Task because roots construct hosts and hosts construct contained Tasks;
 * separate classes retain separate ownership without a circular module dependency.
 * Explicit decisions are checked against the owner; communications persist until parent delivery.
 */
export class TaskletHost {
	private readonly children = new Map<string, OwnedTasklet>()
	private readonly rootTaskId: string
	private readonly starting = new Map<string, { record: TaskletRecord; acceptance: Promise<TaskletRecord> }>()
	private closing = false
	private shutdownPromise?: Promise<void>
	private readonly resolutions = new Set<Promise<TaskletResolution>>()
	private readonly interactionCleanupFailures: TaskletEscalationCleanupError[] = []

	constructor(
		private readonly owner: TaskletOwner,
		private readonly options: TaskletTaskOptions,
		// Constructor substitution is only a controlled-execution test seam, not a factory service.
		private readonly TaskConstructor: typeof Task = Task,
	) {
		if (owner.executionProfile !== "standalone") throw new Error("Only ordinary root Tasks may own tasklets")
		getTaskDirectoryPath(owner.taskId)
		this.rootTaskId = owner.taskId
	}

	/** Persist acceptance and launch, without waiting for the assignment to finish. */
	async start(input: { title: string; prompt: string }): Promise<TaskletRecord> {
		if (this.closing) throw new Error("Tasklet host is shutting down")
		const title = input.title.trim()
		const prompt = input.prompt.trim()
		if (!title || !prompt) throw new Error("Tasklet title and prompt must be non-empty")
		const record: TaskletRecord = {
			id: createTaskletId(),
			rootTaskId: this.rootTaskId,
			conversationUlid: ulid(),
			title,
			prompt,
			createdAt: Date.now(),
		}
		const acceptance = this.acceptAndStart(record)
		this.starting.set(record.id, { record, acceptance })
		try {
			return await acceptance
		} finally {
			this.starting.delete(record.id)
		}
	}

	private async acceptAndStart(record: TaskletRecord): Promise<TaskletRecord> {
		// No Task or live handle exists if this initial write fails.
		await saveTaskletRecord(record)
		const child: OwnedTasklet = {
			record, backgroundCommandRunning: false, outcomePersisted: false,
			events: [], eventWrites: Promise.resolve(), interactions: new Map(), interactionsClosed: false,
		}
		this.children.set(record.id, child)
		// A start admitted before shutdown still owns its write, but must not launch late work.
		if (this.closing) {
			child.settlement = this.persistOutcome(child, {
				kind: "interrupted", reason: "Root Task closed during tasklet startup", interruptedAt: Date.now(),
			})
			await child.settlement
			return structuredClone(child.record)
		}
		try {
			child.task = new this.TaskConstructor({
				...this.options,
				taskId: record.id,
				conversationUlid: record.conversationUlid,
				task: record.prompt,
				executionProfile: "tasklet",
				updateTaskHistory: async () => [],
				postStateToWebview: unavailableForegroundCallback,
				reinitExistingTaskFromId: unavailableForegroundCallback,
				cancelTask: unavailableForegroundCallback,
				tasklet: {
					counterparty: {
						recordResponse: async (response) => {
							if (child.interactionsClosed || this.closing) throw new Error("Tasklet counterparty is closed")
							child.events.push({
								id: ulid(), taskletId: record.id, createdAt: Date.now(),
								communication: { type: "response", response: structuredClone(response) },
							})
							await this.persistEvents(child)
						},
						requestInteraction: (request, signal) => this.waitForInteraction(child, request, signal),
					},
					storageAddress: this.address(record.id),
					// Routine activity remains in the child's transcript, not the communication queue.
					postStateToOwner: async () => { },
					postPresentationToOwner: async () => { },
					updateBackgroundCommandState: (running) => {
						child.backgroundCommandRunning = running
					},
				},
			})
		} catch (error) {
			child.settlement = this.persistOutcome(child, {
				kind: "failed",
				error: serializeTaskError(error),
				failedAt: Date.now(),
			})
			await child.settlement
			return structuredClone(child.record)
		}
		child.settlement = this.observeRun(child, child.task)
		// Retain the rejecting promise for controls; observe it now to avoid an unhandled rejection.
		void child.settlement.catch((error) => Logger.error(`[Tasklet ${record.id}] Settlement failed:`, error))
		return structuredClone(record)
	}

	/** Serialize complete snapshots; later writes include every retained communication. */
	private persistEvents(child: OwnedTasklet, deliveredIds: ReadonlySet<string> = new Set()): Promise<void> {
		const write = async () => {
			const deliveredAt = Date.now()
			const snapshot = child.events.map((event) => ({
				...event,
				deliveredAt: deliveredIds.has(event.id) ? event.deliveredAt ?? deliveredAt : event.deliveredAt,
			}))
			await saveTaskletEvents(this.address(child.record.id), structuredClone(snapshot))
			for (const event of child.events) {
				if (deliveredIds.has(event.id)) event.deliveredAt ??= deliveredAt
			}
		}
		// A subsequent full snapshot may retry a failed write; the original caller still sees its failure.
		child.eventWrites = child.eventWrites.then(write, write)
		void child.eventWrites.catch((error) => Logger.error(`[Tasklet ${child.record.id}] Communication persistence failed:`, error))
		return child.eventWrites
	}

	/** No claims or model execution: the root consumes this bounded snapshot in its serial request flow. */
	async prepareEventDelivery(): Promise<{ content: DiracTextContentBlock[]; acknowledge: () => Promise<void> } | undefined> {
		if (this.closing) return undefined
		const pending = [...this.children.values()].flatMap((child) =>
			child.events.filter((event) => event.deliveredAt === undefined).map((event) => ({ child, event })),
		).sort((a, b) => a.event.createdAt - b.event.createdAt).slice(0, 16)
		if (!pending.length) return undefined
		const children = [...new Set(pending.map(({ child }) => child))]
		// A new delivery attempt also retries a previously failed full snapshot/receipt write.
		await Promise.all(children.map((child) => this.persistEvents(child)))
		if (this.closing) return undefined
		const content: DiracTextContentBlock[] = pending.map(({ child, event }) => {
			const full = JSON.stringify(event.communication)
			const preview = full.length > 4000 ? `${full.slice(0, 4000)}… [preview truncated; inspect tasklet for full contents]` : full
			return {
				type: "text", taskletEventIds: [event.id],
				text: `[Tasklet communication: ${event.taskletId}; event ${event.id}; title ${JSON.stringify(child.record.title)}]\n${preview}`,
			}
		})
		return {
			content,
			acknowledge: async () => {
				if (this.closing) throw new Error("Tasklet host is shutting down")
				await Promise.all(children.map((child) => this.persistEvents(child,
					new Set(pending.filter((entry) => entry.child === child).map(({ event }) => event.id)),
				)))
			},
		}
	}

	/** Includes admitted starts and input waits, not just provider activity. */
	listActive(): Array<Pick<TaskletRecord, "id" | "title">> {
		const active = new Map<string, Pick<TaskletRecord, "id" | "title">>()
		for (const { record } of this.starting.values()) active.set(record.id, { id: record.id, title: record.title })
		for (const { record } of this.children.values()) {
			if (!record.outcome) active.set(record.id, { id: record.id, title: record.title })
		}
		return [...active.values()]
	}

	/** Close admission synchronously, then join every admitted writer and execution. */
	shutdown(): Promise<void> {
		this.closing = true
		for (const child of this.children.values()) this.retireInteractions(child)
		this.shutdownPromise ??= this.stopOwnedTasklets()
		return this.shutdownPromise
	}

	private async stopOwnedTasklets(): Promise<void> {
		const results = await Promise.allSettled([
			...[...this.starting.values()].map(({ acceptance }) => acceptance),
			...[...this.children.keys()].map((id) => this.interrupt(id, "Root Task closed")),
		])
		// Cancellation/decision errors belong to callers. Incomplete escalation cleanup also retains root ownership.
		await Promise.allSettled([...this.resolutions])
		const eventResults = await Promise.allSettled([...this.children.values()].map((child) => child.eventWrites))
		const failures = [
			...results.filter((result) => result.status === "rejected").map((result) => result.reason),
			...this.interactionCleanupFailures,
			...eventResults.filter((result) => result.status === "rejected").map((result) => result.reason),
		]
		if (failures.length) throw new AggregateError(failures, "Tasklet shutdown failed")
	}

	list(): TaskletInspection[] {
		return [...this.children.keys()].map((id) => this.inspect(id))
	}

	inspect(id: string): TaskletInspection {
		const child = this.requireChild(id)
		return structuredClone({
			...child.record,
			responses: child.events.flatMap((event) => event.communication.type === "response" ? [event.communication.response] : []),
			interactions: [...child.interactions.values()].map(({ record }) => record),
			executionStatus: child.task?.stateView.status,
			backgroundCommandRunning: child.backgroundCommandRunning,
			outcomePersisted: child.outcomePersisted,
			settlementError: child.settlementError,
		})
	}

	async readTranscript(id: string) {
		const child = this.requireChild(id)
		if (child.failedTranscript) return structuredClone(child.failedTranscript)
		if (child.task) {
			return structuredClone({
				conversation: child.task.messageStateHandler.getApiConversationHistory(),
				presentation: child.task.messageStateHandler.getDiracMessages(),
			})
		}
		const [conversation, presentation] = await Promise.all([
			getSavedApiConversationState(this.address(id)),
			getSavedPresentationHistory(this.address(id)),
		])
		return { conversation: conversation.messages, presentation: presentation.messages }
	}

	/** Uses the engine's admission check; startup/terminal states can reject steering. */
	async steer(id: string, message: string): Promise<{ id: string; messageId: string; accepted: true }> {
		const child = this.requireChild(id)
		if (!child.task || child.record.outcome) throw new Error(`Tasklet ${id} is not running`)
		const messageId = await child.task.enqueueSteeringMessage(message)
		return { id, messageId, accepted: true }
	}

	/** Explicit parent decisions only. An approval outside current authority leaves the request pending. */
	async resolveInteraction(id: string, requestId: string, decision: TaskletInteractionDecision): Promise<TaskletResolution> {
		const child = this.requireChild(id)
		const interaction = child.interactions.get(requestId)
		if (!interaction || interaction.record.status !== "pending" || this.closing || child.interactionsClosed) {
			throw new Error(`Tasklet interaction ${requestId} is not pending for ${id}`)
		}
		if (interaction.resolving) throw new Error(`Tasklet interaction ${requestId} is already being resolved`)
		interaction.resolving = true
		const resolution = this.applyInteractionDecision(child, interaction, structuredClone(decision))
		this.resolutions.add(resolution)
		try {
			return await resolution
		} catch (error) {
			if (error instanceof TaskletEscalationCleanupError) this.interactionCleanupFailures.push(error)
			throw error
		} finally {
			interaction.resolving = false
			this.resolutions.delete(resolution)
		}
	}

	private async applyInteractionDecision(
		child: OwnedTasklet,
		interaction: PendingTaskletInteraction,
		decision: TaskletInteractionDecision,
	): Promise<TaskletResolution> {
		const request = interaction.record
		const signal = interaction.cancellation.signal
		const permission = request.permissionOperation !== undefined || request.permissionRequestKind !== undefined
		let result: TaskletInteractionResult
		let assertAuthorityCurrent: (() => void) | undefined
		switch (decision.operation) {
			case "answer":
				if (permission) throw new Error("Permission requests require approve, reject or escalate, not an answer")
				result = decision.response
				break
			case "reject":
				result = { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }
				break
			case "approve": {
				if (!permission) throw new Error("Use answer for questions and operational choices")
				const authority = await this.owner.authorizePermission(structuredClone(request), signal)
				signal.throwIfAborted()
				authority.assertCurrent()
				if (!authority.approved) return { status: "requires_user_approval" }
				assertAuthorityCurrent = authority.assertCurrent
				result = { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
				break
			}
			case "escalate":
				if (permission) this.owner.assertPermissionAllowed(request)
				result = await this.owner.escalateInteraction(
					{ id: child.record.id, title: child.record.title }, structuredClone(request), signal,
				)
				break
			default:
				throw new Error("Unknown tasklet interaction decision")
		}
		signal.throwIfAborted()
		if (permission && result.userEdits !== undefined) throw new Error("Tasklet approval cannot change the requested operation")
		if (permission && (result.action === DiracAskResponse.APPROVE || result.response === DiracAskResponse.APPROVE)) {
			this.owner.assertPermissionAllowed(request)
			assertAuthorityCurrent?.()
		}
		interaction.resolve(result)
		await this.persistEvents(child)
		return { status: "resolved" }
	}

	/** Abort is not settlement: retain ownership through the run and outcome write. */
	async interrupt(id: string, reason?: string): Promise<TaskletInspection> {
		const child = this.requireChild(id)
		this.retireInteractions(child)
		const results = await Promise.allSettled([
			child.task && !child.record.outcome ? child.task.abortTask({ kind: "interrupted", reason }) : undefined,
			child.settlement,
		])
		const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
		if (failures.length) throw new AggregateError(failures, `Tasklet ${id} interruption failed`)
		return this.inspect(id)
	}

	private async observeRun(child: OwnedTasklet, task: Task): Promise<void> {
		let outcome: TaskRunOutcome
		try {
			outcome = await task.startTask(child.record.prompt)
		} catch (error) {
			// Task normally returns a failed outcome, including finalization errors.
			// A rejected start still requires cancellation before persistence retirement.
			const failures: unknown[] = [error]
			try {
				await task.abortTask()
			} catch (abortError) {
				failures.push(abortError)
			}
			outcome = {
				kind: "failed",
				failedAt: Date.now(),
				error: serializeTaskError(failures.length > 1 ? new AggregateError(failures, "Tasklet startup failed") : error),
			}
		}
		const settlementFailures: unknown[] = []
		// A failed run outcome can include a failed final flush. It is not proof that
		// persistence retired successfully, so verify the engine's idempotent retirement.
		try {
			await task.retirePersistence()
		} catch (error) {
			settlementFailures.push(error)
			if (outcome.kind !== "failed") {
				outcome = { kind: "failed", failedAt: Date.now(), error: serializeTaskError(error) }
			}
		}
		if (outcome.kind === "failed") {
			child.failedTranscript = structuredClone({
				conversation: task.messageStateHandler.getApiConversationHistory(),
				presentation: task.messageStateHandler.getDiracMessages(),
			})
		}
		try {
			await this.persistOutcome(child, outcome)
		} catch (error) {
			settlementFailures.push(error)
		}
		if (settlementFailures.length) {
			const error = settlementFailures.length === 1
				? settlementFailures[0]
				: new AggregateError(settlementFailures, "Tasklet persistence settlement failed")
			child.settlementError = serializeTaskError(error)
			throw error
		}
	}

	private async persistOutcome(child: OwnedTasklet, outcome: TaskRunOutcome): Promise<void> {
		this.retireInteractions(child)
		child.record = { ...child.record, outcome }
		try {
			await saveTaskletRecord(child.record)
			await child.eventWrites
			child.outcomePersisted = true
		} catch (error) {
			child.settlementError = serializeTaskError(error)
			throw error
		} finally {
			child.task = undefined
			child.backgroundCommandRunning = false
		}
	}

	private waitForInteraction(child: OwnedTasklet, request: TaskInteractionRequest, signal: AbortSignal): Promise<TaskletInteractionResult> {
		signal.throwIfAborted()
		if (this.closing || child.interactionsClosed || child.record.outcome) throw new Error("Tasklet counterparty is closed")
		if ([...child.interactions.values()].some(({ record }) => record.card.id === request.card.id)) {
			throw new Error(`Tasklet interaction for card ${request.card.id} already exists`)
		}
		const id = ulid()
		const record: TaskletInteraction = { ...structuredClone(request), id, status: "pending", createdAt: Date.now() }
		const cancellation = new AbortController()
		child.events.push({ id, taskletId: child.record.id, createdAt: record.createdAt, communication: { type: "interaction", request: record } })
		const waiting = new Promise<TaskletInteractionResult>((resolve, reject) => {
			const retire = () => {
				if (record.status !== "pending") return
				record.status = "retired"
				record.retiredAt = Date.now()
				signal.removeEventListener("abort", retire)
				const error = new Error(`Tasklet interaction ${id} retired`)
				cancellation.abort(error)
				reject(error)
				void this.persistEvents(child)
			}
			child.interactions.set(id, {
				record, cancellation, resolving: false, retire,
				resolve: (result) => {
					cancellation.signal.throwIfAborted()
					if (record.status !== "pending") throw new Error(`Tasklet interaction ${id} is not pending`)
					record.status = "resolved"
					record.resolvedAt = Date.now()
					record.resolution = structuredClone(result)
					signal.removeEventListener("abort", retire)
					resolve(structuredClone(result))
				},
			})
			signal.addEventListener("abort", retire, { once: true })
		})
		// Observe both immediately: cancellation can precede the first disk write.
		return Promise.all([waiting, this.persistEvents(child)]).then(([result]) => result)
	}

	private retireInteractions(child: OwnedTasklet): void {
		child.interactionsClosed = true
		for (const interaction of child.interactions.values()) interaction.retire()
	}

	private requireChild(id: string): OwnedTasklet {
		const child = this.children.get(id)
		if (!child) throw new Error(`Tasklet ${id} does not belong to root ${this.rootTaskId}`)
		return child
	}

	private address(id: string) {
		return { kind: "tasklet" as const, rootTaskId: this.rootTaskId, taskletId: id }
	}
}

async function unavailableForegroundCallback(): Promise<never> {
	throw new Error("Tasklet cannot use a foreground lifecycle callback")
}
