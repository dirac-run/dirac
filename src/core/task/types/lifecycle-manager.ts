import { DiracContent } from "@shared/messages/content"
import { CommandPermissionController } from "../../permissions/CommandPermissionController"
import { ApiHandler } from "../../../core/api"
import { ICheckpointManager } from "../../../integrations/checkpoints/types"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { CommandExecutor } from "../../../integrations/terminal"
import { ITerminalManager } from "../../../integrations/terminal/types"
import { BrowserSession } from "../../../services/browser/BrowserSession"
import { UrlContentFetcher } from "../../../services/browser/UrlContentFetcher"
import { ContextManager } from "../../context/context-management/ContextManager"
import { FileContextTracker } from "../../context/context-tracking/FileContextTracker"
import { DiracIgnoreController } from "../../ignore/DiracIgnoreController"
import { StateManager } from "../../storage/StateManager"
import { HookManager } from "../HookManager"
import { MessageStateHandler } from "../message-state"
import { TaskMessenger } from "../TaskMessenger"
import { TaskState } from "../TaskState"

export interface LifecycleManagerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	stateManager: StateManager
	api: ApiHandler
	taskId: string
	ulid: string
	say: TaskMessenger["say"]
	ask: TaskMessenger["ask"]
	postStateToWebview: () => Promise<void>
	cancelTask: () => Promise<void>
	checkpointManager?: ICheckpointManager
	diracIgnoreController: DiracIgnoreController
	terminalManager: ITerminalManager
	urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	diffViewProvider: DiffViewProvider
	fileContextTracker: FileContextTracker
	contextManager: ContextManager
	commandExecutor: CommandExecutor
	commandPermissionController: CommandPermissionController
	cwd: string
	hookManager: HookManager
	initiateTaskLoop: (userContent: DiracContent[]) => Promise<void>
	recordEnvironment: () => Promise<void>
}
