/**
 * Dirac Library Exports
 *
 * This file exports the public API for programmatic use of Dirac.
 * Use these classes and types to embed Dirac into your applications.
 *
 * @example
 * ```typescript
 * import { DiracAgent } from "dirac"
 *
 * const agent = new DiracAgent()
 * await agent.initialize({ clientCapabilities: {} })
 * const session = await agent.newSession({ cwd: process.cwd() })
 * ```
 * @module dirac
 */

export { DiracAgent } from "./agent/DiracAgent.js"
export { DiracSessionEmitter } from "./agent/DiracSessionEmitter.js"
export type {
	AcpAgentOptions,
	AcpSessionState,
	AcpSessionStatus,
	Agent,
	AgentSideConnection,
	AudioContent,
	CancelNotification,
	ClientCapabilities,
	DiracAcpSession,
	DiracAgentCapabilities,
	DiracAgentInfo,
	DiracAgentOptions,
	DiracSessionEvents,
	ContentBlock,
	ImageContent,
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	ModelInfo,
	NewSessionRequest,
	NewSessionResponse,
	PermissionHandler,
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
	SessionUpdatePayload,
	SessionUpdateType,
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
	TranslatedMessage,
} from "./agent/public-types.js"
