import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import type { TaskState } from "@core/task/TaskState"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
// lazy import to break circular dependency: task/index → factory → checkpoints/index → task/message-state
import { MultiRootCheckpointManager } from "./MultiRootCheckpointManager"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"

/**
 * Simple predicate abstracting our multi-root decision.
 */
export function shouldUseMultiRoot({
	workspaceManager,
	enableCheckpoints,
	multiRootEnabled,
}: {
	workspaceManager?: WorkspaceRootManager
	enableCheckpoints: boolean
	multiRootEnabled: boolean
}): boolean {
	return Boolean(multiRootEnabled && enableCheckpoints && workspaceManager && workspaceManager.getRoots().length > 1)
}

type BuildArgs = {
	// common
	taskId: string
	messageStateHandler: MessageStateHandler
	// single-root deps
	fileContextTracker: FileContextTracker
	diffViewProvider: DiffViewProvider
	taskState: TaskState
	// multi-root deps
	workspaceManager?: WorkspaceRootManager

	// callbacks for single-root TaskCheckpointManager
	updateTaskHistory: (historyItem: any) => Promise<any[]>
	taskMessenger: import("../../core/task/TaskMessenger").TaskMessenger
	cancelTask: () => Promise<void>
	postStateToWebview: () => Promise<void>
	resetTransientState: () => Promise<void>

	// initial state for single-root
	initialConversationHistoryDeletedRange?: [number, number]
	initialCheckpointManagerErrorMessage?: string

	enableCheckpoints: boolean
	multiRootEnabled: boolean
}

/**
 * Central factory for creating the appropriate checkpoint manager.
 * - MultiRootCheckpointManager for multi-root tasks
 * - TaskCheckpointManager for single-root tasks
 */
export function buildCheckpointManager(args: BuildArgs): ICheckpointManager {
	const {
		taskId,
		messageStateHandler,
		fileContextTracker,
		diffViewProvider,
		taskState,
		workspaceManager,
		updateTaskHistory,
		taskMessenger,
		cancelTask,
		postStateToWebview,
		resetTransientState,
		initialConversationHistoryDeletedRange,
		initialCheckpointManagerErrorMessage,
		enableCheckpoints,
		multiRootEnabled,
	} = args

	if (shouldUseMultiRoot({ workspaceManager, enableCheckpoints, multiRootEnabled })) {
		// Multi-root manager (init should be kicked off externally, non-blocking)
		return new MultiRootCheckpointManager(workspaceManager!, taskId, enableCheckpoints, messageStateHandler)
	}

	// Single-root manager
	// TODO: Restructure module boundaries to eliminate the circular dependency and use a static import
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { createTaskCheckpointManager } = require("./index")
	return createTaskCheckpointManager(
		{ taskId },
		{ enableCheckpoints },
		{
			diffViewProvider,
			messageStateHandler,
			fileContextTracker,
			taskState,
			workspaceManager,
		},
		{
			updateTaskHistory,
			taskMessenger,
			cancelTask,
			postStateToWebview,
			resetTransientState,
		},
		{
			conversationHistoryDeletedRange: initialConversationHistoryDeletedRange,
			checkpointManagerErrorMessage: initialCheckpointManagerErrorMessage,
		},
	)
}
