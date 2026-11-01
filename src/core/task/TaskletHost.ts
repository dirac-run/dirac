import { getSavedApiConversationState, getSavedPresentationHistory } from "@core/storage/conversationHistory"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import { saveTaskletRecord, type TaskletRecord } from "@core/storage/taskStorage"
import type { DiracMessage, TaskStatus } from "@shared/ExtensionMessage"
import type { DiracStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { createTaskletId } from "@shared/taskletId"
import { ulid } from "ulid"
import { Task, type TaskParams } from "./index"
import { serializeTaskError, type SerializedTaskError, type TaskRunOutcome } from "./TaskRunOutcome"

/** Construction data only; foreground callbacks and root lock ownership cannot be inherited. */
export type TaskletTaskOptions = Pick<
	TaskParams,
	| "controller"
	| "cwd"
	| "stateManager"
	| "workingConfiguration"
	| "workspaceManager"
	| "shellIntegrationTimeout"
	| "terminalReuseEnabled"
	| "terminalOutputLineLimit"
	| "defaultTerminalProfile"
	| "vscodeTerminalExecutionMode"
	| "pinnedContext"
	| "toolSelectionPolicy"
	| "toolEnvironmentFactory"
>

export interface TaskletInspection extends TaskletRecord {
	/** Live engine status is informational, never evidence of a committed outcome. */
	executionStatus?: TaskStatus
	backgroundCommandRunning: boolean
	outcomePersisted: boolean
	settlementError?: SerializedTaskError
}

interface TaskletTranscript {
	conversation: DiracStorageMessage[]
	presentation: DiracMessage[]
}

interface OwnedTasklet {
	record: TaskletRecord
	task?: Task
	failedTranscript?: TaskletTranscript
	settlement?: Promise<void>
	backgroundCommandRunning: boolean
	outcomePersisted: boolean
	settlementError?: SerializedTaskError
}

/**
 * One ordinary root's in-memory child owner. Production lifetime attachment is
 * deliberately separate from these primitives (migration item 3.7).
 * No interaction decisions, parent-context delivery or reconstruction live here yet.
 */
export class TaskletHost {
	private readonly children = new Map<string, OwnedTasklet>()
	private readonly rootTaskId: string

	constructor(
		owner: Pick<Task, "taskId" | "executionProfile">,
		private readonly options: TaskletTaskOptions,
	) {
		if (owner.executionProfile !== "standalone") throw new Error("Only ordinary root Tasks may own tasklets")
		getTaskDirectoryPath(owner.taskId)
		this.rootTaskId = owner.taskId
	}

	/** Persist acceptance and launch, without waiting for the assignment to finish. */
	async start(input: { title: string; prompt: string }): Promise<TaskletRecord> {
		const title = input.title.trim()
		const prompt = input.prompt.trim()
		if (!title || !prompt) throw new Error("Tasklet title and prompt must be non-empty")
		const record: TaskletRecord = {
			id: createTaskletId(),
			rootTaskId: this.rootTaskId,
			conversationUlid: ulid(),
			title,
			prompt,
			createdAt: Date.now(),
		}
		// No Task or live handle exists if this initial write fails.
		await saveTaskletRecord(record)
		const child: OwnedTasklet = { record, backgroundCommandRunning: false, outcomePersisted: false }
		this.children.set(record.id, child)
		try {
			child.task = new Task({
				...this.options,
				taskId: record.id,
				conversationUlid: record.conversationUlid,
				task: prompt,
				executionProfile: "tasklet",
				updateTaskHistory: async () => [],
				postStateToWebview: unavailableForegroundCallback,
				reinitExistingTaskFromId: unavailableForegroundCallback,
				cancelTask: unavailableForegroundCallback,
				tasklet: {
					storageAddress: this.address(record.id),
					// Activity remains in the child's transcript. Parent delivery is item 3.10.
					postStateToOwner: async () => {},
					postPresentationToOwner: async () => {},
					updateBackgroundCommandState: (running) => {
						child.backgroundCommandRunning = running
					},
				},
			})
		} catch (error) {
			child.settlement = this.persistOutcome(child, {
				kind: "failed",
				error: serializeTaskError(error),
				failedAt: Date.now(),
			})
			await child.settlement
			return structuredClone(child.record)
		}
		child.settlement = this.observeRun(child, child.task)
		// Retain the rejecting promise for controls; observe it now to avoid an unhandled rejection.
		void child.settlement.catch((error) => Logger.error(`[Tasklet ${record.id}] Settlement failed:`, error))
		return structuredClone(record)
	}

	list(): TaskletInspection[] {
		return [...this.children.keys()].map((id) => this.inspect(id))
	}

	inspect(id: string): TaskletInspection {
		const child = this.requireChild(id)
		return structuredClone({
			...child.record,
			executionStatus: child.task?.stateView.status,
			backgroundCommandRunning: child.backgroundCommandRunning,
			outcomePersisted: child.outcomePersisted,
			settlementError: child.settlementError,
		})
	}

	async readTranscript(id: string) {
		const child = this.requireChild(id)
		if (child.failedTranscript) return structuredClone(child.failedTranscript)
		if (child.task) {
			return structuredClone({
				conversation: child.task.messageStateHandler.getApiConversationHistory(),
				presentation: child.task.messageStateHandler.getDiracMessages(),
			})
		}
		const [conversation, presentation] = await Promise.all([
			getSavedApiConversationState(this.address(id)),
			getSavedPresentationHistory(this.address(id)),
		])
		return { conversation: conversation.messages, presentation: presentation.messages }
	}

	/** Uses the engine's admission check; startup/terminal states can reject steering. */
	async steer(id: string, message: string): Promise<{ id: string; messageId: string; accepted: true }> {
		const child = this.requireChild(id)
		if (!child.task || child.record.outcome) throw new Error(`Tasklet ${id} is not running`)
		const messageId = await child.task.enqueueSteeringMessage(message)
		return { id, messageId, accepted: true }
	}

	/** Abort is not settlement: retain ownership through the run and outcome write. */
	async interrupt(id: string, reason?: string): Promise<TaskletInspection> {
		const child = this.requireChild(id)
		const results = await Promise.allSettled([
			child.task && !child.record.outcome ? child.task.abortTask({ kind: "interrupted", reason }) : undefined,
			child.settlement,
		])
		const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
		if (failures.length) throw new AggregateError(failures, `Tasklet ${id} interruption failed`)
		return this.inspect(id)
	}

	private async observeRun(child: OwnedTasklet, task: Task): Promise<void> {
		let outcome: TaskRunOutcome
		try {
			outcome = await task.startTask(child.record.prompt)
		} catch (error) {
			// Task normally returns a failed outcome, including finalization errors.
			// A rejected start still requires retirement of the constructed execution.
			const failures: unknown[] = [error]
			try {
				await task.abortTask()
			} catch (abortError) {
				failures.push(abortError)
			}
			try {
				await task.retirePersistence()
			} catch (retirementError) {
				failures.push(retirementError)
			}
			outcome = {
				kind: "failed",
				failedAt: Date.now(),
				error: serializeTaskError(failures.length > 1 ? new AggregateError(failures, "Tasklet startup failed") : error),
			}
		}
		// Failed finalization can leave disk history incomplete. Preserve inspection data,
		// not live execution resources, before releasing the Task reference.
		if (outcome.kind === "failed") {
			child.failedTranscript = structuredClone({
				conversation: task.messageStateHandler.getApiConversationHistory(),
				presentation: task.messageStateHandler.getDiracMessages(),
			})
		}
		await this.persistOutcome(child, outcome)
	}

	private async persistOutcome(child: OwnedTasklet, outcome: TaskRunOutcome): Promise<void> {
		child.record = { ...child.record, outcome }
		try {
			await saveTaskletRecord(child.record)
			child.outcomePersisted = true
		} catch (error) {
			child.settlementError = serializeTaskError(error)
			throw error
		} finally {
			child.task = undefined
			child.backgroundCommandRunning = false
		}
	}

	private requireChild(id: string): OwnedTasklet {
		const child = this.children.get(id)
		if (!child) throw new Error(`Tasklet ${id} does not belong to root ${this.rootTaskId}`)
		return child
	}

	private address(id: string) {
		return { kind: "tasklet" as const, rootTaskId: this.rootTaskId, taskletId: id }
	}
}

async function unavailableForegroundCallback(): Promise<never> {
	throw new Error("Tasklet cannot use a foreground lifecycle callback")
}
