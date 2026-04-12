// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import { WorkspaceRoot } from "@shared/multi-root/types"
import type { Environment } from "../config"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { BrowserSettings } from "./BrowserSettings"
import { DiracFeatureSetting } from "./DiracFeatureSetting"
import { BannerCardData } from "./dirac/banner"
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
	partial?: boolean
	strictPlanModeEnabled?: boolean
	yoloModeToggled?: boolean
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
	nativeToolCallSetting?: boolean
	enableParallelToolCalling?: boolean
	backgroundEditEnabled?: boolean
	writePromptMetadataEnabled?: boolean
	writePromptMetadataDirectory?: string
	optOutOfRemoteConfig?: boolean
	doubleCheckCompletionEnabled?: boolean
	banners?: BannerCardData[]
	welcomeBanners?: BannerCardData[]
	openAiCodexIsAuthenticated?: boolean
}

export interface DiracMessage {
	ts: number
	type: "ask" | "say"
	ask?: DiracAsk
	say?: DiracSay
	text?: string
	reasoning?: string
	images?: string[]
	files?: string[]
	partial?: boolean
	commandCompleted?: boolean
	lastCheckpointHash?: string
	isCheckpointCheckedOut?: boolean
	isOperationOutsideWorkspace?: boolean
	conversationHistoryIndex?: number
	conversationHistoryDeletedRange?: [number, number] // for when conversation history is truncated for API requests
	modelInfo?: DiracMessageModelInfo
	multiCommandState?: MultiCommandState

}

export type DiracAsk =
	| "followup"
	| "plan_mode_respond"
	| "act_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "storage"
	| "mistake_limit_reached"
	| "browser_action_launch"
	| "new_task"
	| "condense"
	| "summarize_task"
	| "report_bug"
	| "use_subagents"

export type DiracSay =
	| "task"
	| "error"
	| "error_retry"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "completion_result"
	| "user_feedback"
	| "user_feedback_diff"
	| "api_req_retried"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "shell_integration_warning_with_suggestion"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "diff_error"
	| "deleted_api_reqs"
	| "diracignore_error"
	| "command_permission_denied"
	| "checkpoint_created"
	| "generate_explanation"
	| "info" // Added for general informational messages like retry status
	| "hook_status"
	| "hook_output_stream"
	| "subagent"
	| "subagent_usage"
	| "use_subagents"
	| "conditional_rules_applied"

export interface DiracSayTool {
	tool:
	| "editedExistingFile"
	| "newFileCreated"
	| "fileDeleted"
	| "readFile"
	| "read_file"
	| "readLineRange"
	| "read_line_range"
	| "listFilesTopLevel"
	| "list_files_top_level"
	| "listFilesRecursive"
	| "list_files_recursive"
	| "listCodeDefinitionNames"
	| "searchFiles"
	| "search_files"
	| "webFetch"
	| "webSearch"
	| "summarizeTask"
	| "useSkill"
	| "editFile"
	| "edit_file"
	| "getFunction"
	| "get_function"
	| "getFileSkeleton"
	| "get_file_skeleton"
	| "findSymbolReferences"
	| "find_symbol_references"
	| "renameSymbol"
	| "rename_symbol"
	| "replaceSymbol"
	| "replace_symbol"
	| "subagent"
	| "browser_action"
	| "browser_action_result"
	| "diagnosticsScan"
	| "diagnostics_scan"
	| "executeCommand"
	| "execute_command"

	script?: string;
	language?: string;

	path?: string
	paths?: string[]
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	symbols?: string[]
	symbol?: string
	existing_symbol?: string
	new_symbol?: string
	total_replacements?: number
	files_affected?: number
	operationIsLocatedInWorkspace?: boolean
	/** Starting line numbers in the original file where each SEARCH block matched */
	startLineNumbers?: number[]
	editsCount?: number
	functionNames?: string[]
	foundFunctionNames?: string[]
	skeletons?: { path: string; content: string }[]
	references?: { path: string; refs: string[] }[]
	replacements?: Array<{
		path: string
		symbol: string
		text: string
		type?: string
		diff?: string
	}>
	filesCount?: number
	contextLines?: number
	startLine?: string
	endLine?: string
	browser_action?: DiracSayBrowserAction
	browser_action_result?: BrowserActionResult
	editSummaries?: Array<{
		path: string
		edits: Array<{ additions: number; deletions: number }>
		diagnostics?: { fixedCount: number; newProblemsMessage?: string }
	}>
	command?: string
	action?: BrowserAction
	url?: string
	query?: string
	diagnostics?: { fixedCount: number; newProblemsMessage?: string }
}

export interface DiracSayHook {
	hookName: string // Name of the hook (e.g., "PreToolUse", "PostToolUse")
	toolName?: string // Tool name if applicable (for PreToolUse/PostToolUse)
	status: "running" | "completed" | "failed" | "cancelled" // Execution status
	exitCode?: number // Exit code when completed
	hasJsonResponse?: boolean // Whether a JSON response was parsed
	// Pending tool information (only present during PreToolUse "running" status)
	pendingToolInfo?: {
		tool: string // Tool name (e.g., "write_to_file", "execute_command")
		path?: string // File path for file operations
		command?: string // Command for execute_command
		content?: string // Content preview (first 200 chars)
		diff?: string // Diff preview (first 200 chars)
		regex?: string // Regex pattern for search_files
		url?: string // URL for web_fetch or browser_action
	}
	// Structured error information (only present when status is "failed")
	error?: {
		type: "timeout" | "validation" | "execution" | "cancellation" // Type of error
		message: string // User-friendly error message
		details?: string // Technical details for expansion
		scriptPath?: string // Path to the hook script
	}
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

export interface DiracSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	text?: string
}

export interface DiracSayGenerateExplanation {
	title: string
	fromRef: string
	toRef: string
	status: "generating" | "complete" | "error"
	error?: string
}

export type SubagentExecutionStatus = "pending" | "running" | "completed" | "failed"

export interface SubagentStatusItem {
	index: number
	prompt: string
	status: SubagentExecutionStatus
	toolCalls: number
	inputTokens: number
	outputTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	latestToolCall?: string
	result?: string
	error?: string
}

export interface DiracSaySubagentStatus {
	status: "running" | "completed" | "failed"
	total: number
	completed: number
	successes: number
	failures: number
	toolCalls: number
	inputTokens: number
	outputTokens: number
	contextWindow: number
	maxContextTokens: number
	maxContextUsagePercentage: number
	items: SubagentStatusItem[]
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface DiracAskUseSubagents {
	prompts: string[]
}

export interface DiracPlanModeResponse {
	response: string
	options?: string[]
	selected?: string
}

export interface DiracAskQuestion {
	question: string
	options?: string[]
	selected?: string
}

export interface DiracAskNewTask {
	context: string
}

export interface DiracApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
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

export interface MultiCommandState {
	commands: Array<{
		command: string
		displayName?: string
		status: "pending" | "running" | "completed" | "failed" | "skipped"
		output?: string
		exitCode?: number
		signal?: string
		requiresApproval?: boolean
		wasAutoApproved?: boolean
	}>
}
