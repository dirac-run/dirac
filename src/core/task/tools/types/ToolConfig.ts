import type { ApiHandlerModel } from "@core/api/types"
import type { ApiConversationProviderState } from "@core/api/conversation"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { ModelProviderSelection } from "@shared/api"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type { TaskStorageAddress } from "@shared/taskletId"
import type { DiracToolSpec } from "@shared/tools"
import type { TaskState } from "../../TaskState"
import type { TaskExecutionProfile } from "../../TaskExecutionProfileTypes"
import type { DeepReadonly } from "../../runtime/TaskWorkingConfiguration"
import type { IDiracContext } from "../interfaces/IDiracContext"
import type { ToolAutoApproval, ToolPermissionRules, ToolPermissionDisposition } from "./ToolPermissionCapabilities"

/** Public tool configuration. Adapter-only services and orchestration stay in TaskConfig. */
export interface ToolConfig {
	executionProfile: TaskExecutionProfile
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
	localSkillsToggles: Readonly<Record<string, boolean>>
	workspaceManager?: WorkspaceRootManager
	isMultiRootEnabled?: boolean
	taskState: TaskState
	messageState: ToolConversationState
	services: ToolServices
	autoApprovalSettings: AutoApprovalSettings
	autoApprover: ToolAutoApproval
	browserSettings: BrowserSettings
	/** Presence selects permission-service handling; the service itself is adapter-private. */
	permissionDecisionBinding?: { readonly configurationRevision: number }
	callbacks: ToolCallbacks
	context: IDiracContext
	toolUse?: { name: string; params: Record<string, unknown> }
}

/** Conversation operations required by explicit compaction, not the persistence implementation. */
export interface ToolConversationState {
	getApiConversationProviderState(): ApiConversationProviderState
	overwriteApiConversationProviderState(state: ApiConversationProviderState): Promise<void>
	saveDiracMessagesAndUpdateHistory(): Promise<void>
	getDiracMessages(): DiracMessage[]
}

export interface ToolServices {
	diracIgnoreController: { validateAccess(path: string): boolean }
	commandPermissionController: ToolPermissionRules
	contextManager: {
		getContextTelemetryData(messages: DiracMessage[], contextWindow: number, triggerIndex?: number): {
			tokensUsed: number
			maxContextWindow: number
		} | null
	}
}

/** Task-owned operations exposed to tools; implementations remain in the adapter configuration. */
export interface ToolCallbacks {
	assertMutationAuthorized(toolName?: DiracToolSpec["id"]): void
	withMutationAuthorization<T>(toolName: DiracToolSpec["id"] | undefined, mutation: () => Promise<T>): Promise<T>
	transitionFromMutation<T>(transition: () => Promise<T>): Promise<T>
	commitEnabledToolToggles(toolIds: readonly string[], finalize?: () => Promise<void>): Promise<void>
	shouldAutoApproveToolWithPath(toolName: DiracToolSpec["id"], path?: string): Promise<boolean>
	resolveToolPathPermission(toolName: DiracToolSpec["id"], path?: string): Promise<ToolPermissionDisposition>
}
