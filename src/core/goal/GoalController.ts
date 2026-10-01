import type { Controller } from "@core/controller"
import { getSavedPresentationHistory } from "@core/storage/disk"
import type { StateManager } from "@core/storage/StateManager"
import type { Task } from "@core/task"
import type { PresentationSnapshot } from "@core/task/message-state"
import { TaskStatus } from "@shared/ExtensionMessage"
import type { GoalViewState } from "@shared/goal"
import { isActiveGoalStatus } from "@shared/goal"
import { type GoalHistoryItem, type HistoryItem, isGoalHistoryItem } from "@shared/HistoryItem"
import { getCwd, getDesktopDir } from "@utils/path"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { Logger } from "@/shared/services/Logger"
import { createGoalHistoryItem } from "./GoalHistory"
import { GoalLoop } from "./GoalLoop"
import { GoalStore } from "./GoalStore"
import { GoalTaskFactory } from "./GoalTaskFactory"

const goalActivationMutex = new Mutex()

export interface GoalControllerDependencies {
	controller: Controller
	stateManager: StateManager
	getStandaloneTask: () => Task | undefined
	clearStandaloneTask: () => Promise<void>
	updateGoalHistory: (item: GoalHistoryItem) => Promise<HistoryItem[]>
	postState: () => Promise<void>
}

/** Owns selected-Goal presentation and enforces the single active Goal invariant. */
export class GoalController {
	private readonly store = new GoalStore()
	private readonly ready: Promise<void>
	private selectedLoop?: GoalLoop

	constructor(private readonly dependencies: GoalControllerDependencies) {
		this.ready = this.reconcilePersistedGoals()
	}

	get selectedGoalId(): string | undefined {
		return this.selectedLoop?.goalId
	}

	get active(): boolean {
		return this.selectedLoop?.isActive === true
	}

	get hasRunningCoordinator(): boolean {
		return this.selectedLoop?.hasRunningCoordinator === true
	}

	get coordinator(): Task | undefined {
		return this.selectedLoop?.coordinator
	}

	async waitForStartupReconciliation(): Promise<void> {
		await this.ready
	}

	async start(objectiveMarkdown: string): Promise<string> {
		return goalActivationMutex.withLock(() => this.startSerial(objectiveMarkdown))
	}

	private async startSerial(objectiveMarkdown: string): Promise<string> {
		await this.ready
		const objective = objectiveMarkdown.trim()
		if (!objective) throw new Error("/goal requires a non-empty objective")
		await this.assertNoActiveGoal()
		this.assertNoActiveStandaloneTask()
		await this.dependencies.clearStandaloneTask()

		const goalId = Date.now().toString()
		await this.store.create(goalId, ulid(), objective)
		let loop: GoalLoop
		try {
			loop = await this.createLoop(goalId, objective)
			await loop.publishHistory()
		} catch (error) {
			await this.store.delete(goalId)
			throw error
		}

		this.selectedLoop = loop
		await loop.start()
		return goalId
	}

	async select(goalId: string): Promise<GoalViewState> {
		return goalActivationMutex.withLock(() => this.selectSerial(goalId))
	}

	private async selectSerial(goalId: string): Promise<GoalViewState> {
		await this.ready
		if (this.selectedLoop?.hasRunningCoordinator) {
			await this.selectedLoop.cancelCurrentExecution("Interrupted after selecting another run")
		}
		await this.dependencies.clearStandaloneTask()
		const historyItem = this.goalHistoryItem(goalId)
		await this.store.read(goalId)
		this.selectedLoop = await this.createLoop(goalId, historyItem.initialDisplayText)
		await this.dependencies.postState()
		return this.selectedLoop.inspect()
	}

	async resume(goalId: string): Promise<GoalViewState> {
		return goalActivationMutex.withLock(() => this.resumeSerial(goalId))
	}

	private async resumeSerial(goalId: string): Promise<GoalViewState> {
		await this.ready
		if (this.selectedLoop?.goalId === goalId && this.selectedLoop.isActive) return this.selectedLoop.inspect()
		if (this.selectedLoop?.hasRunningCoordinator) {
			throw new Error(`Finish or cancel the current Goal conversation before resuming Goal ${goalId}`)
		}
		await this.assertNoActiveGoal()
		this.assertNoActiveStandaloneTask()
		await this.dependencies.clearStandaloneTask()
		const historyItem = this.goalHistoryItem(goalId)
		const record = await this.store.read(goalId)
		const loop = await this.createLoop(goalId, historyItem.initialDisplayText)
		this.selectedLoop = loop
		if (record.status === "paused" && record.statusReason === "Created") await loop.start()
		else await loop.resume()
		return loop.inspect()
	}

	async steer(goalId: string, message: string): Promise<void> {
		await this.ready
		this.requireSelectedLoop(goalId)
		await this.selectedLoop!.steer(message)
	}

	async sendMessage(goalId: string, message: string): Promise<void> {
		await this.ready
		this.requireSelectedLoop(goalId)
		await this.selectedLoop!.sendMessage(message)
	}

	async cancelCurrentExecution(reason?: string): Promise<void> {
		await this.ready
		if (!this.selectedLoop) return
		await this.selectedLoop.cancelCurrentExecution(reason)
	}

	async pause(goalId: string, reason?: string): Promise<GoalViewState> {
		return goalActivationMutex.withLock(() => this.pauseSerial(goalId, reason))
	}

	private async pauseSerial(goalId: string, reason?: string): Promise<GoalViewState> {
		await this.ready
		this.requireSelectedLoop(goalId)
		await this.selectedLoop!.pause(reason)
		return this.selectedLoop!.inspect()
	}

	async stop(goalId: string, reason?: string): Promise<GoalViewState> {
		return goalActivationMutex.withLock(() => this.stopSerial(goalId, reason))
	}

	private async stopSerial(goalId: string, reason?: string): Promise<GoalViewState> {
		await this.ready
		if (this.selectedLoop?.hasRunningCoordinator && this.selectedLoop.goalId !== goalId) {
			throw new Error(`Goal control for ${goalId} is stale; running Goal conversation is ${this.selectedLoop.goalId}`)
		}
		if (this.selectedLoop?.goalId !== goalId) {
			const historyItem = this.goalHistoryItem(goalId)
			this.selectedLoop = await this.createLoop(goalId, historyItem.initialDisplayText)
		}
		await this.selectedLoop.stop(reason)
		return this.selectedLoop.inspect()
	}

	async inspect(goalId = this.selectedGoalId): Promise<GoalViewState | undefined> {
		await this.ready
		if (!goalId) return undefined
		if (this.selectedLoop?.goalId === goalId) return this.selectedLoop.inspect()
		const historyItem = this.goalHistoryItem(goalId)
		return (await this.createLoop(goalId, historyItem.initialDisplayText)).inspect()
	}

	async selectedPresentationSnapshot(): Promise<PresentationSnapshot> {
		await this.ready
		if (!this.selectedLoop) return { messages: [], offset: -1, generation: 0 }
		const coordinator = this.selectedLoop.coordinator
		if (coordinator) return coordinator.messageStateHandler.capturePresentationSnapshot()
		const saved = await getSavedPresentationHistory(this.selectedLoop.goalId)
		return {
			messages: saved.messages,
			offset: saved.lastOffset,
			generation: 0,
		}
	}

	async pauseAndDeselect(reason: string): Promise<void> {
		return goalActivationMutex.withLock(() => this.pauseAndDeselectSerial(reason))
	}

	private async pauseAndDeselectSerial(reason: string): Promise<void> {
		await this.ready
		if (this.selectedLoop?.hasRunningCoordinator) await this.selectedLoop.cancelCurrentExecution(reason)
		this.selectedLoop = undefined
		await this.dependencies.postState()
	}

	async dispose(): Promise<void> {
		await this.pauseAndDeselect("Paused because the owning surface closed")
	}

	private async reconcilePersistedGoals(): Promise<void> {
		try {
			const report = await this.store.reconcileOnStartup()
			for (const failure of report.failures) {
				Logger.error(`[GoalController] Failed to reconcile persisted Goal ${failure.goalId}:`, failure.error)
			}
			for (const record of report.records) {
				await this.reconcilePersistedGoalHistory(record)
			}
		} catch (error) {
			Logger.error("[GoalController] Failed to scan persisted Goals during startup:", error)
		}
	}

	private async reconcilePersistedGoalHistory(record: import("@shared/goal").GoalRecord): Promise<void> {
		try {
			const historyItem = this.dependencies.stateManager
				.getGlobalStateKey("taskHistory")
				.find((item) => item.id === record.id)
			if (!historyItem) {
				Logger.warn(
					`[GoalController] Goal ${record.id} is missing its top-level history entry; preserving loaded history`,
				)
				return
			}
			if (!isGoalHistoryItem(historyItem)) {
				Logger.warn(
					`[GoalController] Run ${record.id} is a Task in history but a Goal on disk; preserving loaded history`,
				)
				return
			}
			await this.dependencies.updateGoalHistory(
				createGoalHistoryItem(record, historyItem.initialDisplayText, historyItem.workspaceRootPath),
			)
		} catch (error) {
			Logger.error(`[GoalController] Failed to refresh Goal history ${record.id}:`, error)
		}
	}

	private async createLoop(goalId: string, initialDisplayText: string): Promise<GoalLoop> {
		const record = await this.store.read(goalId)
		const workspaceManager = await this.dependencies.controller.ensureWorkspaceManager()
		if (!workspaceManager) throw new Error("A Goal requires an initialized workspace manager")
		const cwd = workspaceManager.getPrimaryRoot()?.path ?? (await getCwd(getDesktopDir()))
		return new GoalLoop({
			goalId: record.id,
			initialDisplayText,
			store: this.store,
			// Capture settings when execution starts, not when an inactive Goal is selected.
			// Children in this run share that snapshot; a later run captures a new one.
			createTaskFactory: () => new GoalTaskFactory({
				controller: this.dependencies.controller,
				stateManager: this.dependencies.stateManager,
				workspaceManager,
				cwd,
				workingConfiguration: this.dependencies.stateManager.captureEffectiveTaskConfiguration({ mode: "act" }),
				postCoordinatorState: this.dependencies.postState,
			}),
			stateManager: this.dependencies.stateManager,
			updateHistory: (item) => {
				if (!isGoalHistoryItem(item)) throw new Error(`Goal ${goalId} produced a Task history item`)
				return this.dependencies.updateGoalHistory(item)
			},
			postState: this.dependencies.postState,
			workspaceRootPath: workspaceManager.getPrimaryRoot()?.path,
		})
	}

	private async assertNoActiveGoal(): Promise<void> {
		if (this.selectedLoop?.hasRunningCoordinator) {
			throw new Error(`Goal ${this.selectedLoop.goalId} already has a running coordinator`)
		}
		const active = (await this.store.list()).find((record) => isActiveGoalStatus(record.status))
		if (active) throw new Error(`Goal ${active.id} is already active`)
	}

	private assertNoActiveStandaloneTask(): void {
		const task = this.dependencies.getStandaloneTask()
		if (!task) return
		if ([TaskStatus.IDLE, TaskStatus.COMPLETED, TaskStatus.CANCELLED].includes(task.taskState.status)) return
		throw new Error(`Task ${task.taskId} is active; leave or cancel it before starting a Goal`)
	}

	private requireSelectedLoop(goalId: string): void {
		if (this.selectedLoop?.goalId !== goalId) {
			throw new Error(`Goal control for ${goalId} is stale; selected Goal is ${this.selectedGoalId ?? "none"}`)
		}
	}

	private goalHistoryItem(goalId: string): GoalHistoryItem {
		const item = this.dependencies.stateManager.getGlobalStateKey("taskHistory").find((candidate) => candidate.id === goalId)
		if (!item || !isGoalHistoryItem(item)) throw new Error(`Run ${goalId} is not a Goal`)
		return item
	}
}
