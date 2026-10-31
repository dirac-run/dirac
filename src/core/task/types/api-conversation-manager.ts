import { DiracContent } from "@shared/messages/content"
import { SkillMetadata } from "@shared/skills"
import type { SlashCommandDirectAction } from "@core/slash-commands"
import type { LocalConversationCompactionSource } from "../LocalConversationCompaction"
import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { ContextManager } from "../../context/context-management/ContextManager"
import type { TaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { MessageStateHandler } from "../message-state"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskMessenger } from "../TaskMessenger"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"
import { HookExecution } from "./HookExecution"

import type { TaskStorageAddress } from "@core/storage/taskDirectory"

export interface ApiConversationManagerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	api: ApiHandler
	contextManager: ContextManager
	getWorkingConfiguration: () => TaskWorkingConfiguration
	getRequestRuntime: () => TaskRequestRuntime | undefined
	taskId: string
	storageAddress?: TaskStorageAddress
	ulid: string
	cwd: string
	taskMessenger: TaskMessenger
	postStateToWebview: () => Promise<void>
	diffViewProvider: DiffViewProvider
	activateSkill: (skillId: string) => Promise<void>
	toolExecutor: ToolExecutor
	streamHandler: StreamResponseHandler
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
	loadContext: (
		userContent: DiracContent[],
		includeFileDetails?: boolean,
		useCompactPrompt?: boolean,
	) => Promise<[DiracContent[], string, boolean, SkillMetadata[], boolean, string?, SlashCommandDirectAction[]?]>
	getCurrentProviderInfo: () => ApiProviderInfo
	getEnvironmentDetails: (includeFileDetails?: boolean) => Promise<string>
	runUserPromptSubmitHook: (
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>
	writePromptMetadataArtifacts: (params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}) => Promise<void>
	handleHookCancellation: (hookName: string, wasCancelled: boolean) => Promise<void>
	cancelTask: () => Promise<void>
	getPinnedContext?: () => string | undefined
	onContextCompacted?: () => void
	runLocalConversationCompaction: (source: LocalConversationCompactionSource) => Promise<string | undefined>
	setActiveHookExecution: (hookExecution: HookExecution | undefined) => Promise<void>
	clearActiveHookExecution: () => Promise<void>

	taskInitializationStartTime: number
}
