import type { StateManager } from "@core/storage/StateManager"
import { Task } from "@core/task"
import { projectUIActionState } from "@core/task/utils/ui-projector"
import { detectWorkspaceRoots } from "@core/workspace/detection"
import { setupWorkspaceManager } from "@core/workspace/setup"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { type ExtensionState, TaskStatus } from "@shared/ExtensionMessage"
import { assembleAuthState } from "./assembleAuthState"
import { assembleModelState } from "./assembleModelState"
import { assembleRuntimeState } from "./assembleRuntimeState"
import { assembleToolState } from "./assembleToolState"
import { discoverAvailableSkills } from "./discoverAvailableSkills"
import { processTaskHistory } from "./processTaskHistory"

export async function getStateToPostToWebview(deps: {
	stateManager: StateManager
	task?: Task | undefined
	workspaceManager?: WorkspaceRootManager | undefined
	backgroundCommandRunning: boolean
	backgroundCommandTaskId?: string | undefined
}): Promise<ExtensionState> {
	const { stateManager, task, workspaceManager, backgroundCommandRunning, backgroundCommandTaskId } = deps

	const resolvedWorkspaceManager =
		workspaceManager ?? (await setupWorkspaceManager({ stateManager, detectRoots: detectWorkspaceRoots }))
	const primaryRootPath = resolvedWorkspaceManager?.getPrimaryRoot()?.path
	const cwd = task?.cwd || primaryRootPath || process.cwd()

	const modelState = assembleModelState(stateManager)
	const authState = await assembleAuthState(stateManager)
	const { latestAnnouncementId, ...runtimeState } = await assembleRuntimeState()
	const toolState = await assembleToolState(stateManager, primaryRootPath)
	const availableSkills = await discoverAvailableSkills(stateManager, cwd, task?.taskState || {})

	const taskHistory = stateManager.getGlobalStateKey("taskHistory")
	const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
	const maxConsecutiveMistakes = stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
	const diracMessages = [...(task?.messageStateHandler.getDiracMessages() || [])]
	const currentTaskItem = task?.taskId ? (taskHistory || []).find((item) => item.id === task.taskId) : undefined

	return {
		...modelState,
		...authState,
		...runtimeState,
		...toolState,
		availableSkills,
		currentTaskItem,
		diracMessages,
		checkpointManagerErrorMessage: task?.taskState?.checkpointManagerErrorMessage,
		taskHistory: processTaskHistory(taskHistory, primaryRootPath),
		shouldShowAnnouncement: lastShownAnnouncementId !== latestAnnouncementId,
		backgroundCommandRunning,
		backgroundCommandTaskId,
		workspaceRoots: resolvedWorkspaceManager?.getRoots() ?? [],
		primaryRootIndex: resolvedWorkspaceManager?.getPrimaryIndex() ?? 0,
		isMultiRootWorkspace: (resolvedWorkspaceManager?.getRoots().length ?? 0) > 1,
		activeVoiceStreamId: task?.taskState.activeVoiceStreamId,
		taskStatus: task?.taskState.status || TaskStatus.IDLE,
		isApiRequestActive: task?.taskState.isApiRequestActive || false,
		uiActionState: projectUIActionState(task?.taskState, diracMessages, maxConsecutiveMistakes),
	}
}
