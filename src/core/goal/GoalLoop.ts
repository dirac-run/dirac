import type { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import type { Task } from "@core/task"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import { serializeTaskError, type TaskRunOutcome } from "@core/task/TaskRunOutcome"
import { SurfaceAdapter } from "@core/task/tools/adapters/SurfaceAdapter"
import type { CompletionCommitResult, IGoalTrait } from "@core/task/tools/interfaces/IToolEnvironment"
import { combineCardSequences } from "@shared/combineCardSequences"
import { getApiUsageKnowledge, getApiMetrics } from "@shared/getApiMetrics"
import type { GoalAccounting, GoalRecord, GoalViewState } from "@shared/goal"
import { GOAL_MODE_SWITCHING_EXPLANATION, isActiveGoalStatus, isResumableGoalStatus } from "@shared/goal"
import { type GoalHistoryItem, type HistoryItem, isGoalHistoryItem } from "@shared/HistoryItem"
import { Logger } from "@shared/services/Logger"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { replaceGoalAccountingSource } from "./GoalAccounting"
import { GoalCoordinatorToolEnvironmentFactory } from "./GoalCoordinatorEnvironment"
import { createGoalHistoryItem } from "./GoalHistory"
import { goalActiveDurationAt, goalWallDurationAt } from "./GoalLifecycle"
import { GoalStore } from "./GoalStore"
import { GoalTaskFactory } from "./GoalTaskFactory"

type RequestedEnd = "paused" | "blocked" | "stopped" | "achieved"
type GoalRuntimeKind = "goal" | "followup"

interface LiveGoalRuntime {
	kind: GoalRuntimeKind
	coordinator: Task
	run: Promise<TaskRunOutcome>
	settlement?: Promise<void>
	settling?: boolean
}

export interface GoalLoopDependencies {
	goalId: string
	initialDisplayText: string
	store: GoalStore
	createTaskFactory: () => GoalTaskFactory
	stateManager: StateManager
	updateHistory: (item: HistoryItem) => Promise<HistoryItem[]>
	postState: () => Promise<void>
	workspaceRootPath?: string
}

/** Owns one coordinator Task and all lifecycle transitions for one durable Goal. */
export class GoalLoop {
	private readonly lifecycleMutex = new Mutex()
	private readonly interactionMutex = new Mutex()
	private runtime?: LiveGoalRuntime
	private requestedEnd?: { status: RequestedEnd; reason?: string }
	private followUpEndReason?: string
	private coordinatorInteractionCount = 0

	constructor(private readonly dependencies: GoalLoopDependencies) { }

	get goalId(): string {
		return this.dependencies.goalId
	}

	get coordinator(): Task | undefined {
		return this.runtime?.coordinator
	}

	get isActive(): boolean {
		return this.runtime?.kind === "goal"
	}

	get hasRunningCoordinator(): boolean {
		return this.runtime !== undefined
	}

	get isFollowUpActive(): boolean {
		return this.runtime?.kind === "followup"
	}

	async start(beforeStart?: () => Promise<void>): Promise<void> {
		await this.activate(false, beforeStart)
	}

	async resume(beforeStart?: () => Promise<void>): Promise<void> {
		await this.activate(true, beforeStart)
	}

	async sendMessage(message: string): Promise<void> {
		const text = message.trim()
		if (!text) throw new Error("A Goal message cannot be empty")
		let running: LiveGoalRuntime | undefined
		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime) {
				running = this.runtime
				return
			}
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(this.goalId))
			try {
				const record = await this.dependencies.store.recoverInterruptedExecution(this.goalId)
				this.requestedEnd = undefined
				this.followUpEndReason = undefined
				const runtime = await this.constructRuntime(record, "followup", false, text)
				this.startRuntimeSettlement(runtime, releaseOwnership)
			} catch (error) {
				await releaseOwnership()
				throw error
			}
		})
		if (running) {
			await this.enqueueMessage(running, text)
			return
		}
		await this.dependencies.postState()
	}

	async steer(message: string): Promise<void> {
		const text = message.trim()
		if (!text) throw new Error("Goal steering cannot be empty")
		const record = await this.dependencies.store.read(this.goalId)
		if (!isActiveGoalStatus(record.status) || this.runtime?.kind !== "goal") {
			throw new Error(`Goal ${this.goalId} is ${record.status} and cannot accept steering`)
		}
		await this.enqueueMessage(this.runtime, text)
	}

	async cancelCurrentExecution(reason = "Cancelled by user"): Promise<void> {
		if (this.runtime?.kind === "goal") {
			await this.pause(reason)
			return
		}
		await this.cancelFollowUp(reason)
	}

	async pause(reason = "Paused by user"): Promise<GoalRecord> {
		return this.endActiveRun("paused", "interrupted", reason)
	}

	async stop(reason = "Stopped by user"): Promise<GoalRecord> {
		if (this.runtime?.kind === "goal") return this.endActiveRun("stopped", "cancelled", reason)
		if (this.runtime) await this.cancelFollowUp(reason)
		return this.lifecycleMutex.withLock(async () => {
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(this.goalId))
			try {
				const current = await this.dependencies.store.recoverInterruptedExecution(this.goalId)
				if (current.status === "stopped" || current.status === "achieved") return current
				const stopped = await this.dependencies.store.transition(this.goalId, { status: "stopped", statusReason: reason })
				await this.syncHistory(stopped)
				await this.dependencies.postState()
				return stopped
			} finally {
				await releaseOwnership()
			}
		})
	}

	async inspect(): Promise<GoalViewState> {
		return goalViewState(await this.dependencies.store.read(this.goalId), this.isFollowUpActive, this.hasRunningCoordinator)
	}

	async publishHistory(): Promise<void> {
		await this.syncHistory(await this.dependencies.store.read(this.goalId))
	}

	private async activate(resume: boolean, beforeStart?: () => Promise<void>): Promise<void> {
		try {
			await this.lifecycleMutex.withLock(() => this.activateSerial(resume, beforeStart))
		} catch (error) {
			try {
				await this.dependencies.postState()
			} catch (publicationError) {
				throw new AggregateError([error, publicationError], `Goal ${this.goalId} activation failed`)
			}
			throw error
		}
		await this.dependencies.postState()
	}

	private async activateSerial(resume: boolean, beforeStart?: () => Promise<void>): Promise<void> {
		if (this.runtime) throw new Error(`Goal ${this.goalId} already has a running coordinator`)
		const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(this.goalId))
		try {
			const current = await this.dependencies.store.recoverInterruptedExecution(this.goalId)
			if (resume && !isResumableGoalStatus(current.status)) {
				throw new Error(`Goal ${this.goalId} cannot resume from ${current.status}`)
			}
			if (!resume && (current.status !== "paused" || current.statusReason !== "Created")) {
				throw new Error(`Goal ${this.goalId} has already been started`)
			}
			await beforeStart?.()
			this.requestedEnd = undefined
			this.followUpEndReason = undefined
			const working = await this.dependencies.store.transition(this.goalId, {
				status: "working",
				statusReason: resume ? "Resumed by user" : "Started",
			})
			try {
				await this.syncHistory(working)
				const runtime = await this.constructRuntime(working, "goal", resume)
				this.startRuntimeSettlement(runtime, releaseOwnership)
			} catch (error) {
				const blocked = await this.dependencies.store.transition(this.goalId, {
					status: "blocked",
					statusReason: errorMessage(error),
				})
				await this.syncHistory(blocked)
				throw error
			}
		} catch (error) {
			await releaseOwnership()
			throw error
		}
	}

	private async constructRuntime(
		record: GoalRecord,
		kind: GoalRuntimeKind,
		resume: boolean,
		followUpMessage?: string,
	): Promise<LiveGoalRuntime> {
		const taskFactory = this.dependencies.createTaskFactory()
		const coordinatorAuxiliarySourceId = `goal/aux:${ulid()}`
		const environmentFactory = new GoalCoordinatorToolEnvironmentFactory((surface) => this.goalTrait(surface), {
			duringUserInteraction: (operation) => this.duringCoordinatorInteraction(operation),
		})
		const coordinator = await taskFactory.create({
			id: this.goalId,
			conversationUlid: record.conversationUlid,
			...(resume || kind === "followup"
				? { historyItem: this.requireHistoryItem() }
				: { prompt: this.dependencies.initialDisplayText }),
			executionProfile: kind === "followup" ? "goal_followup" : "goal_coordinator",
			environmentFactory,
			duringTaskletUserInteraction: (operation) => this.duringCoordinatorInteraction(operation),
			getPinnedContext: () => this.pinnedContext(),
			onHistorySnapshot: (_item, task) => this.recordAccounting("goal", coordinatorAuxiliarySourceId, task),
		})

		let run: Promise<TaskRunOutcome>
		if (kind === "followup") {
			if (!followUpMessage) throw new Error(`Goal ${this.goalId} follow-up is missing user input`)
			run = coordinator.resumeTaskFromHistory(undefined, {
				systemContext: goalFollowUpWake(record),
				initialUserInput: { text: followUpMessage },
			})
		} else if (resume) {
			run = coordinator.resumeTaskFromHistory(undefined, { systemContext: goalResumeWake(record) })
		} else {
			run = coordinator.startTask(this.dependencies.initialDisplayText)
		}

		return { kind, coordinator, run }
	}

	private startRuntimeSettlement(runtime: LiveGoalRuntime, releaseOwnership: () => Promise<void>): void {
		this.runtime = runtime
		runtime.settlement = this.settleCoordinatorRun(runtime, releaseOwnership)
		// Keep the rejecting promise for cancellation callers, and report failures of autonomous settlement.
		void runtime.settlement.catch((error) => Logger.error(`[Goal ${this.goalId}] Settlement failed:`, error))
	}

	private async settleCoordinatorRun(runtime: LiveGoalRuntime, releaseOwnership: () => Promise<void>): Promise<void> {
		const outcome = await runtime.run.catch(
			(error): TaskRunOutcome => ({
				kind: "failed",
				error: serializeTaskError(error),
				failedAt: Date.now(),
			}),
		)
		runtime.settling = true
		await this.lifecycleMutex.withLock(async () => {
			const requested = this.requestedEnd
			const transition = requested && outcome.kind !== "failed" ? requested : transitionForOutcome(outcome)
			// Task outcomes also report retirement failures. Join the actual retirement boundary
			// before releasing GoalLoop's lock; a settled outcome alone does not prove safety.
			await runtime.coordinator.retirePersistence()

			// Metadata failures after safe retirement must not retain a dead runtime or its lock.
			try {
				if (runtime.kind === "followup") {
					await this.syncHistory(await this.dependencies.store.read(this.goalId))
					return
				}
				const record = await this.dependencies.store.transition(this.goalId, {
					status: transition.status,
					statusReason: transition.reason,
				})
				await this.syncHistory(record)
			} finally {
				try {
					await releaseOwnership()
				} finally {
					this.runtime = undefined
					this.requestedEnd = undefined
					this.followUpEndReason = undefined
					await this.dependencies.postState()
				}
			}
		})
	}

	private async enqueueMessage(runtime: LiveGoalRuntime, text: string): Promise<void> {
		if (this.runtime !== runtime || runtime.settling)
			throw new Error(`Goal ${this.goalId} coordinator has stopped; resume it before sending steering`)
		await runtime.coordinator.enqueueSteeringMessage(text)
		await this.dependencies.postState()
	}

	private async cancelFollowUp(reason: string): Promise<void> {
		let runtime: LiveGoalRuntime | undefined
		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime?.kind === "followup") {
				runtime = this.runtime
				this.followUpEndReason = reason
			}
		})
		if (!runtime) return

		const controls = await Promise.allSettled([
			runtime.coordinator.abortTask({ kind: "cancelled", reason }),
		])
		await runtime.settlement
		const failures = controls
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) throw new AggregateError(failures, `Goal ${this.goalId} follow-up cancellation failed`)
	}

	private async endActiveRun(
		status: Extract<RequestedEnd, "paused" | "stopped">,
		kind: "cancelled" | "interrupted",
		reason: string,
	): Promise<GoalRecord> {
		let runtime: LiveGoalRuntime | undefined
		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime?.kind !== "goal") return
			this.requestedEnd ??= { status, reason }
			runtime = this.runtime
		})
		if (!runtime) return this.dependencies.store.read(this.goalId)
		const controls = await Promise.allSettled([
			runtime.coordinator.abortTask({ kind, reason }),
		])
		await runtime.settlement
		const failures = controls
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) throw new AggregateError(failures, `Goal ${status} failed`)
		return this.dependencies.store.read(this.goalId)
	}

	private goalTrait(surface: SurfaceAdapter): IGoalTrait {
		return {
			getObjective: async () => (await this.dependencies.store.read(this.goalId)).objective,
			replaceObjective: (markdown) => this.replaceObjective(markdown),
			blockGoal: (reason) => this.blockGoal(surface, reason),
			commitCompletion: (result) => this.commitCompletion(surface, result),
		}
	}

	private async replaceObjective(markdown: string) {
		const objective = markdown.trim()
		if (!objective) throw new Error("A Goal objective cannot be empty")
		const record = await this.dependencies.store.update(this.goalId, (goal, now) => {
			if (goal.status === "achieved") {
				throw new Error(`Goal ${this.goalId} is achieved; its completed objective cannot be revised`)
			}
			goal.objective = {
				markdown: objective,
				revision: goal.objective.revision + 1,
				updatedAt: now,
			}
		})
		await this.syncHistory(record)
		await this.dependencies.postState()
		return record.objective
	}

	private async blockGoal(surface: SurfaceAdapter, reason: string): Promise<void> {
		const detail = reason.trim()
		if (!detail) throw new Error("A blocked Goal requires a non-empty reason")
		await this.lifecycleMutex.withLock(async () => {
			// Check active/pending starts and close admission in one synchronous commit.
			this.runtime?.coordinator.taskletHost?.closeAdmissionIfIdle()
			if (this.runtime?.kind === "followup") this.followUpEndReason ??= detail
			else this.requestedEnd ??= { status: "blocked", reason: detail }
		})
		surface.orchestration.setTaskState("abort", true)
	}

	private async commitCompletion(surface: SurfaceAdapter, result: string): Promise<CompletionCommitResult> {
		// Task's state-locked completion boundary rejects active tasklets and closes
		// Goal-root admission; the Goal loop owns only the durable lifecycle result.
		const completion = await surface.orchestration.commitAttemptCompletion(result)
		if (completion.committed) {
			await this.lifecycleMutex.withLock(async () => {
				if (this.runtime?.kind === "goal") this.requestedEnd ??= { status: "achieved" }
			})
		}
		return completion
	}

	private async duringCoordinatorInteraction<T>(operation: () => Promise<T>): Promise<T> {
		await this.acquireCoordinatorInteraction()
		let result: T | undefined
		let operationError: unknown
		try {
			result = await operation()
		} catch (error) {
			operationError = error
		}

		let releaseError: unknown
		try {
			await this.releaseCoordinatorInteraction()
		} catch (error) {
			releaseError = error
		}
		if (operationError && releaseError) {
			throw new AggregateError([operationError, releaseError], "Goal user interaction and status restoration failed")
		}
		if (operationError) throw operationError
		if (releaseError) throw releaseError
		return result as T
	}

	private async acquireCoordinatorInteraction(): Promise<void> {
		await this.interactionMutex.withLock(async () => {
			if (this.runtime?.kind !== "goal" || this.coordinatorInteractionCount > 0 || this.requestedEnd || this.followUpEndReason) {
				this.coordinatorInteractionCount += 1
				return
			}

			let transitioned = false
			try {
				const current = await this.dependencies.store.read(this.goalId)
				if (current.status === "working") {
					await this.dependencies.store.transition(this.goalId, {
						status: "waiting",
						statusReason: "Waiting for user interaction",
					})
					transitioned = true
					await this.dependencies.postState()
				}
				this.coordinatorInteractionCount = 1
			} catch (error) {
				if (!transitioned || this.requestedEnd || this.followUpEndReason) throw error
				try {
					await this.dependencies.store.transition(this.goalId, { status: "working" })
					await this.dependencies.postState()
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Goal interaction acquisition rollback failed")
				}
				throw error
			}
		})
	}

	private async releaseCoordinatorInteraction(): Promise<void> {
		await this.interactionMutex.withLock(async () => {
			if (this.coordinatorInteractionCount === 0) throw new Error("Goal interaction ownership is unbalanced")
			this.coordinatorInteractionCount -= 1
			if (this.runtime?.kind !== "goal" || this.coordinatorInteractionCount !== 0 || this.requestedEnd || this.followUpEndReason) return
			const current = await this.dependencies.store.read(this.goalId)
			if (current.status !== "waiting") return
			await this.dependencies.store.transition(this.goalId, { status: "working" })
			await this.dependencies.postState()
		})
	}

	private async pinnedContext(): Promise<string> {
		const record = await this.dependencies.store.read(this.goalId)
		const active = this.coordinator?.taskletHost?.listActive() ?? []
		return [
			`<goal_lifecycle status="${record.status}" coordinator="${this.runtime?.kind ?? "idle"}">`,
			`Follow-up conversation turns do not change this lifecycle status.`,
			"</goal_lifecycle>",
			"",
			`<goal_objective revision="${record.objective.revision}">`,
			record.objective.markdown,
			"</goal_objective>",
			"",
			"<goal_active_tasks>",
			...(active.length
				? active.map(
					(child) =>
						`- ${child.id} | ${child.title}`,
				)
				: ["- none"]),
			"</goal_active_tasks>",
		].join("\n")
	}

	private requireHistoryItem(): GoalHistoryItem {
		const item = this.dependencies.stateManager
			.getGlobalStateKey("taskHistory")
			.find((candidate) => candidate.id === this.goalId)
		if (!item || !isGoalHistoryItem(item)) throw new Error(`Goal ${this.goalId} is missing its top-level history entry`)
		return item
	}

	private async recordAccounting(apiSourceId: string, auxiliarySourceId: string, task: Task): Promise<void> {
		const apiSnapshot = apiAccountingSnapshot(task)
		const auxiliarySnapshot = auxiliaryAccountingSnapshot(task)
		const record = await this.dependencies.store.update(this.goalId, (goal) => {
			if (apiSnapshot) replaceGoalAccountingSource(goal, apiSourceId, apiSnapshot)
			if (auxiliarySnapshot) replaceGoalAccountingSource(goal, auxiliarySourceId, auxiliarySnapshot)
		})
		await this.syncHistory(record)
	}

	private async syncHistory(record: GoalRecord): Promise<void> {
		await this.dependencies.updateHistory(
			createGoalHistoryItem(record, this.dependencies.initialDisplayText, this.dependencies.workspaceRootPath),
		)
	}
}

function apiAccountingSnapshot(task: Task): GoalAccounting | undefined {
	const messages = combineCardSequences(task.messageStateHandler.getDiracMessages())
	const { usageObserved, usageAvailability: available } = getApiUsageKnowledge(messages)
	if (!usageObserved) return undefined
	// Root metrics already contain one replaceable lifetime contribution per tasklet,
	// including its Utility usage. Never add those children again as Goal sources.
	const metrics = getApiMetrics(messages)
	return {
		...(available.inputTokens && available.outputTokens ? { totalTokens: metrics.totalTokensIn + metrics.totalTokensOut } : {}),
		...(available.inputTokens ? { inputTokens: metrics.totalTokensIn } : {}),
		...(available.outputTokens ? { outputTokens: metrics.totalTokensOut } : {}),
		...(available.reasoningTokens ? { reasoningTokens: metrics.totalReasoningTokens } : {}),
		...(available.cacheReads ? { cacheReadTokens: metrics.totalCacheReads ?? 0 } : {}),
		...(available.cacheWrites ? { cacheWriteTokens: metrics.totalCacheWrites ?? 0 } : {}),
		...(available.cost ? { cost: metrics.totalCost } : {}),
	}
}

function auxiliaryAccountingSnapshot(task: Task): GoalAccounting | undefined {
	const state = task.taskState
	if (!state.utilityModelUsageObserved) return undefined
	return {
		totalTokens: state.utilityPermissionInputTokens + state.utilityPermissionOutputTokens,
		inputTokens: state.utilityPermissionInputTokens,
		outputTokens: state.utilityPermissionOutputTokens,
		...(state.utilityModelReasoningAvailable ? { reasoningTokens: state.utilityModelReasoningTokens } : {}),
		...(state.utilityModelCacheReadAvailable ? { cacheReadTokens: state.utilityPermissionCacheReadTokens } : {}),
		...(state.utilityModelCacheWriteAvailable ? { cacheWriteTokens: state.utilityPermissionCacheWriteTokens } : {}),
		...(state.utilityModelCostAvailable ? { cost: state.utilityPermissionCost } : {}),
	}
}

function transitionForOutcome(outcome: TaskRunOutcome): { status: RequestedEnd; reason?: string } {
	switch (outcome.kind) {
		case "completed":
			return { status: "achieved" }
		case "failed":
			return { status: "blocked", reason: `${outcome.error.name}: ${outcome.error.message}` }
		case "cancelled":
			return { status: "blocked", reason: outcome.reason ?? "Coordinator cancelled unexpectedly" }
		case "interrupted":
			return { status: "blocked", reason: outcome.reason }
	}
}

function goalViewState(record: GoalRecord, followUpActive: boolean, hasLocalExecution: boolean): GoalViewState {
	const now = Date.now()
	return {
		id: record.id,
		status: record.status,
		followUpActive,
		hasLocalExecution,
		...(record.statusReason ? { statusReason: record.statusReason } : {}),
		objective: record.objective,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		wallDurationMs: goalWallDurationAt(record, now),
		activeDurationMs: goalActiveDurationAt(record, now),
		accounting: record.accounting,
		mode: "act",
		modeSwitchingDisabled: true,
		modeSwitchingExplanation: GOAL_MODE_SWITCHING_EXPLANATION,
	}
}

function goalResumeWake(record: GoalRecord): string {
	return `Resume Goal ${record.id}. Re-evaluate the current workspace before acting. The current objective is supplied separately in pinned Goal context. Saved tasklets do not restart automatically; inspect their handles and explicitly resume only when useful. Do not replay historical requests.`
}

function goalFollowUpWake(record: GoalRecord): string {
	return `Continue Goal ${record.id} for one user-initiated follow-up turn. The durable Goal status remains ${record.status}. Completing or blocking this turn must not change that status. The current objective and live contained Tasks are supplied separately in pinned Goal context.`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
