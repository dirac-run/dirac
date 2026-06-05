import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import { StateManager } from "../../storage/StateManager"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

export interface TaskMessengerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	postStateToWebview: () => Promise<void>
	stateManager: StateManager
	taskId: string
	api?: ApiHandler
	getCurrentProviderInfo: () => ApiProviderInfo
}
