import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { StateManager } from "../../storage/StateManager"
import { MessageStateHandler } from "../message-state"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskMessenger } from "../TaskMessenger"
import { AssistantStreamManager } from "../AssistantStreamManager"

import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"

export interface ResponseProcessorDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	api: ApiHandler
	stateManager: StateManager
	taskId: string
	ulid: string
	taskMessenger: TaskMessenger

	postStateToWebview: () => Promise<void>
	diffViewProvider: DiffViewProvider
	streamHandler: StreamResponseHandler
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
	getCurrentProviderInfo: () => ApiProviderInfo
	getApiRequestIdSafe: () => string | undefined
	toolExecutor: ToolExecutor
	assistantStreamManager: AssistantStreamManager
}
