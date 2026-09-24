import type { PendingApiConversationCompaction } from "@core/api/conversation"
import { AssistantMessageContent } from "@core/assistant-message"
import { TaskStatus } from "@shared/ExtensionMessage"
import type { DiracUserContent } from "@shared/messages/content"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { SkillMetadata } from "@/shared/skills"
import type { SteeringMessage } from "./steering"
import type { SerializedTaskError, TaskCancellationIntent, TaskRunOutcome } from "./TaskRunOutcome"
import type { HookExecution } from "./types/HookExecution"

export interface CompletionVerificationFailure {
	candidateFingerprint?: string
	reports: string[]
}

export interface TaskReplacementRequest {
	context: string
	images?: string[]
	files?: string[]
}

export class TaskState {
	status: TaskStatus = TaskStatus.IDLE

	// Task-level timing
	taskStartTimeMs = Date.now()
	#taskFirstTokenTimeMs?: number

	// Streaming flags — writable only through the named transitions below.
	#isApiRequestActive = false
	#activeVoiceStreamId?: string
	#isWaitingForFirstChunk = false
	#didCompleteReadingStream = false

	get isApiRequestActive(): boolean {
		return this.#isApiRequestActive
	}
	get activeVoiceStreamId(): string | undefined {
		return this.#activeVoiceStreamId
	}
	get isWaitingForFirstChunk(): boolean {
		return this.#isWaitingForFirstChunk
	}
	get didCompleteReadingStream(): boolean {
		return this.#didCompleteReadingStream
	}

	/** First-wins: recorded once for the whole task, measured from taskStartTimeMs. */
	get taskFirstTokenTimeMs(): number | undefined {
		return this.#taskFirstTokenTimeMs
	}
	recordFirstTokenAt(timeMs: number): void {
		this.#taskFirstTokenTimeMs ??= timeMs
	}

	/** Marks the outbound request as live. */
	beginApiRequest(): void {
		this.#isApiRequestActive = true
	}
	/** Settles the request; the voice stream attachment always releases with it. */
	endApiRequest(): void {
		this.#isApiRequestActive = false
		this.#activeVoiceStreamId = undefined
	}
	beginFirstChunkWait(): void {
		this.#isWaitingForFirstChunk = true
	}
	endFirstChunkWait(): void {
		this.#isWaitingForFirstChunk = false
	}
	completeStreamRead(): void {
		this.#didCompleteReadingStream = true
	}
	resetStreamRead(): void {
		this.#didCompleteReadingStream = false
	}
	attachVoiceStream(id: string): void {
		this.#activeVoiceStreamId = id
	}
	/** Detaches the stream; an expectedId guards against clearing a newer attachment. */
	detachVoiceStream(expectedId?: string): void {
		if (expectedId !== undefined && this.#activeVoiceStreamId !== expectedId) return
		this.#activeVoiceStreamId = undefined
	}

	// Content processing
	assistantMessageContent: AssistantMessageContent[] = []
	useNativeToolCalls = false
	userMessageContent: DiracUserContent[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Ask/Response handling
	askResponse?: DiracAskResponse
	askResponseAction?: string
	askResponseValue?: string

	askResponseUserEdits?: Record<string, string>
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	lastMessageTs?: number
	waitingCardIds: string[] = []
	get lastWaitingCardId(): string | undefined {
		return this.waitingCardIds[0]
	}

	// Plan interaction and mode-entry state
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false
	/** Remains pending until the exact request that includes the notice is persisted. */
	pendingModeNotice?: { mode: "plan" | "act"; includedInRequestId?: string }

	// Context and history
	conversationHistoryDeletedRange?: [number, number]
	/** Session-owned snapshots injected into every compacted request. */
	pinnedContext?: string
	/** Canonical task text supplied when this Task lifecycle was created. */
	initialTask?: string

	// Tool execution flags
	didRejectTool = false
	didAlreadyUseTool = false
	didEditFile = false

	// Error tracking
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	didAttemptCompletion = false
	/** Completion side effects are committed; steering is sealed until the task loop publishes completion. */
	completionCommitted = false
	checkpointManagerErrorMessage?: string
	/** Last rejected completion candidate and all verifier reports that it must address. */
	completionVerificationFailure?: CompletionVerificationFailure

	// Retry tracking — separate counters for independent failure modes
	apiErrorRetryAttempts = 0
	emptyResponseRetryAttempts = 0

	// Task Initialization
	isInitialized = false

	// Task Abort / Cancellation — terminal fields are single-assignment via the methods below.
	/** Owner intent captured before teardown begins. The first terminal intent wins. */
	#cancellationIntent?: TaskCancellationIntent
	/** Response accepted by the Task completion commit. Reset when a follow-up turn starts. */
	#completionResponse?: string
	/** Fatal error preserved for the Task owner. */
	#terminalError?: SerializedTaskError
	/** Task-owned, single-assignment terminal result. */
	#runOutcome?: TaskRunOutcome

	get cancellationIntent(): TaskCancellationIntent | undefined {
		return this.#cancellationIntent
	}
	get completionResponse(): string | undefined {
		return this.#completionResponse
	}
	get terminalError(): SerializedTaskError | undefined {
		return this.#terminalError
	}
	get runOutcome(): TaskRunOutcome | undefined {
		return this.#runOutcome
	}

	/** First intent wins; ignored once the run outcome is settled. */
	captureCancellationIntent(intent: TaskCancellationIntent): void {
		if (this.#runOutcome) return
		this.#cancellationIntent ??= intent
	}

	/** Terminal transition: throws if the run already settled; failure/cancel details ride along. */
	settleRunOutcome(outcome: TaskRunOutcome): TaskRunOutcome {
		if (this.#runOutcome) throw new Error("TaskState.runOutcome is already settled")
		this.#runOutcome = outcome
		if (outcome.kind === "failed") this.#terminalError = outcome.error
		if (outcome.kind === "cancelled") this.#cancellationIntent ??= { kind: "cancelled", reason: outcome.reason }
		if (outcome.kind === "interrupted") this.#cancellationIntent ??= { kind: "interrupted", reason: outcome.reason }
		return outcome
	}

	commitCompletionResponse(response: string): void {
		this.#completionResponse = response
	}
	clearCompletionResponse(): void {
		this.#completionResponse = undefined
	}
	#abortController = new AbortController()

	get abort(): boolean {
		return this.#abortController.signal.aborted
	}

	set abort(value: boolean) {
		if (value) {
			this.#abortController.abort()
			return
		}
		if (this.#abortController.signal.aborted) this.#abortController = new AbortController()
	}

	get abortSignal(): AbortSignal {
		return this.#abortController.signal
	}
	/** Requested by a tool after its current task has unwound. */
	pendingTaskReplacement?: TaskReplacementRequest
	/** One-way latch: set once the abort teardown has run; never reset within a task lifecycle. */
	#didFinishAbortingStream = false
	get didFinishAbortingStream(): boolean {
		return this.#didFinishAbortingStream
	}
	markStreamAbortFinished(): void {
		this.#didFinishAbortingStream = true
	}
	abandoned = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Conversation compaction
	skipNextAutoCondenseCheck = false
	pendingApiConversationCompaction?: PendingApiConversationCompaction
	pendingCondenseSource?: "automatic"
	pendingCondenseFeedback?: string
	totalToolCallCount = 0

	lastAutoCondenseTriggerIndex?: number
	taskLockAcquired = false
	initialCheckpointCommitPromise?: Promise<string | undefined>
	availableSkills: SkillMetadata[] = []
	discoveredSkillsCache?: SkillMetadata[]
	// Trusted skills active for this task. Their authorized tool dependencies are request-scoped.
	activeSkillIds: string[] = []

	// Task-scoped user tool ids (persisted across task resume)
	taskScopedToolIds: string[] = []

	// Cumulative metrics for the entire task
	totalInputTokens = 0
	totalOutputTokens = 0
	totalReasoningTokens = 0
	totalCacheWriteTokens = 0
	totalCacheReadTokens = 0
	totalCost = 0

	// Utility permission usage is tracked separately from primary context-window metrics.
	utilityPermissionInputTokens = 0
	utilityPermissionOutputTokens = 0
	utilityPermissionCacheWriteTokens = 0
	utilityPermissionCacheReadTokens = 0
	utilityPermissionCost = 0
	utilityModelReasoningTokens = 0
	utilityModelUsageObserved = false
	utilityModelReasoningAvailable = true
	utilityModelCacheWriteAvailable = true
	utilityModelCacheReadAvailable = true
	utilityModelCostAvailable = true

	// Persistent task-owned mid-turn guidance. Never reset with stream-local state.
	steeringMessages: SteeringMessage[] = []

	// Pending user content from a chat-message tool skip.
	// Set when the user sends text or attachments while a tool is awaiting card input.
	// Consumed by initiateTaskLoop to forward the message to the LLM.
	pendingUserMessage?: string
	pendingUserImages?: string[]
	pendingUserFiles?: string[]
}

/**
 * Fields guarded by named transitions — writes outside a transition throw at runtime
 * (getter-only) and are excluded from generic backdoors like setTaskState.
 */
export type TaskStateGatedKey =
	| "isApiRequestActive"
	| "activeVoiceStreamId"
	| "isWaitingForFirstChunk"
	| "didCompleteReadingStream"
	| "didFinishAbortingStream"
	| "taskFirstTokenTimeMs"
	| "cancellationIntent"
	| "completionResponse"
	| "terminalError"
	| "runOutcome"

export type TaskStateTransition =
	| "recordFirstTokenAt"
	| "beginApiRequest"
	| "endApiRequest"
	| "beginFirstChunkWait"
	| "endFirstChunkWait"
	| "completeStreamRead"
	| "resetStreamRead"
	| "attachVoiceStream"
	| "detachVoiceStream"
	| "markStreamAbortFinished"
	| "captureCancellationIntent"
	| "settleRunOutcome"
	| "commitCompletionResponse"
	| "clearCompletionResponse"

/** Read view for consumers outside the task layer: data readonly, transitions hidden. */
export type ReadonlyTaskState = Readonly<Omit<TaskState, TaskStateTransition>>
