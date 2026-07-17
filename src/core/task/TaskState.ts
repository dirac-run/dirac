import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessageContent } from "@core/assistant-message"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { HookExecution } from "./types/HookExecution"
import { SkillMetadata } from "@/shared/skills"
import { TaskStatus } from "@shared/ExtensionMessage"

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
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

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

	// Plan mode specific state
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false
	didSwitchToActMode = false

	// Context and history
	conversationHistoryDeletedRange?: [number, number]
	/** Session-owned snapshots injected into every compacted request. */
	pinnedContext?: string

	// Tool execution flags
	didRejectTool = false
	didAlreadyUseTool = false
	didEditFile = false

	// Error tracking
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	didAttemptCompletion = false
	checkpointManagerErrorMessage?: string

	// Retry tracking — separate counters for independent failure modes
	apiErrorRetryAttempts = 0
	emptyResponseRetryAttempts = 0

	// Task Initialization
	isInitialized = false

	// Task Abort / Cancellation
	abort = false
	didFinishAbortingStream = false
	abandoned = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Conversation compaction
	skipNextAutoCondenseCheck = false
	pendingCondenseSource?: "automatic"
	pendingCondenseFeedback?: string
	totalToolCallCount = 0

	lastAutoCondenseTriggerIndex?: number
	taskLockAcquired = false
	initialCheckpointCommitPromise?: Promise<string | undefined>
	availableSkills: SkillMetadata[] = []
	discoveredSkillsCache?: SkillMetadata[]

	// Task-scoped user tool ids (persisted across task resume)
	taskScopedToolIds: string[] = []

	// Cumulative metrics for the entire task
	totalInputTokens = 0
	totalOutputTokens = 0
	totalReasoningTokens = 0
	totalCacheWriteTokens = 0
	totalCacheReadTokens = 0
	totalCost = 0

	// Pending user message from text-based tool skip
	// Set when user sends a text message while a tool is awaiting card approval.
	// Consumed by initiateTaskLoop to forward the message to the LLM.
	pendingUserMessage?: string
	pendingUserImages?: string[]
	pendingUserFiles?: string[]
}
