import type { DiracExtensionContext } from "@/shared/dirac"
import { StateManager, type PersistenceErrorEvent } from "../storage/StateManager"
import type { StateManager as StateManagerType } from "../storage/StateManager"
import { TaskHistoryController } from "./TaskHistoryController"
import { AuthController } from "./auth/AuthController"
import { WorkspaceController } from "./workspace/WorkspaceController"
import { TaskController } from "./task/TaskController"
import { StateController } from "./state/StateController"
import type { Controller } from "."
import { buildApiHandler } from "@core/api"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { PromptRegistry } from "../prompts/system-prompt"

/**
 * Configuration object returned by Initializer for Controller to use in its constructor.
 */
export interface InitializerConfig {
	stateManager: StateManagerType
	taskHistoryController: TaskHistoryController
	authController: AuthController
	workspaceController: WorkspaceController
	taskController: TaskController
	stateController: StateController
}

/**
 * Handles all constructor initialization logic for Controller.
 * Extracts ~80 lines of setup code from Controller/index.ts constructor.
 */
export class Initializer {
	constructor(private readonly context: DiracExtensionContext) {}

	/**
	 * Creates initialization configuration for Controller.
	 * Returns a config object that Controller can use to set its private properties.
	 */
	createConfig(
		controller: Pick<Controller, "task" | "postStateToWebview" | "toggleActModeForYoloMode" | "cancelTask">,
	): InitializerConfig {
		Session.reset() // Reset session on controller initialization
		PromptRegistry.getInstance() // Ensure prompts and tools are registered

		const stateManager = StateManager.get()
		const taskHistoryController = new TaskHistoryController(stateManager)

		const authController = new AuthController({
			stateManager,
			postStateToWebview: () => controller.postStateToWebview(),
			get task() {
				return controller.task
			},
		})
		const workspaceController = new WorkspaceController(stateManager)

		const taskController = new TaskController(
			{
				task: controller.task,
				controller: controller as unknown as Controller,
				stateManager,
				workspaceManager: undefined, // Will be set later by Controller
				backgroundCommandRunning: false,
				cancelInProgress: false,
				postStateToWebview: () => controller.postStateToWebview(),
				updateTaskHistory: (item: any) => taskHistoryController.updateTaskHistory(item),
				deleteTaskFromState: (id: string) => taskHistoryController.deleteTaskFromState(id),
				getTaskWithId: (id: string) => taskHistoryController.getTaskWithId(id),
				clearTaskSettings: () => stateManager.clearTaskSettings(),
				toggleActModeForYoloMode: () => controller.toggleActModeForYoloMode(),
			},
			undefined, // tryAcquireTaskLockWithRetry - use default
			undefined, // setupWorkspaceManager - use default
			undefined, // detectRoots - use default
			undefined, // getCwd - use default
			undefined, // getDesktopDir - use default
			undefined, // cleanupLegacyCheckpoints - use default
			async () => false, // Background command cancellation not available during initialization
		)

		const stateController = new StateController({
			stateManager,
			get task() {
				return controller.task
			},
			buildApiHandlerFn: buildApiHandler,
			postStateToWebviewFn: () => controller.postStateToWebview(),
			cancelTaskFn: () => controller.cancelTask(),
		})

		stateManager.registerCallbacks({
			onPersistenceError: async ({ error }: PersistenceErrorEvent) => {
				// Just log - don't call reInitialize() (that sets isInitialized=false which
				// breaks running tasks) and don't show a warning (data is safe in memory
				// and will be retried automatically on the next debounced persistence).
				Logger.error("[Controller] Storage persistence failed (will retry):", error)
			},
			onSyncExternalChange: async () => {
				await controller.postStateToWebview()
			},
		})

		Logger.log("[Controller] DiracProvider instantiated")

		return {
			stateManager,
			taskHistoryController,
			authController,
			workspaceController,
			taskController,
			stateController,
		}
	}
}
