import { getSavedApiConversationHistory, getSavedDiracMessages } from "@core/storage/disk"
import type { Task } from "@core/task"
import type { TaskRunOutcome } from "@core/task/TaskRunOutcome"
import type {
	CardParams,
	CompletionCommitResult,
	ICardHandle,
	TranscriptPage,
} from "@core/task/tools/interfaces/IToolEnvironment"
import type { ToolEnvironmentFactory } from "@core/task/tools/interfaces/ToolEnvironmentFactory"
import { type Card, CardKind, CardStatus, type DiracMessage } from "@shared/ExtensionMessage"
import {
	type GoalChildRecord,
	type GoalChildRole,
	type GoalChildStatus,
	type GoalEvent,
	type GoalRecord,
	isTerminalGoalChildStatus,
} from "@shared/goal"
import type { DiracStorageMessage } from "@shared/messages/content"
import type { ResponseArguments } from "@shared/responseTool"
import { Logger } from "@shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { GoalStore } from "./GoalStore"
import {
	type GoalChildInteractionResult,
	type GoalChildSurfaceOwner,
	GoalChildToolEnvironmentFactory,
} from "./GoalTaskEnvironment"
import { goalTranscriptPage } from "./GoalTranscript"

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const DEFAULT_TRANSCRIPT_LIMIT = 50
const MAX_TRANSCRIPT_LIMIT = 200

function nextGoalChildTaskId(goal: GoalRecord, now: number): string {
	const timestampIds = [goal.id, ...goal.children.map((child) => child.id)].filter((id) => /^\d+$/.test(id)).map(Number)
	return String(Math.max(now - 1, ...timestampIds) + 1)
}

interface LiveChild {
	task: Task
	run: Promise<TaskRunOutcome>
	settlement?: Promise<void>
}

interface PendingInteraction {
	card: ICardHandle
	resolve: (result: GoalChildInteractionResult) => void
	reject: (error: Error) => void
}

interface ClaimedEventBatch {
	events: GoalEvent[]
	coordinatorConversationPersisted: boolean
}

export class GoalTerminalGuardError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "GoalTerminalGuardError"
	}
}

export interface GoalChildTaskFactoryInput {
	id: string
	conversationUlid: string
	prompt: string
	role: GoalChildRole
	environmentFactory: ToolEnvironmentFactory
}

export type GoalChildTaskFactory = (input: GoalChildTaskFactoryInput) => Promise<Task>

export class GoalTaskHost implements GoalChildSurfaceOwner {
	private readonly registryMutex = new Mutex()
	private readonly liveChildren = new Map<string, LiveChild>()
	private readonly pendingInteractions = new Map<string, PendingInteraction>()
	private waiter?: () => void
	private claimedEventBatch?: ClaimedEventBatch
	private acceptingWork = true
	private closed = false
	private shutdownPromise?: Promise<void>

	constructor(
		readonly goalId: string,
		private readonly store: GoalStore,
		private readonly createTask: GoalChildTaskFactory,
		private readonly interventionDeadlineMs?: number,
	) {}

	async startTask(input: { taskTitle: string; prompt: string }, role: GoalChildRole = "task"): Promise<GoalChildRecord> {
		const title = input.taskTitle.trim()
		const prompt = input.prompt.trim()
		if (!title || !prompt) throw new Error("Contained Task title and prompt must be non-empty")

		return this.registryMutex.withLock(async () => {
			if (!this.acceptingWork || this.closed) throw new Error("Goal Task host is shutting down")
			const conversationUlid = ulid()
			let taskId!: string
			let record!: GoalChildRecord
			await this.store.update(this.goalId, (goal, now) => {
				taskId = nextGoalChildTaskId(goal, now)
				record = {
					id: taskId,
					title,
					role,
					status: "starting",
					createdAt: now,
					lastActivityAt: now,
					deliveredResponseCursor: 0,
				}
				goal.children.push(record)
			})

			let task: Task
			try {
				task = await this.createTask({
					id: taskId,
					conversationUlid,
					prompt,
					role,
					environmentFactory: new GoalChildToolEnvironmentFactory(taskId, role, this),
				})
			} catch (error) {
				record = await this.recordStartupFailure(taskId, error)
				throw error
			}

			try {
				await this.updateChild(taskId, (child, now) => {
					child.status = "running"
					child.startedAt = now
					child.lastActivityAt = now
				})
			} catch (error) {
				const failures: unknown[] = [error]
				try {
					await task.abortTask({ kind: "cancelled", reason: "Contained Task failed to start durably" })
				} catch (abortError) {
					failures.push(abortError)
				}
				try {
					await task.retirePersistence()
				} catch (retirementError) {
					failures.push(retirementError)
				}
				try {
					record = await this.recordStartupFailure(taskId, error)
				} catch (recordError) {
					failures.push(recordError)
				}
				if (failures.length === 1) throw error
				throw new AggregateError(failures, `Contained Task ${taskId} startup failed`)
			}

			const run = task.startTask(prompt)
			const live: LiveChild = { task, run }
			this.liveChildren.set(taskId, live)
			live.settlement = this.observeRun(taskId, run)
			void live.settlement.catch((error) => Logger.error(`[Goal ${this.goalId}] Child ${taskId} settlement failed:`, error))
			return record
		})
	}

	async startVerification(input: { focus?: string }): Promise<GoalChildRecord> {
		const goal = await this.store.read(this.goalId)
		const childSummary = goal.children
			.map((child) => `- ${child.id} | ${child.title} | ${child.role} | ${child.status}`)
			.join("\n")
		const focus = input.focus?.trim()
		const prompt = `Verify the current workspace against the parent Goal's durable objective. Inspect authoritative files and run appropriate non-destructive verification. Report evidence, gaps, and uncertainty to the parent through respond. Do not modify the workspace unless verification itself explicitly requires a small fixture that you clean up.

<goal_objective revision="${goal.objective.revision}">
${goal.objective.markdown}
</goal_objective>

<goal_children>
${childSummary || "No contained Tasks have been recorded."}
</goal_children>${focus ? `\n\n<verification_focus>\n${focus}\n</verification_focus>` : ""}`
		return this.startTask({ taskTitle: focus ? `Verify Goal: ${focus}` : "Verify Goal", prompt }, "verification")
	}

	/** Rebuilds unread response references from canonical private transcripts after pause or restart. */
	async recoverUnreadResponses(): Promise<void> {
		const record = await this.store.read(this.goalId)
		const unread: Array<{ taskId: string; responseCursor: number; occurredAt: number }> = []
		for (const child of record.children) {
			const messages = await getSavedDiracMessages(child.id)
			const responses = messages.filter(
				(message) => message.content.type === "card" && message.content.card.toolName === "goal_child_response",
			)
			unread.push(
				...responses.slice(child.deliveredResponseCursor).map((message, index) => ({
					taskId: child.id,
					responseCursor: child.deliveredResponseCursor + index + 1,
					occurredAt: message.ts,
				})),
			)
		}
		const hasStaleInteractionEvent = record.events.some((event) => {
			if (event.kind !== "task_interaction") return false
			const child = record.children.find((candidate) => candidate.id === event.taskId)
			return child?.pendingInteraction?.id !== event.interactionId
		})
		if (unread.length === 0 && !hasStaleInteractionEvent) return
		unread.sort(
			(left, right) =>
				left.occurredAt - right.occurredAt ||
				left.taskId.localeCompare(right.taskId) ||
				left.responseCursor - right.responseCursor,
		)

		await this.store.update(this.goalId, (goal, now) => {
			goal.events = goal.events.filter((event) => {
				if (event.kind !== "task_interaction") return true
				const child = goal.children.find((candidate) => candidate.id === event.taskId)
				return child?.pendingInteraction?.id === event.interactionId
			})
			let addedResponse = false
			for (const entry of unread) {
				const exists = goal.events.some(
					(event) =>
						event.kind === "task_response" &&
						event.taskId === entry.taskId &&
						event.responseCursor === entry.responseCursor,
				)
				if (exists) continue
				goal.events.push({
					kind: "task_response",
					sequence: 0,
					taskId: entry.taskId,
					responseCursor: entry.responseCursor,
					occurredAt: Math.max(goal.createdAt, Math.min(entry.occurredAt, now)),
				})
				addedResponse = true
			}
			if (addedResponse) {
				goal.events.sort(
					(left, right) =>
						left.occurredAt - right.occurredAt ||
						eventTieKey(left).localeCompare(eventTieKey(right)) ||
						left.sequence - right.sequence,
				)
				for (const event of goal.events) {
					goal.eventSequence += 1
					event.sequence = goal.eventSequence
				}
			}
		})
	}

	async listTasks(input: { status?: GoalChildStatus[]; role?: GoalChildRole; cursor?: string; limit?: number }) {
		const goal = await this.store.read(this.goalId)
		const now = Date.now()
		const offset = parseCursor(input.cursor)
		const limit = boundedLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
		const tasks: GoalChildRecord[] = []
		let nextOffset = Math.min(offset, goal.children.length)
		while (nextOffset < goal.children.length && tasks.length < limit) {
			const child = goal.children[nextOffset]
			nextOffset += 1
			if (input.status && !input.status.includes(child.status)) continue
			if (input.role && input.role !== child.role) continue
			tasks.push(child)
		}
		return {
			tasks: tasks.map((child) => ({
				...child,
				...(!child.endedAt ? { runningDurationMs: now - (child.startedAt ?? child.createdAt) } : {}),
				idleDurationMs: Math.max(0, (child.endedAt ?? now) - child.lastActivityAt),
			})),
			...(nextOffset < goal.children.length ? { nextCursor: String(nextOffset) } : {}),
		}
	}

	async sendTaskMessage(taskId: string, message: string): Promise<GoalChildRecord> {
		this.assertAcceptingWork()
		const text = message.trim()
		if (!text) throw new Error("Contained Task message cannot be empty")
		const child = this.requireLiveChild(taskId)
		const record = await this.childRecord(taskId)
		if (isTerminalGoalChildStatus(record.status)) throw new Error(`Contained Task ${taskId} is ${record.status}`)
		await child.task.enqueueSteeringMessage(text)
		return this.updateChild(taskId, (current, now) => {
			current.lastActivityAt = now
		})
	}

	async cancelTask(taskId: string, reason?: string): Promise<GoalChildRecord> {
		return this.registryMutex.withLock(async () => {
			const record = await this.childRecord(taskId)
			if (!this.liveChildren.has(taskId) && isTerminalGoalChildStatus(record.status)) return record
			const live = this.requireLiveChild(taskId)
			const failures: unknown[] = []
			try {
				await this.cancelPendingInteraction(taskId, reason ?? "Contained Task cancelled")
			} catch (error) {
				failures.push(error)
			}
			try {
				await live.task.abortTask({ kind: "cancelled", reason })
			} catch (error) {
				failures.push(error)
			}
			try {
				await live.settlement
			} catch (error) {
				failures.push(error)
			}
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, `Contained Task ${taskId} cancellation failed`)
			return this.childRecord(taskId)
		})
	}

	async readTaskTranscript(taskId: string, cursor?: string, requestedLimit?: number): Promise<TranscriptPage> {
		await this.childRecord(taskId)
		const limit = boundedLimit(requestedLimit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT)
		return goalTranscriptPage(await this.apiTranscript(taskId), cursor, limit)
	}

	async recordResponse(taskId: string, _response: ResponseArguments): Promise<void> {
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			if (isTerminalGoalChildStatus(child.status)) throw new Error(`Contained Task ${taskId} is ${child.status}`)
			const responseCursor = nextResponseCursor(goal, child)
			child.lastActivityAt = now
			goal.eventSequence += 1
			goal.events.push({
				kind: "task_response",
				sequence: goal.eventSequence,
				taskId,
				responseCursor,
				occurredAt: now,
			})
		})
		this.notifyWaiter()
	}

	async recordActivity(taskId: string): Promise<void> {
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			if (!isTerminalGoalChildStatus(child.status)) child.lastActivityAt = now
		})
	}

	async waitForInteraction(taskId: string, params: CardParams, cardHandle: ICardHandle): Promise<GoalChildInteractionResult> {
		this.assertAcceptingWork()
		const interactionId = ulid()
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			if (isTerminalGoalChildStatus(child.status)) throw new Error(`Contained Task ${taskId} is ${child.status}`)
			if (child.pendingInteraction) throw new Error(`Contained Task ${taskId} already has a pending interaction`)
			child.status = "waiting"
			child.lastActivityAt = now
			child.pendingInteraction = {
				id: interactionId,
				kind: params.requireFeedback ? "feedback" : params.actions?.length ? "action" : "approval",
				createdAt: now,
				card: cardSnapshot(params, cardHandle, now),
			}
			goal.eventSequence += 1
			goal.events.push({
				kind: "task_interaction",
				sequence: goal.eventSequence,
				taskId,
				interactionId,
				occurredAt: now,
			})
		})
		this.notifyWaiter()

		return new Promise<GoalChildInteractionResult>((resolve, reject) => {
			this.pendingInteractions.set(interactionKey(taskId, interactionId), { card: cardHandle, resolve, reject })
		})
	}

	async resolveTaskInteraction(input: {
		taskId: string
		interactionId: string
		resolution: "allow" | "reject" | "answer" | "passthrough"
		answer?: string
		passthroughResult?: GoalChildInteractionResult
	}): Promise<{ resolved: true; task: GoalChildRecord }> {
		this.assertAcceptingWork()
		const child = await this.childRecord(input.taskId)
		if (!child.pendingInteraction || child.pendingInteraction.id !== input.interactionId) {
			throw new Error(`Interaction ${input.interactionId} is stale for contained Task ${input.taskId}`)
		}
		const pending = this.pendingInteractions.get(interactionKey(input.taskId, input.interactionId))
		if (!pending) throw new Error(`Interaction ${input.interactionId} is not active`)
		if (input.resolution !== "passthrough" && child.pendingInteraction.kind === "approval" && input.resolution === "answer") {
			throw new Error(`Interaction ${input.interactionId} requires allow or reject, not an answer`)
		}
		if (input.resolution !== "passthrough" && child.pendingInteraction.kind === "feedback" && input.resolution === "allow") {
			throw new Error(`Interaction ${input.interactionId} requires an answer or rejection, not allow`)
		}

		let result: GoalChildInteractionResult
		if (input.resolution === "passthrough") {
			if (!input.passthroughResult) throw new Error(`Interaction ${input.interactionId} is missing its passthrough result`)
			result = input.passthroughResult
		} else if (input.passthroughResult) {
			throw new Error(`Interaction ${input.interactionId} received an unexpected passthrough result`)
		} else if (input.resolution === "allow") {
			result = { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
		} else if (input.resolution === "reject") {
			result = { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }
		} else {
			const answer = input.answer?.trim()
			if (!answer) throw new Error("An answer resolution requires non-empty text")
			result = { action: DiracAskResponse.MESSAGE, response: DiracAskResponse.MESSAGE, text: answer }
		}

		const task = await this.updateChild(input.taskId, (record, now) => {
			record.pendingInteraction = undefined
			record.status = "running"
			record.lastActivityAt = now
		})
		this.pendingInteractions.delete(interactionKey(input.taskId, input.interactionId))
		pending.resolve(result)
		return { resolved: true, task }
	}

	async recordUserSteering(): Promise<void> {
		await this.store.update(this.goalId, (goal, now) => {
			goal.eventSequence += 1
			goal.events.push({ kind: "user_steering", sequence: goal.eventSequence, occurredAt: now })
		})
		this.notifyWaiter()
	}

	async waitForEvents(): Promise<string> {
		if (this.closed) throw new Error("Goal Task host is shut down")
		if (this.claimedEventBatch) {
			throw new Error("The previous Goal wake is still awaiting coordinator conversation persistence")
		}

		let reason: "events" | "intervention" = "events"
		let record = await this.store.read(this.goalId)
		while (record.events.length === 0 && reason !== "intervention") {
			reason = await this.waitForNotification()
			record = await this.store.read(this.goalId)
		}
		const events = [...record.events].sort((left, right) => left.sequence - right.sequence)
		const previousWakeAt = record.lastWakeAt
		const wake = await this.store.update(this.goalId, (goal, now) => {
			goal.wakeSequence += 1
			goal.lastWakeAt = now
		})
		const formattedWake = await this.formatWake(wake, events, events.length ? "events" : reason, previousWakeAt)
		if (events.length > 0) {
			this.claimedEventBatch = { events, coordinatorConversationPersisted: false }
		}
		return formattedWake
	}

	/** Settles a claimed wake only after Task has durably persisted its tool result in coordinator history. */
	async acknowledgePersistedWake(): Promise<void> {
		const batch = this.claimedEventBatch
		if (!batch) return
		// Persistence cannot be rolled back. If settlement fails, the coordinator turn fails;
		// durable event references remain unread and a restarted host replays them.
		batch.coordinatorConversationPersisted = true
		await this.settleClaimedEvents(batch)
		if (this.claimedEventBatch === batch) this.claimedEventBatch = undefined
	}

	/** Releases an uncommitted claim so its durable event references can be replayed. */
	async rollbackUnpersistedWake(): Promise<void> {
		const batch = this.claimedEventBatch
		if (!batch) return
		if (batch.coordinatorConversationPersisted) return
		this.claimedEventBatch = undefined
	}

	async commitTerminalAttempt(commit: () => Promise<CompletionCommitResult>): Promise<CompletionCommitResult> {
		return this.registryMutex.withLock(async () => {
			await this.assertNoLiveChildren()
			const result = await commit()
			if (result.committed) this.acceptingWork = false
			return result
		})
	}

	async guardTerminalTransition(): Promise<void> {
		await this.registryMutex.withLock(async () => {
			await this.assertNoLiveChildren()
			this.acceptingWork = false
		})
	}

	shutdown(kind: "cancelled" | "interrupted", reason: string): Promise<void> {
		this.shutdownPromise ??= this.performShutdown(kind, reason)
		return this.shutdownPromise
	}

	private async performShutdown(kind: "cancelled" | "interrupted", reason: string): Promise<void> {
		await this.registryMutex.withLock(async () => {
			this.closed = true
			this.acceptingWork = false
			this.notifyWaiter()
			const failures: unknown[] = []
			const interactions = [...this.pendingInteractions.keys()]
			await Promise.all(
				interactions.map(async (key) => {
					try {
						await this.cancelPendingInteractionByKey(key, reason)
					} catch (error) {
						failures.push(error)
					}
				}),
			)
			await Promise.all(
				[...this.liveChildren.values()].map(async (live) => {
					try {
						await live.task.abortTask({ kind, reason })
					} catch (error) {
						failures.push(error)
					}
					try {
						await live.settlement
					} catch (error) {
						failures.push(error)
					}
				}),
			)
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, "Goal Task host shutdown failed")
		})
	}

	private async observeRun(taskId: string, run: Promise<TaskRunOutcome>): Promise<void> {
		const outcome = await run
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			child.endedAt = now
			child.pendingInteraction = undefined
			switch (outcome.kind) {
				case "completed":
					child.status = "completed"
					child.terminalSummary = outcome.response
					break
				case "failed":
					child.status = "failed"
					child.terminalSummary = outcome.error.message
					goal.eventSequence += 1
					goal.events.push({
						kind: "task_failed",
						sequence: goal.eventSequence,
						taskId,
						occurredAt: now,
					})
					break
				case "cancelled":
					child.status = "cancelled"
					child.terminalSummary = outcome.reason
					break
				case "interrupted":
					child.status = "interrupted"
					child.terminalSummary = outcome.reason
					break
			}
			if (outcome.kind !== "failed") {
				goal.eventSequence += 1
				goal.events.push({ kind: "task_finished", sequence: goal.eventSequence, taskId, occurredAt: now })
			}
		})
		this.liveChildren.delete(taskId)
		this.notifyWaiter()
	}

	private async recordStartupFailure(taskId: string, error: unknown): Promise<GoalChildRecord> {
		let failed!: GoalChildRecord
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			child.status = "failed"
			child.endedAt = now
			child.terminalSummary = error instanceof Error ? error.message : String(error)
			goal.eventSequence += 1
			goal.events.push({ kind: "task_failed", sequence: goal.eventSequence, taskId, occurredAt: now })
			failed = structuredClone(child)
		})
		this.notifyWaiter()
		return failed
	}

	private async updateChild(taskId: string, update: (record: GoalChildRecord, now: number) => void): Promise<GoalChildRecord> {
		let result!: GoalChildRecord
		await this.store.update(this.goalId, (goal, now) => {
			const child = requireChild(goal, taskId)
			update(child, now)
			result = structuredClone(child)
		})
		return result
	}

	private async childRecord(taskId: string): Promise<GoalChildRecord> {
		return requireChild(await this.store.read(this.goalId), taskId)
	}

	private requireLiveChild(taskId: string): LiveChild {
		const live = this.liveChildren.get(taskId)
		if (!live) throw new Error(`Contained Task ${taskId} is not running`)
		return live
	}

	private async apiTranscript(taskId: string): Promise<DiracStorageMessage[]> {
		const live = this.liveChildren.get(taskId)
		return live
			? structuredClone(live.task.messageStateHandler.getApiConversationHistory())
			: ((await getSavedApiConversationHistory(taskId)) as DiracStorageMessage[])
	}

	private async responsePayload(taskId: string, responseCursor: number): Promise<ResponseArguments> {
		const live = this.liveChildren.get(taskId)
		const messages: DiracMessage[] = live
			? live.task.messageStateHandler.getDiracMessages()
			: await getSavedDiracMessages(taskId)
		const responses = messages.filter(
			(message) => message.content.type === "card" && message.content.card.toolName === "goal_child_response",
		)
		const message = responses[responseCursor - 1]
		if (!message || message.content.type !== "card") {
			throw new Error(`Response ${responseCursor} is missing from contained Task ${taskId}`)
		}
		const input = message.content.card.rawInput
		return {
			operation: input?.operation as ResponseArguments["operation"],
			text: String(input?.text ?? message.content.card.body ?? ""),
			...(Array.isArray(input?.options) ? { options: input.options as string[] } : {}),
		}
	}

	private async settleClaimedEvents(batch: ClaimedEventBatch): Promise<void> {
		const sequences = new Set(batch.events.map((event) => event.sequence))
		await this.store.update(this.goalId, (goal) => {
			for (const event of batch.events) {
				if (event.kind !== "task_response") continue
				const child = requireChild(goal, event.taskId)
				child.deliveredResponseCursor = Math.max(child.deliveredResponseCursor, event.responseCursor)
			}
			goal.events = goal.events.filter((event) => !sequences.has(event.sequence))
		})
	}

	private async waitForNotification(): Promise<"events" | "intervention"> {
		return new Promise((resolve, reject) => {
			let settled = false
			const finish = (result: "events" | "intervention", error?: unknown) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				if (this.waiter === notify) this.waiter = undefined
				if (error) reject(error)
				else if (this.closed) reject(new Error("Goal Task host is shut down"))
				else resolve(result)
			}
			const notify = () => finish("events")
			const timer =
				this.interventionDeadlineMs === undefined
					? undefined
					: setTimeout(() => finish("intervention"), this.interventionDeadlineMs)
			this.waiter = notify
			void this.store.read(this.goalId).then(
				(record) => {
					if (record.events.length > 0 || this.closed) notify()
				},
				(error) => finish("events", error),
			)
		})
	}

	private notifyWaiter(): void {
		this.waiter?.()
	}

	private async formatWake(
		record: GoalRecord,
		events: GoalEvent[],
		reason: "events" | "intervention",
		previousWakeAt?: number,
	): Promise<string> {
		const now = Date.now()
		const activeDuration =
			record.activeDurationMs +
			(record.lastActivatedAt && (record.status === "working" || record.status === "waiting")
				? now - record.lastActivatedAt
				: 0)
		const lines = [
			`Goal wake #${record.wakeSequence}`,
			`Goal age: ${formatDuration(now - record.createdAt)}; active time: ${formatDuration(activeDuration)}; since previous wake: ${formatDuration(previousWakeAt ? now - previousWakeAt : now - record.createdAt)}`,
			`Reason: ${events.some((event) => event.kind === "user_steering") ? "user steering" : reason === "intervention" && events.length === 0 ? "intervention deadline" : "task events"}`,
		]

		if (events.length > 0) {
			lines.push("", "Events, oldest first:")
			for (const [index, event] of events.entries()) {
				if (event.kind === "user_steering") {
					lines.push(`${index + 1}. [+${formatDuration(event.occurredAt - record.createdAt)}] User steering arrived.`)
					continue
				}
				const child = requireChild(record, event.taskId)
				lines.push(
					`${index + 1}. [+${formatDuration(event.occurredAt - record.createdAt)}] ${child.title} (${child.id}, ${child.role}, ${child.status})`,
				)
				if (event.kind === "task_response") {
					const response = await this.responsePayload(event.taskId, event.responseCursor)
					lines.push(`   Response payload: ${JSON.stringify(response)}`)
				} else if (event.kind === "task_interaction") {
					const pending = child.pendingInteraction
					lines.push(
						`   Interaction ${event.interactionId} (${pending?.kind ?? "resolved"}): ${pending?.card.header ?? "no longer pending"}\n   ${pending?.card.body ?? ""}`,
					)
				} else if (event.kind === "task_failed") {
					lines.push(`   Failed: ${child.terminalSummary ?? "No failure summary was recorded."}`)
				} else {
					lines.push(`   Finished (${child.status}): ${child.terminalSummary ?? "No summary was recorded."}`)
				}
			}
		}

		const active = record.children.filter((child) => !isTerminalGoalChildStatus(child.status))
		lines.push("", "Active tasks:")
		if (active.length === 0) lines.push("- none")
		else {
			for (const child of active) {
				lines.push(
					`- ${child.id} | ${child.title} | ${child.status} | running ${formatDuration(now - (child.startedAt ?? child.createdAt))} | idle ${formatDuration(now - child.lastActivityAt)}`,
				)
			}
		}
		return lines.join("\n")
	}

	private async assertNoLiveChildren(): Promise<void> {
		const record = await this.store.read(this.goalId)
		const active = record.children.filter(
			(child) => this.liveChildren.has(child.id) || !isTerminalGoalChildStatus(child.status),
		)
		if (active.length === 0) return
		throw new GoalTerminalGuardError(
			`Goal cannot become terminal while contained Tasks are active:\n${active
				.map((child) => `- ${child.id} | ${child.title} | ${child.status}`)
				.join("\n")}`,
		)
	}

	private assertAcceptingWork(): void {
		if (!this.acceptingWork || this.closed) throw new Error("Goal Task host is shutting down")
	}

	private async cancelPendingInteraction(taskId: string, reason: string): Promise<void> {
		const child = await this.childRecord(taskId)
		if (!child.pendingInteraction) return
		await this.cancelPendingInteractionByKey(interactionKey(taskId, child.pendingInteraction.id), reason)
	}

	private async cancelPendingInteractionByKey(key: string, reason: string): Promise<void> {
		const pending = this.pendingInteractions.get(key)
		if (!pending) return
		let finalizationError: unknown
		try {
			await pending.card.finalize(CardStatus.CANCELLED)
		} catch (error) {
			finalizationError = error
		}
		this.pendingInteractions.delete(key)
		pending.reject(new Error(reason))
		if (finalizationError) throw finalizationError
	}
}

function requireChild(goal: GoalRecord, taskId: string): GoalChildRecord {
	const child = goal.children.find((candidate) => candidate.id === taskId)
	if (!child) throw new Error(`Contained Task ${taskId} does not exist in Goal ${goal.id}`)
	return child
}

function nextResponseCursor(goal: GoalRecord, child: GoalChildRecord): number {
	return (
		Math.max(
			child.deliveredResponseCursor,
			...goal.events
				.filter(
					(event): event is Extract<GoalEvent, { kind: "task_response" }> =>
						event.kind === "task_response" && event.taskId === child.id,
				)
				.map((event) => event.responseCursor),
		) + 1
	)
}

function parseCursor(cursor?: string): number {
	if (cursor === undefined) return 0
	const offset = Number(cursor)
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid pagination cursor: ${cursor}`)
	return offset
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
	const limit = value ?? fallback
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
		throw new Error(`Pagination limit must be between 1 and ${maximum}`)
	}
	return limit
}

function interactionKey(taskId: string, interactionId: string): string {
	return `${taskId}:${interactionId}`
}

function eventTieKey(event: GoalEvent): string {
	if (event.kind === "user_steering") return "user_steering"
	if (event.kind === "task_response") return `${event.taskId}:response:${event.responseCursor}`
	if (event.kind === "task_interaction") return `${event.taskId}:interaction:${event.interactionId}`
	return `${event.taskId}:${event.kind}`
}

function cardSnapshot(params: CardParams, handle: ICardHandle, now: number): Card {
	return {
		id: handle.id,
		kind: params.kind ?? CardKind.GENERIC,
		header: params.header,
		toolName: params.toolName,
		icon: params.icon,
		status: handle.status,
		renderType: params.renderType ?? "text",
		body: params.body ?? "",
		rawInput: params.rawInput,
		rawOutput: params.rawOutput,
		diffs: params.diffs,
		locations: params.locations,
		requireApproval: params.requireApproval,
		requireFeedback: params.requireFeedback,
		feedbackPlaceholder: params.feedbackPlaceholder,
		actions: params.actions,
		autoScroll: params.autoScroll,
		collapsed: params.collapsed,
		maxHeight: params.maxHeight,
		cleanupStrategy: params.cleanupStrategy,
		do_not_auto_collapse: params.do_not_auto_collapse,
		startTime: now,
		outcome: params.outcome,
	}
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1_000))
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`
	return `${seconds}s`
}
