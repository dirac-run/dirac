/**
 * Internal types for ACP integration with Dirac CLI.
 *
 * This file re-exports all public types from ./public-types.ts and adds
 * internal-only Types that reference core modules (Controller, etc.).
 *
 * Library consumers should never import from this file directly — they
 * get the public types via the library entrypoint (exports.ts).
 */

export type {
	Agent,
	AgentSideConnection,
	AudioContent,
	CancelNotification,
	ContentBlock,
	ImageContent,
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	ModelInfo,
	NewSessionRequest,
	NewSessionResponse,
	PermissionOption,
	PermissionOptionKind,
	PromptRequest,
	PromptResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
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
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk"

export type {
	AcpAgentOptions,
	AcpSessionState,
	DiracAgentCapabilities,
	DiracAgentInfo,
	DiracAgentOptions,
	DiracSessionEvents,
	PermissionHandler,
	SessionUpdatePayload,
	SessionUpdateType,
	TranslatedMessage,
} from "./public-types.js"

export { AcpSessionStatus } from "./public-types.js"
