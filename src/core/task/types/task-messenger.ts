import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import type { TaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"
import type { Card, ICardHandle } from "@shared/ExtensionMessage"
import type { ResponseArguments } from "@shared/responseTool"
import type { TaskInteractionRequest } from "./tasklet"
import type { HookExecution } from "./HookExecution"
import type { ResolvedHookModelContext } from "@core/hooks/hook-model-context"

export type { TaskInteractionRequest } from "./tasklet"

/** Originating invocation metadata; never resolves through the task's current request. */
export interface TaskMessengerInvocationContext {
	readonly executionId: string
	readonly signal: AbortSignal
	readonly hooksEnabled: boolean
	readonly hookModel: ResolvedHookModelContext
}

export interface TaskCounterparty {
	/** Display-only child communication snapshots; never routes interaction authority. */
	publishCommunicationCard?(card: Readonly<Card>): Promise<void>
	recordResponse(response: ResponseArguments): Promise<void>
	requestInteraction(request: TaskInteractionRequest, signal: AbortSignal): ReturnType<ICardHandle["waitForInteraction"]>
}

export interface TaskMessengerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	postStateToWebview: () => Promise<void>
	postPresentationToWebview?: () => Promise<void>
	counterparty?: TaskCounterparty
	getWorkingConfiguration: () => TaskWorkingConfiguration
	getRequestRuntime?: () => TaskRequestRuntime | undefined
	setActiveHookExecution: (execution: HookExecution) => Promise<void>
	clearActiveHookExecution: (runId: string) => Promise<void>
	taskId: string
	api?: ApiHandler
	getCurrentProviderInfo: () => ApiProviderInfo
}
