import type { ApiHandlerModel } from "@core/api"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import type { CommandPermissionController } from "@core/permissions"
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
import type { Mode } from "@shared/storage/types"
import type { SubagentIdentity } from "@shared/subagents"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { WorkspaceRootManager } from "@/core/workspace"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { MessageStateHandler } from "../../message-state"
import { TaskMessenger } from "../../TaskMessenger"
import type { TaskState } from "../../TaskState"
import type { DeepReadonly } from "../../runtime/TaskWorkingConfiguration"
import type { AutoApprove } from "../../tools/autoApprove"
import type { HookExecution } from "../../types/HookExecution"
import type { IDiracContext } from "../interfaces/IDiracContext"
import type { ToolRequestSnapshot } from "../runtime/ToolSnapshot"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"
import type { TaskExecutionProfile } from "../../TaskExecutionProfile"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
export interface TaskConfig {
	executionProfile: TaskExecutionProfile
	// Core identifiers
	taskId: string
	storageAddress?: TaskStorageAddress
	ulid: string
	cwd: string
	mode: Mode
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	lowVerbosityEnabled: boolean
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	enableParallelToolCalling: boolean
	isSubagentExecution: boolean
	/** Display identity for an observable subagent execution. */
	agentIdentity?: SubagentIdentity
	backgroundEditEnabled: boolean
	/** Request-bound provider identity and secret-free operational settings. */
	providerId: string
	model: DeepReadonly<ApiHandlerModel>
	supportsNativeWebSearch: boolean
	customPrompt?: "compact"
	hooksEnabled: boolean
	subagentsEnabled: boolean
	useAutoCondense: boolean
	utilityModelEnabled: boolean
	utilityModelUseCondense: boolean
	utilityModelSelection?: ModelProviderSelection
	globalSkillsToggles: Readonly<Record<string, boolean>>
	allowedSkillNames?: readonly string[]
	localSkillsToggles: Readonly<Record<string, boolean>>

	// Multi-workspace support
	workspaceManager?: WorkspaceRootManager
	isMultiRootEnabled?: boolean

	// State management
	taskState: TaskState
	messageState: MessageStateHandler

	// Secret-free services
	services: TaskServices

	// Settings
	autoApprovalSettings: AutoApprovalSettings
	autoApprover: AutoApprove
	browserSettings: BrowserSettings
	/** Present only when Utility-model permission handling is fully configured. */
	permissionDecisionBinding?: PermissionDecisionServiceBinding

	// Callbacks (strongly typed)
	callbacks: TaskCallbacks

	// Tool coordination
	coordinator: ToolExecutorCoordinator
	taskMessenger: TaskMessenger
	context: IDiracContext
	/** The model tool call currently being executed, used for observable metadata. */
	toolUse?: { name: string; params: Record<string, unknown> }

	/** Snapshot active for the request that created this tool execution context. */
	activeToolSnapshot?: ToolRequestSnapshot
}

/**
 * All services available to tool handlers
 */
export interface TaskServices {
	browserSession: BrowserSession
	urlContentFetcher: UrlContentFetcher
	diffViewProvider: DiffViewProvider
	fileContextTracker: FileContextTracker
	diracIgnoreController: DiracIgnoreController
	commandPermissionController: CommandPermissionController
	contextManager: ContextManager
}



/**
 * All callback functions available to tool handlers
 */
export interface TaskCallbacks {
	/** Optional root-owned capability; absent for contained and Goal executions. */
	tasklets?: import("../interfaces/IToolEnvironment").TaskletControls
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
	clearActiveHookExecution: () => Promise<void>
	getActiveHookExecution: () => Promise<HookExecution | undefined>

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
