import type { StateManager } from "@core/storage/StateManager"
import type { Task } from "@core/task"
import type { TaskRunOutcome } from "@core/task/TaskRunOutcome"
import { SurfaceAdapter } from "@core/task/tools/adapters/SurfaceAdapter"
import { combineCardSequences } from "@shared/combineCardSequences"
import { getApiMetrics } from "@shared/getApiMetrics"
import type {
	CompletionCommitResult,
	IGoalTrait,
	ICardHandle,
} from "@core/task/tools/interfaces/IToolEnvironment"
import { CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import type { GoalAccounting, GoalRecord, GoalViewState } from "@shared/goal"
import {
	GOAL_MODE_SWITCHING_EXPLANATION,
	isActiveGoalStatus,
	isResumableGoalStatus,
} from "@shared/goal"
import {
	isGoalHistoryItem,
	type GoalHistoryItem,
	type HistoryItem,
} from "@shared/HistoryItem"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { replaceGoalAccountingSource } from "./GoalAccounting"
import { GoalCoordinatorToolEnvironmentFactory } from "./GoalCoordinatorEnvironment"
import { createGoalHistoryItem } from "./GoalHistory"
import { goalActiveDurationAt, goalWallDurationAt } from "./GoalLifecycle"
import { GoalStore } from "./GoalStore"
import type { GoalChildInteractionResult } from "./GoalTaskEnvironment"
import { GoalTaskFactory } from "./GoalTaskFactory"
import { GoalTaskHost, GoalTerminalGuardError } from "./GoalTaskHost"

type RequestedEnd = "paused" | "blocked" | "stopped" | "achieved"
type GoalRuntimeKind = "goal" | "followup"

interface LiveGoalRuntime {
	kind: GoalRuntimeKind
	coordinator: Task
	host: GoalTaskHost
	run: Promise<TaskRunOutcome>
	settlement?: Promise<void>
}

export interface GoalLoopDependencies {
	goalId: string
	initialDisplayText: string
	store: GoalStore
	taskFactory: GoalTaskFactory
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

	async start(): Promise<void> {
		await this.activate(false)
	}

	async resume(): Promise<void> {
		await this.activate(true)
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
			const record = await this.dependencies.store.read(this.goalId)
			if (isActiveGoalStatus(record.status)) {
				throw new Error(`Goal ${this.goalId} is ${record.status} without a running coordinator`)
			}
			this.requestedEnd = undefined
			this.followUpEndReason = undefined
			const runtime = await this.constructRuntime(record, "followup", false, text)
			this.runtime = runtime
			runtime.settlement = this.settleCoordinatorRun(runtime)
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
		const current = await this.dependencies.store.read(this.goalId)
		if (current.status === "stopped" || current.status === "achieved") return current
		if (!isActiveGoalStatus(current.status)) {
			const stopped = await this.dependencies.store.transition(this.goalId, { status: "stopped", statusReason: reason })
			await this.syncHistory(stopped)
			await this.dependencies.postState()
			return stopped
		}
		return this.endActiveRun("stopped", "cancelled", reason)
	}

	async inspect(): Promise<GoalViewState> {
		return goalViewState(await this.dependencies.store.read(this.goalId), this.isFollowUpActive)
	}

	async publishHistory(): Promise<void> {
		await this.syncHistory(await this.dependencies.store.read(this.goalId))
	}

	private async activate(resume: boolean): Promise<void> {
		try {
			await this.lifecycleMutex.withLock(() => this.activateSerial(resume))
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

	private async activateSerial(resume: boolean): Promise<void> {
		if (this.runtime) throw new Error(`Goal ${this.goalId} already has a running coordinator`)
		const current = await this.dependencies.store.read(this.goalId)
		if (resume && !isResumableGoalStatus(current.status)) {
			throw new Error(`Goal ${this.goalId} cannot resume from ${current.status}`)
		}
		if (!resume && (current.status !== "paused" || current.statusReason !== "Created")) {
			throw new Error(`Goal ${this.goalId} has already been started`)
		}

		this.requestedEnd = undefined
		this.followUpEndReason = undefined
		const working = await this.dependencies.store.transition(this.goalId, {
			status: "working",
			statusReason: resume ? "Resumed by user" : "Started",
		})
		await this.syncHistory(working)

		try {
			const runtime = await this.constructRuntime(working, "goal", resume)
			this.runtime = runtime
			runtime.settlement = this.settleCoordinatorRun(runtime)
		} catch (error) {
			const blocked = await this.dependencies.store.transition(this.goalId, {
				status: "blocked",
				statusReason: errorMessage(error),
			})
			await this.syncHistory(blocked)
			throw error
		}
	}

	private async constructRuntime(
		record: GoalRecord,
		kind: GoalRuntimeKind,
		resume: boolean,
		followUpMessage?: string,
	): Promise<LiveGoalRuntime> {
		const coordinatorAuxiliarySourceId = `goal/aux:${ulid()}`
		let host!: GoalTaskHost
		host = new GoalTaskHost(this.goalId, this.dependencies.store, async (input) =>
			this.dependencies.taskFactory.create({
				id: input.id,
				conversationUlid: input.conversationUlid,
				prompt: input.prompt,
				executionProfile: "goal_child",
				environmentFactory: input.environmentFactory,
				onHistorySnapshot: (_item, task) =>
					this.recordAccounting(
						input.role === "verification" ? `goal/verification:${input.id}` : `goal/child:${input.id}`,
						input.role === "verification"
							? `goal/verification:${input.id}/aux`
							: `goal/child:${input.id}/aux`,
						task,
					),
			}),
		)
		await host.recoverUnreadResponses()
		const environmentFactory = new GoalCoordinatorToolEnvironmentFactory(
			(surface) => this.goalTrait(host, surface),
			{
				duringUserInteraction: (operation) => this.duringCoordinatorInteraction(operation),
			},
		)
		const coordinator = await this.dependencies.taskFactory.create({
			id: this.goalId,
			conversationUlid: record.conversationUlid,
			...(resume || kind === "followup"
				? { historyItem: this.requireHistoryItem() }
				: { prompt: this.dependencies.initialDisplayText }),
			executionProfile: kind === "followup" ? "goal_followup" : "goal_coordinator",
			environmentFactory,
			conversationPersistenceHooks: {
				onUserContentPersisted: () => host.acknowledgePersistedWake(),
				onUserContentPersistenceFailed: () => host.rollbackUnpersistedWake(),
			},
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

		return { kind, coordinator, host, run }
	}

	private async settleCoordinatorRun(runtime: LiveGoalRuntime): Promise<void> {
		const outcome = await runtime.run
		if (runtime.kind === "followup") {
			await this.settleFollowUpRun(runtime, outcome)
			return
		}
		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime !== runtime) return
			const requested = this.requestedEnd
			let transition =
				requested && outcome.kind !== "failed" ? requested : transitionForOutcome(outcome)
			try {
				await runtime.host.shutdown(
					transition.status === "stopped" ? "cancelled" : "interrupted",
					transition.reason ?? `Goal became ${transition.status}`,
				)
			} catch (error) {
				transition = { status: "blocked", reason: `Owned activity failed to stop: ${errorMessage(error)}` }
			}
			const record = await this.dependencies.store.transition(this.goalId, {
				status: transition.status,
				statusReason: transition.reason,
			})
			this.runtime = undefined
			this.requestedEnd = undefined
			await this.syncHistory(record)
		})
		await this.dependencies.postState()
	}

	private async settleFollowUpRun(runtime: LiveGoalRuntime, outcome: TaskRunOutcome): Promise<void> {
		const reason = this.followUpEndReason ?? followUpOutcomeReason(outcome)
		const childEnd = outcome.kind === "cancelled" ? "cancelled" : "interrupted"
		let shutdownError: unknown
		try {
			await runtime.host.shutdown(childEnd, reason)
		} catch (error) {
			shutdownError = error
		}

		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime !== runtime) return
			this.runtime = undefined
			this.followUpEndReason = undefined
			await this.syncHistory(await this.dependencies.store.read(this.goalId))
		})
		await this.dependencies.postState()
		if (shutdownError) throw shutdownError
	}

	private async enqueueMessage(runtime: LiveGoalRuntime, text: string): Promise<void> {
		if (this.runtime !== runtime) throw new Error(`Goal ${this.goalId} coordinator changed before message delivery`)
		await runtime.coordinator.enqueueSteeringMessage(text)
		await runtime.host.recordUserSteering()
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
			runtime.host.shutdown("cancelled", reason),
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
			const current = await this.dependencies.store.read(this.goalId)
			if (current.status === status) return
			if (!isActiveGoalStatus(current.status) || !this.runtime) {
				return
			}
			this.requestedEnd ??= { status, reason }
			runtime = this.runtime
		})
		if (!runtime) return this.dependencies.store.read(this.goalId)
		const controls = await Promise.allSettled([
			runtime.coordinator.abortTask({ kind, reason }),
			runtime.host.shutdown(kind, reason),
		])
		await runtime.settlement
		const failures = controls
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) throw new AggregateError(failures, `Goal ${status} failed`)
		return this.dependencies.store.read(this.goalId)
	}

	private goalTrait(host: GoalTaskHost, surface: SurfaceAdapter): IGoalTrait {
		return {
			startTask: (input) => host.startTask(input),
			listTasks: (input) => host.listTasks(input),
			sendTaskMessage: (input) => host.sendTaskMessage(input.taskId, input.message),
			cancelTask: (input) => host.cancelTask(input.taskId, input.reason),
			readTaskTranscript: (input) => host.readTaskTranscript(input.taskId, input.cursor, input.limit),
			resolveTaskInteraction: (input) => this.resolveInteraction(host, surface, input),
			waitForEvents: () => host.waitForEvents(),
			startVerification: (input) => host.startVerification(input),
			replaceObjective: (markdown) => this.replaceObjective(markdown),
			blockGoal: (reason) => this.blockGoal(host, surface, reason),
			commitCompletion: (result) => this.commitCompletion(host, surface, result),
		}
	}

	private async resolveInteraction(
		host: GoalTaskHost,
		surface: SurfaceAdapter,
		input: Parameters<IGoalTrait["resolveTaskInteraction"]>[0],
	): ReturnType<IGoalTrait["resolveTaskInteraction"]> {
		if (input.resolution !== "passthrough") {
			return host.resolveTaskInteraction({
				taskId: input.taskId,
				interactionId: input.interactionId,
				resolution: input.resolution,
				answer: input.answer,
			})
		}
		const goal = await this.dependencies.store.read(this.goalId)
		const child = goal.children.find((candidate) => candidate.id === input.taskId)
		if (!child?.pendingInteraction || child.pendingInteraction.id !== input.interactionId) {
			throw new Error(`Interaction ${input.interactionId} is stale for contained Task ${input.taskId}`)
		}
		return this.duringCoordinatorInteraction(async () => {
			const currentGoal = await this.dependencies.store.read(this.goalId)
			const currentChild = currentGoal.children.find((candidate) => candidate.id === input.taskId)
			if (!currentChild?.pendingInteraction || currentChild.pendingInteraction.id !== input.interactionId) {
				throw new Error(`Interaction ${input.interactionId} is stale for contained Task ${input.taskId}`)
			}
			const source = currentChild.pendingInteraction.card
			const taskDetails =
				source.renderType === "markdown"
					? [
						`**Task:** ${currentChild.title}`,
						`**Task ID:** \`${currentChild.id}\``,
						`**Interaction ID:** \`${currentChild.pendingInteraction.id}\``,
					].join("\n")
					: [
						`Task: ${currentChild.title}`,
						`Task ID: ${currentChild.id}`,
						`Interaction ID: ${currentChild.pendingInteraction.id}`,
					].join("\n")
			const card = await surface.ui.createManualInteractionCard({
				kind: source.kind,
				header: `${source.header || "Task interaction"} · ${currentChild.title}`,
				toolName: "resolve_task_interaction",
				icon: source.icon,
				renderType: source.renderType,
				body:
					source.renderType === "diff"
						? source.body
						: `${taskDetails}${source.body ? `\n\n${source.body}` : ""}`,
				rawInput: {
					...(source.rawInput ?? {}),
					taskId: currentChild.id,
					interactionId: currentChild.pendingInteraction.id,
				},
				rawOutput: source.rawOutput,
				diffs: source.diffs,
				locations: source.locations,
				requireApproval: source.requireApproval,
				requireFeedback: source.requireFeedback,
				feedbackPlaceholder: source.feedbackPlaceholder,
				actions: source.actions,
				autoScroll: source.autoScroll,
				collapsed: source.collapsed,
				maxHeight: source.maxHeight,
				cleanupStrategy: source.cleanupStrategy,
				do_not_auto_collapse: source.do_not_auto_collapse,
				outcome: source.outcome,
			})
			let result: GoalChildInteractionResult
			try {
				result = (await card.waitForInteraction()) as GoalChildInteractionResult
			} catch (error) {
				try {
					await card.finalize(CardStatus.CANCELLED)
				} catch (finalizationError) {
					throw new AggregateError([error, finalizationError], "Goal passthrough interaction failed")
				}
				throw error
			}

			let resolution: Awaited<ReturnType<IGoalTrait["resolveTaskInteraction"]>>
			try {
				resolution = await host.resolveTaskInteraction({
					taskId: input.taskId,
					interactionId: input.interactionId,
					resolution: "passthrough",
					passthroughResult: result,
				})
			} catch (error) {
				try {
					await card.finalize(CardStatus.CANCELLED)
				} catch (finalizationError) {
					throw new AggregateError([error, finalizationError], "Goal passthrough relay failed")
				}
				throw error
			}
			await finalizeResolvedInteractionCard(card, resolution.task.title, result)
			return resolution
		})
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

	private async blockGoal(host: GoalTaskHost, surface: SurfaceAdapter, reason: string): Promise<void> {
		const detail = reason.trim()
		if (!detail) throw new Error("A blocked Goal requires a non-empty reason")
		await host.guardTerminalTransition()
		await this.lifecycleMutex.withLock(async () => {
			if (this.runtime?.kind === "followup") this.followUpEndReason ??= detail
			else this.requestedEnd ??= { status: "blocked", reason: detail }
		})
		surface.orchestration.setTaskState("abort", true)
	}

	private async commitCompletion(
		host: GoalTaskHost,
		surface: SurfaceAdapter,
		result: string,
	): Promise<CompletionCommitResult> {
		let completion: CompletionCommitResult
		try {
			completion = await host.commitTerminalAttempt(() => surface.orchestration.commitAttemptCompletion(result))
		} catch (error) {
			if (error instanceof GoalTerminalGuardError) return { committed: false, error: error.message }
			throw error
		}
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
			if (this.coordinatorInteractionCount > 0 || this.requestedEnd || this.followUpEndReason) {
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
			if (this.coordinatorInteractionCount !== 0 || this.requestedEnd || this.followUpEndReason) return
			const current = await this.dependencies.store.read(this.goalId)
			if (current.status !== "waiting") return
			await this.dependencies.store.transition(this.goalId, { status: "working" })
			await this.dependencies.postState()
		})
	}

	private async pinnedContext(): Promise<string> {
		const record = await this.dependencies.store.read(this.goalId)
		const active = record.children.filter((child) => child.status === "starting" || child.status === "running" || child.status === "waiting")
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
				? active.map((child) =>
					`- ${child.id} | ${child.title} | ${child.role} | ${child.status}${child.pendingInteraction ? ` | interaction ${child.pendingInteraction.id}` : ""}`,
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
	const statuses = messages
		.filter((message) => message.content.type === "api_status")
		.map((message) => (message.content.type === "api_status" ? message.content.status : undefined))
		.filter((status): status is NonNullable<typeof status> => status !== undefined)
	const usageStatuses = statuses.filter((status) => {
		if (status.usageAvailability?.inputTokens || status.usageAvailability?.outputTokens) return true
		const deleted = status.deletedMetrics
		return (
			(status.tokensIn ?? 0) +
			(status.tokensOut ?? 0) +
			(status.cacheWrites ?? 0) +
			(status.cacheReads ?? 0) +
			(status.reasoningTokens ?? 0) +
			(deleted?.tokensIn ?? 0) +
			(deleted?.tokensOut ?? 0) +
			(deleted?.cacheWrites ?? 0) +
			(deleted?.cacheReads ?? 0) >
			0
		)
	})
	const subagentUsage = messages
		.filter((message) => message.content.type === "card" && (
			message.content.card.rawOutput?.source === "subagents" || message.content.card.header === "Subagent Usage"
		))
		.map((message) => {
			if (message.content.type !== "card") return undefined
			const card = message.content.card
			return card.rawOutput?.source === "subagents" ? card.rawOutput : parseSubagentUsage(card.body)
		})
	const hasSubagentUsage = subagentUsage.length > 0
	if (usageStatuses.length === 0 && !hasSubagentUsage) return undefined

	const metrics = getApiMetrics(messages)
	const available = (field: keyof NonNullable<(typeof usageStatuses)[number]["usageAvailability"]>) =>
		usageStatuses.every((status) => {
			if (status.usageAvailability) return status.usageAvailability[field]
			switch (field) {
				case "inputTokens":
					return status.tokensIn !== undefined || status.deletedMetrics?.tokensIn !== undefined
				case "outputTokens":
					return status.tokensOut !== undefined || status.deletedMetrics?.tokensOut !== undefined
				case "reasoningTokens":
					return status.reasoningTokens !== undefined
				case "cacheWrites":
					return status.cacheWrites !== undefined || status.deletedMetrics?.cacheWrites !== undefined
				case "cacheReads":
					return status.cacheReads !== undefined || status.deletedMetrics?.cacheReads !== undefined
				case "cost":
					return status.cost !== undefined
			}
		})
	const subagentFieldAvailable = (field: string) =>
		subagentUsage.every((usage) => usage !== undefined && finiteNumber(usage[field]))
	const inputAvailable = available("inputTokens") && subagentFieldAvailable("tokensIn")
	const outputAvailable = available("outputTokens") && subagentFieldAvailable("tokensOut")
	return {
		...(inputAvailable && outputAvailable ? { totalTokens: metrics.totalTokensIn + metrics.totalTokensOut } : {}),
		...(inputAvailable ? { inputTokens: metrics.totalTokensIn } : {}),
		...(outputAvailable ? { outputTokens: metrics.totalTokensOut } : {}),
		...(available("reasoningTokens") && !hasSubagentUsage
			? { reasoningTokens: metrics.totalReasoningTokens }
			: {}),
		...(available("cacheReads") && subagentFieldAvailable("cacheReads")
			? { cacheReadTokens: metrics.totalCacheReads ?? 0 }
			: {}),
		...(available("cacheWrites") && subagentFieldAvailable("cacheWrites")
			? { cacheWriteTokens: metrics.totalCacheWrites ?? 0 }
			: {}),
		...(available("cost") && subagentFieldAvailable("cost") ? { cost: metrics.totalCost } : {}),
	}
}

function parseSubagentUsage(body: string | undefined): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(body || "{}")
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
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

async function finalizeResolvedInteractionCard(
	card: ICardHandle,
	taskTitle: string,
	result: GoalChildInteractionResult,
): Promise<void> {
	try {
		await card.update({
			header: `Resolved task interaction: ${taskTitle}`,
			rawOutput: {
				action: result.action,
				response: result.response,
				...(result.value === undefined ? {} : { value: result.value }),
				...(result.text === undefined ? {} : { text: result.text }),
				...(result.images === undefined ? {} : { images: result.images }),
				...(result.files === undefined ? {} : { files: result.files }),
				...(result.userEdits === undefined ? {} : { userEdits: result.userEdits }),
			},
			outcome: String(result.response),
		})
		await card.finalize(CardStatus.SUCCESS)
	} catch (error) {
		if (isFinalStatus(card.status)) throw error
		try {
			await card.finalize(CardStatus.ERROR)
		} catch (finalizationError) {
			throw new AggregateError([error, finalizationError], "Resolved Goal interaction card could not be finalized")
		}
		throw error
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

function goalViewState(record: GoalRecord, followUpActive: boolean): GoalViewState {
	const now = Date.now()
	const children = record.children.map((child) => ({
		...child,
		...(!child.endedAt ? { runningDurationMs: now - (child.startedAt ?? child.createdAt) } : {}),
		idleDurationMs: Math.max(0, (child.endedAt ?? now) - child.lastActivityAt),
	}))
	const latestVerification = [...children].reverse().find((child) => child.role === "verification")
	return {
		id: record.id,
		status: record.status,
		followUpActive,
		...(record.statusReason ? { statusReason: record.statusReason } : {}),
		objective: record.objective,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		wallDurationMs: goalWallDurationAt(record, now),
		activeDurationMs: goalActiveDurationAt(record, now),
		children,
		pendingInteractionCount: children.filter((child) => child.pendingInteraction).length,
		...(latestVerification ? { latestVerification } : {}),
		accounting: record.accounting,
		mode: "act",
		modeSwitchingDisabled: true,
		modeSwitchingExplanation: GOAL_MODE_SWITCHING_EXPLANATION,
	}
}

function goalResumeWake(record: GoalRecord): string {
	const tasks = record.children.length
		? record.children.map((child) => `- ${child.id} | ${child.title} | ${child.role} | ${child.status}`).join("\n")
		: "- none"
	return `Resume Goal ${record.id}. Re-evaluate the current workspace before acting. The current objective is supplied separately in pinned Goal context. Interrupted contained Tasks are terminal and must not be resumed in place.\n\nContained Tasks at resume:\n${tasks}`
}

function goalFollowUpWake(record: GoalRecord): string {
	return `Continue Goal ${record.id} for one user-initiated follow-up turn. The durable Goal status remains ${record.status}. Completing or blocking this turn must not change that status. The current objective and live contained Tasks are supplied separately in pinned Goal context.`
}

function followUpOutcomeReason(outcome: TaskRunOutcome): string {
	switch (outcome.kind) {
		case "completed":
			return "Follow-up completed"
		case "failed":
			return `Follow-up failed: ${outcome.error.name}: ${outcome.error.message}`
		case "cancelled":
			return outcome.reason ?? "Follow-up cancelled"
		case "interrupted":
			return outcome.reason
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
