/**
 * The surface Task needs from its embedding host (extension Controller,
 * standalone controller, or a test double).
 * Declared in the task layer so `src/core/task` never imports
 * `src/core/controller` — the host implements this, the dependency
 * points inward (TECH-DEBT-PLAN item 1).
 */
export interface ITaskHost {
	toggleActModeForYoloMode(): Promise<boolean>
	updateBackgroundCommandState(running: boolean, taskId?: string): void
}
