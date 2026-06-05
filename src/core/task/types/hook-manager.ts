import { ApiHandler } from "../../../core/api"
import { StateManager } from "../../storage/StateManager"
import { MessageStateHandler } from "../message-state"
import { TaskMessenger } from "../TaskMessenger"
import { TaskState } from "../TaskState"

export interface HookManagerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	stateManager: StateManager
	api?: ApiHandler
	shouldRunBackgroundCheck: () => boolean
	taskId: string
	ulid?: string
	taskMessenger: TaskMessenger
	postStateToWebview: () => Promise<void>
	cancelTask: () => Promise<void>
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
}

export type UserPromptHookResult = {
	cancel?: boolean
	wasCancelled?: boolean
	contextModification?: string
	errorMessage?: string
}
