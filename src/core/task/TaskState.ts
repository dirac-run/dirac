import type { DiracUserContent } from "@shared/messages/content"
import type { PendingApiConversationCompaction } from "@core/api/conversation"
import { AssistantMessageContent } from "@core/assistant-message"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { HookExecution } from "./types/HookExecution"
import type { SteeringMessage } from "./steering"
import { SkillMetadata } from "@/shared/skills"
import { TaskStatus } from "@shared/ExtensionMessage"
import type { SerializedTaskError, TaskCancellationIntent, TaskRunOutcome } from "./TaskRunOutcome"

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
	taskFirstTokenTimeMs?: number

	// Streaming flags
	isApiRequestActive = false
	activeVoiceStreamId?: string
	isWaitingForFirstChunk = false
	didCompleteReadingStream = false

	// Content processing
	currentStreamingContentIndex = 0
	lastProcessedContentLength = 0
	assistantMessageContent: AssistantMessageContent[] = []
	useNativeToolCalls = false
	userMessageContent: DiracUserContent[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

	// Ask/Response handling
	askResponse?: DiracAskResponse
	/** Card owning the pending response, including responses received before its waiter finishes setup. */
	askResponseCardId?: string
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

	// Task Abort / Cancellation
	/** Owner intent captured before teardown begins. The first terminal intent wins. */
	cancellationIntent?: TaskCancellationIntent
	/** Response accepted by the Task completion commit. */
	completionResponse?: string
	/** Fatal error preserved for the Task owner. */
	terminalError?: SerializedTaskError
	/** Task-owned, single-assignment terminal result. */
	runOutcome?: TaskRunOutcome
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
	didFinishAbortingStream = false
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
