import type { ApiHandler } from "@core/api"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import type { CommandPermissionController } from "@core/permissions"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions } from "@integrations/terminal"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { DiracAsk, DiracMessage, DiracSay, MultiCommandState } from "@shared/ExtensionMessage"
import type { DiracContent } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import type { DiracDefaultTool } from "@shared/tools"
import type { DiracAskResponse } from "@shared/WebviewMessage"
import { WorkspaceRootManager } from "@/core/workspace"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { StateManager } from "../../../storage/StateManager"
import type { MessageStateHandler } from "../../message-state"
import type { TaskState } from "../../TaskState"
import type { AutoApprove } from "../../tools/autoApprove"
import type { HookExecution } from "../../types/HookExecution"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
export interface TaskConfig {
	// Core identifiers
	taskId: string
	ulid: string
	cwd: string
	mode: Mode
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	doubleCheckCompletionEnabled: boolean
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	enableParallelToolCalling: boolean
	isSubagentExecution: boolean

	// Multi-workspace support (optional for backward compatibility)
	workspaceManager?: WorkspaceRootManager
	isMultiRootEnabled?: boolean

	// State management
	taskState: TaskState
	messageState: MessageStateHandler

	// API and services
	api: ApiHandler
	services: TaskServices

	// Settings
	autoApprovalSettings: AutoApprovalSettings
	autoApprover: AutoApprove
	browserSettings: BrowserSettings

	// Callbacks (strongly typed)
	callbacks: TaskCallbacks

	// Tool coordination
	coordinator: ToolExecutorCoordinator
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
	stateManager: StateManager
}

/**
 * All callback functions available to tool handlers
 */
export interface TaskCallbacks {
	say: (type: DiracSay, text?: string, images?: string[], files?: string[], partial?: boolean, multiCommandState?: MultiCommandState) => Promise<number | undefined>

	ask: (
		type: DiracAsk,
		text?: string,
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	) => Promise<{
		response: DiracAskResponse
		text?: string
		images?: string[]
		askTs?: number
		files?: string[]
		userEdits?: Record<string, string>
	}>

	saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>

	sayAndCreateMissingParamError: (toolName: DiracDefaultTool, paramName: string, relPath?: string) => Promise<any>

	removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: DiracAsk | DiracSay) => Promise<void>

	executeCommandTool: (
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	) => Promise<[boolean, any]>
	cancelRunningCommandTool?: () => Promise<boolean>

	doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>


	shouldAutoApproveTool: (toolName: DiracDefaultTool) => boolean | [boolean, boolean]
	shouldAutoApproveToolWithPath: (toolName: DiracDefaultTool, path?: string) => Promise<boolean>

	// Additional callbacks for task management
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	getDiracMessages: () => DiracMessage[]
	updateDiracMessage: (index: number, updates: Partial<DiracMessage>) => Promise<void>
	updateTaskHistory: (update: any) => Promise<any[]>

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
