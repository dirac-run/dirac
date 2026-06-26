import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import pTimeout from "p-timeout"
import { Logger } from "@/shared/services/Logger"
import { MessageStateHandler } from "../../core/task/message-state"
import { TaskState } from "../../core/task/TaskState"

interface CheckpointStorageConfig {
	readonly enableCheckpoints: boolean
	readonly taskId: string
}
interface CheckpointStorageServices {
	readonly messageStateHandler: MessageStateHandler
	readonly taskState: TaskState
	readonly workspaceManager?: WorkspaceRootManager
}
interface CheckpointStorageCallbacks {
	readonly postStateToWebview: () => Promise<void>
}

/**
 * CheckpointStorageManager
 *
 * Manages the lifecycle of the CheckpointTracker instance and all disk-level
 * checkpoint operations (commit, workspace path resolution, tracker initialization).
 * Owns the tracker, error message, and init-promise state.
 */
export class CheckpointStorageManager {
	private readonly config: CheckpointStorageConfig
	private readonly services: CheckpointStorageServices
	private readonly callbacks: CheckpointStorageCallbacks

	private checkpointTracker?: CheckpointTracker
	private checkpointManagerErrorMessage?: string
	private checkpointTrackerInitPromise?: Promise<CheckpointTracker | undefined>

	constructor(config: CheckpointStorageConfig, services: CheckpointStorageServices, callbacks: CheckpointStorageCallbacks) {
		this.config = config
		this.services = services
		this.callbacks = callbacks
	}

	getTracker(): CheckpointTracker | undefined {
		return this.checkpointTracker
	}

	setTracker(tracker: CheckpointTracker | undefined): void {
		this.checkpointTracker = tracker
	}

	getErrorMessage(): string | undefined {
		return this.checkpointManagerErrorMessage
	}

	getInitPromise(): Promise<CheckpointTracker | undefined> | undefined {
		return this.checkpointTrackerInitPromise
	}

	setInitPromise(promise: Promise<CheckpointTracker | undefined> | undefined): void {
		this.checkpointTrackerInitPromise = promise
	}

	/**
	 * Checks for an active checkpoint tracker instance, creates if needed.
	 * Uses promise-based synchronization to prevent race conditions when called concurrently.
	 */
	async checkpointTrackerCheckAndInit(): Promise<CheckpointTracker | undefined> {
		if (this.checkpointTracker) return this.checkpointTracker
		if (this.checkpointTrackerInitPromise) return await this.checkpointTrackerInitPromise

		// Start initialization and store the promise to prevent concurrent attempts
		this.checkpointTrackerInitPromise = this.initializeCheckpointTracker()
		try {
			return await this.checkpointTrackerInitPromise
		} finally {
			this.checkpointTrackerInitPromise = undefined
		}
	}

	/**
	 * Internal method to actually create the checkpoint tracker
	 */
	private async initializeCheckpointTracker(): Promise<CheckpointTracker | undefined> {
		let checkpointsWarningTimer: NodeJS.Timeout | null = null
		let checkpointsWarningShown = false

		try {
			checkpointsWarningTimer = setTimeout(async () => {
				if (!checkpointsWarningShown) {
					checkpointsWarningShown = true
					await this.setCheckpointManagerErrorMessage(
						"Checkpoints are taking longer than expected to initialize. Working in a large repository? Consider re-opening Dirac in a project that uses git, or disabling checkpoints.",
					)
				}
			}, 7_000)

			const workspacePath = await this.getWorkspacePath()
			const tracker = await pTimeout(
				CheckpointTracker.create(this.config.taskId, this.config.enableCheckpoints, workspacePath),
				{
					milliseconds: 15_000,
					message:
						"Checkpoints taking too long to initialize. Consider re-opening Dirac in a project that uses git, or disabling checkpoints.",
				},
			)

			this.checkpointTracker = tracker
			return tracker
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error("Failed to initialize checkpoint tracker:", errorMessage)

			if (errorMessage.includes("Checkpoints taking too long to initialize")) {
				await this.setCheckpointManagerErrorMessage(
					"Checkpoints initialization timed out. Consider re-opening Dirac in a project that uses git, or disabling checkpoints.",
				)
			} else {
				await this.setCheckpointManagerErrorMessage(errorMessage)
			}
			return undefined
		} finally {
			if (checkpointsWarningTimer) {
				clearTimeout(checkpointsWarningTimer)
				checkpointsWarningTimer = null
			}
		}
	}

	/**
	 * Updates the checkpoint tracker error message and posts to webview
	 */
	async setCheckpointManagerErrorMessage(errorMessage: string | undefined): Promise<void> {
		this.checkpointManagerErrorMessage = errorMessage
		this.services.taskState.checkpointManagerErrorMessage = errorMessage
		try {
			await this.callbacks.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to post state to webview after checkpoint error:", error)
		}
	}

	/**
	 * Creates a checkpoint commit in the underlying tracker
	 * @returns The created commit hash, or undefined if failed
	 */
	async commit(): Promise<string | undefined> {
		try {
			if (!this.config.enableCheckpoints) return undefined
			if (!this.checkpointTracker) await this.checkpointTrackerCheckAndInit()
			if (!this.checkpointTracker) {
				Logger.error(
					`[CheckpointStorageManager] Checkpoint tracker not available for commit in task ${this.config.taskId}`,
				)
				return undefined
			}
			return await this.checkpointTracker.commit()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(
				`[CheckpointStorageManager] Failed to create checkpoint commit for task ${this.config.taskId}:`,
				errorMessage,
			)
			return undefined
		}
	}

	/**
	 * Gets the workspace path from WorkspaceRootManager when available, otherwise falls back to CheckpointUtils
	 */
	async getWorkspacePath(): Promise<string> {
		if (this.services.workspaceManager) {
			try {
				const primaryRoot = this.services.workspaceManager.getPrimaryRoot()
				if (primaryRoot) return primaryRoot.path
				Logger.warn(
					`[CheckpointStorageManager] WorkspaceRootManager returned no primary root for task ${this.config.taskId}`,
				)
			} catch (error) {
				Logger.warn(
					`[CheckpointStorageManager] Failed to get workspace path from WorkspaceRootManager for task ${this.config.taskId}:`,
					error,
				)
			}
		}
		// Fallback to the legacy CheckpointUtils implementation
		const { getWorkingDirectory: getWorkingDirectoryImpl } = await import("./CheckpointUtils")
		return getWorkingDirectoryImpl()
	}

	/**
	 * Ensures the tracker is initialized, creating it inline if needed (used by restore/diff paths)
	 */
	async ensureTrackerInitialized(): Promise<CheckpointTracker | undefined> {
		if (!this.checkpointTracker && !this.checkpointManagerErrorMessage) {
			try {
				const workspacePath = await this.getWorkspacePath()
				this.checkpointTracker = await CheckpointTracker.create(
					this.config.taskId,
					this.config.enableCheckpoints,
					workspacePath,
				)
				this.services.messageStateHandler.setCheckpointTracker(this.checkpointTracker)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				Logger.error(
					`[CheckpointStorageManager] Failed to initialize checkpoint tracker for task ${this.config.taskId}:`,
					errorMessage,
				)
				this.checkpointManagerErrorMessage = errorMessage
				return undefined
			}
		}
		return this.checkpointTracker
	}
}
