import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import type { TaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"
import type { Card, ICardHandle } from "@shared/ExtensionMessage"
import type { ResponseArguments } from "@shared/responseTool"
import type { PermissionOperation } from "../tools/interfaces/ICardHandle"

/** Data retained by the owner; presentation is not an authorization decision. */
export interface TaskInteractionRequest {
	card: Readonly<Card>
	permissionRequestKind?: "tool" | "manual_tool"
	permissionOperation?: PermissionOperation
	toolCall?: { name: string; arguments: Record<string, unknown> }
}

export interface TaskCounterparty {
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
	taskId: string
	api?: ApiHandler
	getCurrentProviderInfo: () => ApiProviderInfo
}
