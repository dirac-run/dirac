// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import { DiracAskResponse } from "./WebviewMessage"

import { WorkspaceRoot } from "@shared/multi-root/types"
import type { Environment } from "../config"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { SkillMetadata } from "./skills"
import { BrowserSettings } from "./BrowserSettings"
import { DiracFeatureSetting } from "./DiracFeatureSetting"
import { BannerCardData } from "./dirac/banner"
import { DiracIcon } from "./icons"
import { DiracRulesToggles } from "./dirac-rules"
import { HistoryItem } from "./HistoryItem"
import { DiracMessageModelInfo } from "./messages"
import { OnboardingModelGroup } from "./proto/dirac/state"
import { isOpenaiReasoningEffort, Mode, OPENAI_REASONING_EFFORT_OPTIONS, OpenaiReasoningEffort } from "./storage/types"
export type { Mode, OpenaiReasoningEffort }
export { OPENAI_REASONING_EFFORT_OPTIONS, isOpenaiReasoningEffort }

import { TelemetrySetting } from "./TelemetrySetting"
// webview will hold state
export interface ExtensionMessage {
    type: "grpc_response" // New type for gRPC responses
    grpc_response?: GrpcResponse
}

export type GrpcResponse = {
    message?: any // JSON serialized protobuf message
    request_id: string // Same ID as the request
    error?: string // Optional error message
    is_streaming?: boolean // Whether this is part of a streaming response
    sequence_number?: number // For ordering chunks in streaming responses
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export const DEFAULT_PLATFORM = "unknown"

export const COMMAND_CANCEL_TOKEN = "__dirac_command_cancel__"
export interface ToolMetadata {
    id: string
    name: string
    description: string
    source: "builtin" | "global" | "workspace"
    modulePath: string
}


export interface ExtensionState {
    isNewUser: boolean
    welcomeViewCompleted: boolean
    onboardingModels: OnboardingModelGroup | undefined
    apiConfiguration?: ApiConfiguration
    autoApprovalSettings: AutoApprovalSettings
    browserSettings: BrowserSettings
    remoteBrowserHost?: string
    preferredLanguage?: string
    mode: Mode
    checkpointManagerErrorMessage?: string
    diracMessages: DiracMessage[]
    currentTaskItem?: HistoryItem
    planActSeparateModelsSetting: boolean
    enableCheckpointsSetting?: boolean
    platform: Platform
    environment?: Environment
    shouldShowAnnouncement: boolean
    taskHistory: HistoryItem[]
    telemetrySetting: TelemetrySetting
    shellIntegrationTimeout: number
    terminalReuseEnabled?: boolean
    terminalOutputLineLimit: number
    maxConsecutiveMistakes: number
    defaultTerminalProfile?: string
    vscodeTerminalExecutionMode: string
    backgroundCommandRunning?: boolean
    backgroundCommandTaskId?: string
    lastCompletedCommandTs?: number
    version: string
    distinctId: string
    globalDiracRulesToggles: DiracRulesToggles
    localDiracRulesToggles: DiracRulesToggles
    localWorkflowToggles: DiracRulesToggles
    globalWorkflowToggles: DiracRulesToggles
    localCursorRulesToggles: DiracRulesToggles
    localWindsurfRulesToggles: DiracRulesToggles
    remoteRulesToggles?: DiracRulesToggles
    remoteWorkflowToggles?: DiracRulesToggles
    localAgentsRulesToggles: DiracRulesToggles
    /** The ID of the message currently being streamed (markdown/reasoning) */
    activeVoiceStreamId?: string
    /** Whether an API request is currently in flight */
    isApiRequestActive?: boolean
    strictPlanModeEnabled?: boolean
    yoloModeToggled?: boolean
    autoApproveAllToggled?: boolean
    useAutoCondense?: boolean
    subagentsEnabled?: boolean
    diracWebToolsEnabled?: DiracFeatureSetting
    worktreesEnabled?: DiracFeatureSetting
    customPrompt?: string
    favoritedModelIds: string[]
    // NEW: Add workspace information
    workspaceRoots: WorkspaceRoot[]
    primaryRootIndex: number
    isMultiRootWorkspace: boolean
    multiRootSetting: DiracFeatureSetting
    lastDismissedInfoBannerVersion: number
    lastDismissedModelBannerVersion: number
    lastDismissedCliBannerVersion: number
    dismissedBanners?: Array<{ bannerId: string; dismissedAt: number }>
    hooksEnabled?: boolean
    statistic?: Record<string, any>
    globalSkillsToggles?: Record<string, boolean>
    localSkillsToggles?: Record<string, boolean>
    enableParallelToolCalling?: boolean
    backgroundEditEnabled?: boolean
    writePromptMetadataEnabled?: boolean
    writePromptMetadataDirectory?: string
    optOutOfRemoteConfig?: boolean
    doubleCheckCompletionEnabled?: boolean
    banners?: BannerCardData[]
    availableSkills?: SkillMetadata[]
    availableTools: ToolMetadata[]
    toolToggles: Record<string, boolean>
    welcomeBanners?: BannerCardData[]
    openAiCodexIsAuthenticated?: boolean
    openAiCodexEmail?: string
    githubCopilotIsAuthenticated?: boolean
    githubCopilotEmail?: string
    githubCopilotModels?: Record<string, any>
    taskStatus: TaskStatus;
    uiActionState: UIActionState
}

export enum TaskStatus {
    IDLE = "idle",
    COMPLETED = "completed",
    PREPARING = "preparing",
    WAITING_FOR_API = "waiting_for_api",
    THINKING = "thinking",
    STREAMING_TEXT = "streaming_text",
    BUILDING_TOOL_CALL = "building_tool_call",
    EXECUTING_TOOL = "executing_tool",
    AWAITING_USER_INPUT = "awaiting_user_input",
    CANCELLING = "cancelling",
    BUILDING_REQUEST = "building_request",
    CANCELLED = "cancelled",
}

export enum DiracMessageType {
    MARKDOWN = "markdown",
    CARD = "card",
    API_STATUS = "api_status",
    CHECKPOINT = "checkpoint",
}

export type DiracMessageContent =
    /** Stateless conversational content (speech, reasoning, info) */
    | {
        type: DiracMessageType.MARKDOWN
        content: string
        isReasoning?: boolean
        images?: string[]
        files?: string[]
        isCompletion?: boolean
        completionType?: "act" | "plan"
        showFeedback?: boolean
        role?: "user" | "assistant"
    }
    /** Stateful tool-mediated unit of work */
    | { type: DiracMessageType.CARD; card: Card }
    /** System telemetry and vitals (tokens, cost, latency) */
    | { type: DiracMessageType.API_STATUS; status: DiracApiReqInfo }
    | { type: DiracMessageType.CHECKPOINT }

export interface DiracMessage {
    /** Unique identifier for handle-based updates */
    id: string
    /** Timestamp of creation */
    ts: number
    /** The semantic content of the message */
    content: DiracMessageContent
    /** Whether the message is currently streaming/incomplete */

    // --- Metadata & State (Non-content) ---
    /** Reasoning tokens used for this message */
    reasoningTokens?: number
    /** Model information for this message */
    modelInfo?: DiracMessageModelInfo
    /** Last checkpoint hash associated with this message */
    lastCheckpointHash?: string
    /** Whether the checkpoint is currently checked out */
    isCheckpointCheckedOut?: boolean
    /** Whether the operation was outside the workspace */
    isOperationOutsideWorkspace?: boolean
    /** Index in the conversation history */
    conversationHistoryIndex?: number
    /** Range of deleted messages in history */
    conversationHistoryDeletedRange?: [number, number]
    /** Optional state for multi-command execution */
    multiCommandState?: any

}

/** Handle for streaming text or reasoning from the LLM */
export interface ITextStreamHandle {
    /** The unique ID of the message being streamed */
    readonly id: string
    /** Appends a chunk of text to the message */
    append(chunk: string): Promise<void>
    /** Sets images for the message */
    setImages(images: string[]): Promise<void>
    /** Sets files for the message */
    setFiles(files: string[]): Promise<void>
    /** Marks the stream as complete */
    close(): Promise<void>
}

/** Interface for the Task Messenger used by hooks and tools */
export interface ITaskMessenger {
    streamText(type: "markdown" | "reasoning"): Promise<ITextStreamHandle>
    createCard(params: CardParams): Promise<ICardHandle>
    upsertApiStatus(status: DiracApiReqInfo): Promise<void>
    createCheckpoint(): Promise<ICardHandle>
    upsertText(text: string, isReasoning?: boolean, images?: string[], files?: string[]): Promise<void>
}


/** Handle for tool-mediated work units */
export interface ICardHandle extends ICardHandleBase {
    /** Transitions the card to a final state and resolves any pending interaction */
    finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void>
}


export interface ReadFileResult {
    path: string
    status: "success" | "error"
    label: string
}

export type HookOutputStreamMeta = {
    /** Which hook configuration the script originated from (global vs workspace). */
    source: "global" | "workspace"
    /** Full path to the hook script that emitted the output. */
    scriptPath: string
}

// must keep in sync with system prompt
export const browserActions = ["launch", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserAction = (typeof browserActions)[number]

export type SubagentExecutionStatus = "pending" | "running" | "completed" | "failed"

export interface SubagentStatusItem {
    index: number
    prompt: string
    status: SubagentExecutionStatus
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheWrites: number
    cacheReads: number
    totalCost: number
    contextTokens: number
    contextWindow: number
    contextUsagePercentage: number
    latestToolCall?: string
    result?: string
    error?: string
}

export type BrowserActionResult = {
    screenshot?: string
    logs?: string
    currentUrl?: string
    currentMousePosition?: string
}

export interface DiracApiReqInfo {
    id?: string
    request?: string
    tokensIn?: number
    tokensOut?: number
    cacheWrites?: number
    reasoningTokens?: number,
    cacheReads?: number
    cost?: number
    contextWindow?: number
    contextUsagePercentage?: number
    cancelReason?: DiracApiReqCancelReason
    streamingFailedMessage?: string
    retryStatus?: {
        attempt: number
        maxAttempts: number
        delaySec: number
        errorSnippet?: string
    }
}

export interface DiracSubagentUsageInfo {
    source: "subagents"
    tokensIn: number
    tokensOut: number
    cacheWrites: number
    cacheReads: number
    cost: number
}

export type DiracApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMMAND_OUTPUT_STRING = "Output:"
export const COMMAND_REQ_APP_STRING = "REQ_APP"
export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"



export type RenderType = "text" | "markdown" | "diff"
export type CleanupStrategy = "abandon" | "success" | "error" | "keep_running"

export interface ActionButton {
    label: string // Human-readable button text
    value: string // Machine-readable value returned to tool
    primary?: boolean // Hint for visual emphasis
    style?: "default" | "danger" | "secondary"
    url?: string // Optional URL to open in browser
}

export enum UIActionButtonType {
    APPROVE = "approve", // Primary action (e.g., "Approve", "Save", "Run")
    REJECT = "reject", // Negative action (e.g., "Reject", "Cancel")
    NEW_TASK = "new_task", // Terminal action to start over
    CANCEL = "cancel", // Interrupt action during streaming
    PROCEED = "proceed", // Continue without explicit approval (e.g., "Proceed Anyways")
    RETRY = "retry", // Re-run the last failed operation
    UTILITY = "utility", // Generic action for background tasks
}

export interface UIActionButton {
    label: string
    action: UIActionButtonType
    value?: string // Machine-readable value to return to the core
    primary?: boolean // Visual hint for the primary button
    style?: "default" | "danger" | "secondary"
}

export interface UIActionState {
    /** Global buttons (Cancel, Start New Task, Proceed Anyways, Retry) */
    globalButtons: UIActionButton[]

    /** Promoted buttons for the currently active tool card (if any) */
    cardButtons: UIActionButton[]

    /** The ID of the card that currently has the "focus" */
    activeCardId?: string

    /** Whether the main chat input should be locked */
    sendingDisabled: boolean
}

export interface Card {
    id: string
    header: string
    icon?: DiracIcon | string
    status: CardStatus
    renderType: RenderType
    body?: string
    requireApproval?: boolean
    requireFeedback?: boolean
    feedbackPlaceholder?: string
    actions?: ActionButton[]
    autoScroll?: boolean
    collapsed?: boolean
    maxHeight?: number
    cleanupStrategy?: CleanupStrategy
    do_not_auto_collapse?: boolean
    startTime?: number
    endTime?: number
    outcome?: string
}
export enum CardStatus {
    BUILDING = "building",
    PENDING = "pending",
    RUNNING = "running",
    SUCCESS = "success",
    ERROR = "error",
    SKIPPED = "skipped",
    CANCELLED = "cancelled",
    ABANDONED = "abandoned",
    WAITING_FOR_INPUT = "waiting_for_input",
}


/**
 * Check if a card status is a final (terminal) state.
 */
export function isFinalStatus(status: CardStatus): boolean {
    return (
        status === CardStatus.SUCCESS ||
        status === CardStatus.ERROR ||
        status === CardStatus.SKIPPED ||
        status === CardStatus.CANCELLED ||
        status === CardStatus.ABANDONED
    )
}

export interface CardParams {
    header: string
    icon?: DiracIcon | string
    status?: CardStatus
    renderType?: RenderType
    body?: string
    requireApproval?: boolean
    requireFeedback?: boolean
    feedbackPlaceholder?: string
    actions?: ActionButton[]
    collapsed?: boolean
    maxHeight?: number
    cleanupStrategy?: CleanupStrategy
    do_not_auto_collapse?: boolean
    outcome?: string
}

export interface ICardHandleBase {
    readonly id: string
    update(patch: Partial<Omit<Card, "id">>): Promise<void>
    appendBody(chunk: string): Promise<void>
    waitForInteraction(): Promise<{
        response: DiracAskResponse
        text?: string
        images?: string[]
        files?: string[]
        askTs?: number
        userEdits?: Record<string, string>
        action: string
        value?: string
    }>
}

