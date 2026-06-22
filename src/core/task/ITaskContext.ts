/**
 * Task context interface — breaks circular dependency between Task and Controller.
 *
 * Task only needs these callbacks from its environment, not the full Controller.
 */
export interface ITaskContext {
	/**
	 * Update the background command state for a task.
	 */
	updateBackgroundCommandState: (isRunning: boolean, taskId: string) => void

	/**
	 * Toggle act mode for YOLO mode.
	 */
	toggleActModeForYoloMode: () => Promise<boolean>

	/**
	 * Post current state to the webview UI.
	 */
	postStateToWebview: () => Promise<void>
}
