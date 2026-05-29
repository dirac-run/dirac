/**
 * Public types for the Dirac library API.
 *
 * This file contains types that are safe to export to library consumers.
 * It must NOT import any internal types (Controller, StateManager, etc.)
 * to keep the generated declaration files clean.
 *
 * Internal-only extensions of these types live in ./types.ts.
 */

import type * as acp from "@agentclientprotocol/sdk"

// ============================================================
// Session Update Type Utilities
// ============================================================

/**
 * Different types of updates that can be sent during session processing.
 *
 * These updates provide real-time feedback about the agent's progress.
 *
 * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
 */
export type SessionUpdateType = acp.SessionUpdate["sessionUpdate"]

/**
 * Different types of update payloads that can be sent during session processing.
 *
 * Each update type has a corresponding payload structure defined in the ACP SessionUpdate union.
 */
export type SessionUpdatePayload<T extends SessionUpdateType> = Omit<
	Extract<acp.SessionUpdate, { sessionUpdate: T }>,
	"sessionUpdate"
>

// ============================================================
// Permission Handler Callback Types
// ============================================================

/**
 * Handler function for permission requests.
 * Called when the agent needs permission for a tool call.
 * The handler should present the request to the user and call resolve() with their response.
 */
export type PermissionHandler = (
	request: acp.RequestPermissionRequest,
	resolve: (response: acp.RequestPermissionResponse) => void,
) => void

// ============================================================
// Session Event Emitter Types
// ============================================================

/**
 * Maps ACP SessionUpdate types to their event listener signatures.
 * Uses the sessionUpdate discriminator to derive event names and payload types.
 */
export type DiracSessionEvents = {
	[K in SessionUpdateType]: (payload: SessionUpdatePayload<K>) => void
} & {
	/** Error event for session-level errors (not part of ACP SessionUpdate) */
	error: (error: Error) => void
}

// ============================================================
// DiracAgent Options
// ============================================================

/**
 * Options for creating a DiracAgent instance.
 */
export interface DiracAgentOptions {
	/** Whether debug logging is enabled */
	debug?: boolean
	/** Dirac Config Directory (defaults to ~/.dirac) */
	diracDir?: string
	/** Workspace directory for CLI context initialization */
	cwd?: string
	/** Additional runtime hooks directory */
	hooksDir?: string
}

/**
 * Options for creating an ACP agent instance.
 */
export interface AcpAgentOptions {
	/** Whether debug logging is enabled */
	debug?: boolean
	/** Dirac Config Directory (defaults to ~/.dirac) */
	diracDir?: string
	/** Workspace directory for CLI context initialization */
	cwd?: string
	/** Additional runtime hooks directory */
	hooksDir?: string
}

// ============================================================
// Session Types
// ============================================================
export type SessionID = string

/**
 * Extended session data stored by Dirac for ACP sessions.
 */
export interface DiracAcpSession {
	/** Unique session ID */
	sessionId: SessionID
	/** Working directory for the session */
	cwd: string
	/** Concrete backing task ID used for persisted task files. ACP sessionId remains the stable conversation ID. */
	taskId?: string
	/** Current mode (plan/act) */
	mode: "plan" | "act"
	/** Timestamp when session was created */
	createdAt: number
	/** Timestamp of last activity */
	lastActivityAt: number
	/** Whether this session was loaded from history (needs resume on first prompt) */
	isLoadedFromHistory?: boolean
	/** Model ID override for plan mode (format: "provider/modelId") */
	planModeModelId?: string
	/** Model ID override for act mode (format: "provider/modelId") */
	actModeModelId?: string
}

/**
 * Lifecycle status of an ACP session.
 *
 * Represents the state machine:
 *   Idle → Processing → Idle       (normal completion)
 *   Idle → Processing → Cancelled  (cancellation, then back to Idle on next prompt)
 */
export enum AcpSessionStatus {
	/** Session is idle, waiting for a prompt */
	Idle = "idle",
	/** Session is actively processing a prompt */
	Processing = "processing",
	/** Session processing was cancelled */
	Cancelled = "cancelled",
}

/**
 * State tracking for an active ACP session within Dirac.
 */
export interface AcpSessionState {
	/** Session ID */
	sessionId: SessionID
	/** Current lifecycle status of the session */
	status: AcpSessionStatus
	/** Current tool call ID being executed (if any) */
	currentToolCallId?: string
	/** Shared tool_call id for the in-flight auto-retry sequence (if any).
	 *  Reused across multiple `error_retry` messages so the client sees one
	 *  evolving item rather than three white text lines. */
	retryToolCallId?: string
	/** Accumulated tool calls for permission batching */
	pendingToolCalls: Map<string, acp.ToolCall>
}

// ============================================================
// Agent Capabilities
// ============================================================

/**
 * Dirac-specific agent capabilities extending the ACP base capabilities.
 */
export interface DiracAgentCapabilities {
	/** Support for loading sessions from disk */
	loadSession: boolean
	/** Prompt capabilities for the agent */
	promptCapabilities: {
		/** Support for image inputs */
		image: boolean
		/** Support for audio inputs */
		audio: boolean
		/** Support for embedded context (file resources) */
		embeddedContext: boolean
	}
}

/**
 * Dirac agent info for ACP initialization response.
 */
export interface DiracAgentInfo {
	name: "dirac"
	title: "Dirac"
	version: string
}

// ============================================================
// Message Translation
// ============================================================

/**
 * Result of translating a Dirac message to ACP session update(s).
 * A single Dirac message may produce multiple ACP updates.
 */
export interface TranslatedMessage {
	/** The session updates to send */
	updates: acp.SessionUpdate[]
	/** Whether this message requires a permission request */
	requiresPermission?: boolean
	/** Permission request details if required */
	permissionRequest?: Omit<acp.RequestPermissionRequest, "sessionId">
	/** The toolCallId that was created/used (for tracking across streaming updates) */
	toolCallId?: string
}

// ============================================================
// Re-exported ACP Types
// ============================================================

export type {
	Agent,
	AgentSideConnection,
	AudioContent,
	CancelNotification,
	ClientCapabilities,
	ContentBlock,
	ImageContent,
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	ListSessionsRequest,
	ListSessionsResponse,
	LoadSessionResponse,
	ModelInfo,
	NewSessionRequest,
	NewSessionResponse,
	PermissionOption,
	PermissionOptionKind,
	PromptRequest,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionModelState,
	SessionNotification,
	SessionUpdate,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	SetSessionModelRequest,
	SetSessionModelResponse,
	SetSessionModeRequest,
	SetSessionModeResponse,
	StopReason,
	TextContent,
	ToolCall,
	ToolCallStatus,
	ToolCallUpdate,
	ToolKind,
} from "@agentclientprotocol/sdk"
