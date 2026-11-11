import type { ToolConfig, ToolServices } from "./ToolConfig"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import type { PermissionDecisionServiceBinding } from "@core/permissions/UtilityPermissionDecisionService"
import type { BuildUtilityModelRunnerOptions, UtilityModelRunner } from "@core/utility-model/UtilityModelRunner"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions, CommandExecutionResult } from "@integrations/terminal"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { ModelProviderSelection } from "@shared/api"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { DiracContent } from "@shared/messages/content"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { MessageStateHandler } from "../../message-state"
import { TaskMessenger } from "../../TaskMessenger"
import type { TaskState } from "../../TaskState"
import type { HookExecution } from "../../types/HookExecution"
import type { IDiracContext } from "../interfaces/IDiracContext"
import type { ToolRequestSnapshot } from "../runtime/ToolSnapshot"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
export interface TaskConfig extends ToolConfig {

	// State management
	taskState: TaskState
	messageState: MessageStateHandler

	// Secret-free services
	services: TaskServices

	// Settings
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	/** Present only when Utility-model permission handling is fully configured. */
	permissionDecisionBinding?: PermissionDecisionServiceBinding

	// Callbacks (strongly typed)
	callbacks: TaskCallbacks

	// Tool coordination
	coordinator: ToolExecutorCoordinator
	taskMessenger: TaskMessenger
	context: IDiracContext
	/** Absent during tool discovery; bound once for an admitted invocation. */
	readonly execution?: import("../interfaces/ToolExecutionScope").ToolExecutionScope
	readonly messengerContext?: import("../../types/task-messenger").TaskMessengerInvocationContext
	/** Mutable invocation-local state, never a shared TaskState counter. */
	invocationEffects?: import("../interfaces/ToolInvocationResult").ToolInvocationEffectsAccumulator
	/** The model tool call currently being executed, used for observable metadata. */
	toolUse?: { name: string; params: Record<string, unknown> }

	/** Snapshot active for the request that created this tool execution context. */
	activeToolSnapshot?: ToolRequestSnapshot
}

/**
 * All services available to tool handlers
 */
export interface TaskServices extends ToolServices {
	browserSession: BrowserSession
	urlContentFetcher: UrlContentFetcher
	diffViewProvider: DiffViewProvider
	fileContextTracker: FileContextTracker
	diracIgnoreController: DiracIgnoreController
	contextManager: ContextManager
}



/**
 * All callback functions available to tool handlers
 */
export interface TaskCallbacks {
	/** Captures global user-controlled policy before command approval; absent only in test/discovery environments. */
	captureCommandSandbox?: () => import("@shared/SandboxExecution").SandboxExecutionContext
	/** Optional root-owned capability; absent for contained and Goal executions. */
	tasklets?: import("../interfaces/IToolEnvironment").TaskletControls
	/** Root-scoped ordinary communication; available to roots and contained children. */
	agentCommunication?: import("../../AgentCommunication").AgentCommunicationCapability
	agentWait?: import("../../AgentCommunication").AgentWaitCapability
	sharedJournal?: import("../../SharedJournalTypes").SharedJournalCapability
	commandApprovals?: import("../interfaces/CommandApprovals").CommandApprovalsCapability
	/** Revalidates request-bound mutation consent against the Task's current mode. */
	assertMutationAuthorized: (toolName?: DiracToolSpec["id"]) => void
	/** Holds task mutation consent through the complete asynchronous write boundary. */
	withMutationAuthorization: <T>(toolName: DiracToolSpec["id"] | undefined, mutation: () => Promise<T>) => Promise<T>
	/** Hand an active mutation lease directly to a task configuration transition. */
	transitionFromMutation: <T>(transition: () => Promise<T>) => Promise<T>
	/** Keep a detached asynchronous mutation inside the task transition boundary. */
	retainMutationUntil: (completion: Promise<void>) => void
	/** Commit newly enabled shared tools to the task-owned toggles and persisted defaults. */
	commitEnabledToolToggles: (toolIds: readonly string[], finalize?: () => Promise<void>) => Promise<void>
	saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => Promise<void>
	commitAttemptCompletion: (response: string) => Promise<import("../interfaces/IToolEnvironment").CompletionCommitResult>

	executeCommandTool: (
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	) => Promise<CommandExecutionResult>
	cancelRunningCommandTool?: () => Promise<boolean>

	doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>

	shouldAutoApproveTool: (toolName: DiracDefaultTool) => boolean | [boolean, boolean]
	shouldAutoApproveToolWithPath: (toolName: DiracToolSpec["id"], path?: string) => Promise<boolean>
	resolveToolPathPermission: (
		toolName: DiracToolSpec["id"],
		path?: string,
	) => Promise<import("../autoApprove").ToolPermissionDisposition>

	// Additional callbacks for task management
	postStateToWebview: () => Promise<void>
	cancelTask: () => Promise<void>
	getDiracMessages: () => DiracMessage[]
	updateDiracMessage: (index: number, updates: Partial<DiracMessage>) => Promise<void>

	applyLatestBrowserSettings: () => Promise<BrowserSession>

	switchToActMode: () => Promise<boolean>

	// Hook execution callbacks
	setActiveHookExecution: (hookExecution: HookExecution) => Promise<void>
	clearActiveHookExecution: (runId: string) => Promise<void>
	getActiveHookExecution: (runId: string) => Promise<HookExecution | undefined>

	// User prompt hook callback
	runUserPromptSubmitHook: (
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>
	resetTransientState: () => Promise<void>
	notifyContextCompacted: () => void

	/** Build a Utility runner without exposing the credential-bearing API configuration to tools. */
	createUtilityModelRunner: (selection: ModelProviderSelection, options?: BuildUtilityModelRunnerOptions) => UtilityModelRunner
}

/**
 * Runtime validation function to ensure config has all required properties
 * Automatically derives expected keys from the interface definitions
 */
export function validateTaskConfig(config: any): asserts config is TaskConfig {
	if (!config) {
		throw new Error("TaskConfig is null or undefined")
	}

	// Validate all expected keys exist
	for (const key of TASK_CONFIG_KEYS) {
		if (!(key in config)) {
			throw new Error(`Missing ${key} in TaskConfig`)
		}
	}

	// Special validation for boolean type
	if (typeof config.strictPlanModeEnabled !== "boolean") {
		throw new Error("strictPlanModeEnabled must be a boolean in TaskConfig")
	}

	// Validate services object
	if (config.services) {
		for (const key of TASK_SERVICES_KEYS) {
			if (!(key in config.services)) {
				throw new Error(`Missing services.${key} in TaskConfig`)
			}
		}
	}

	// Validate callbacks object
	if (config.callbacks) {
		for (const key of TASK_CALLBACKS_KEYS) {
			if (typeof config.callbacks[key] !== "function") {
				throw new Error(`Missing or invalid callbacks.${key} in TaskConfig (must be a function)`)
			}
		}
	}
}
