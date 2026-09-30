import type { Controller } from "@/core/controller"
import { Logger } from "@/shared/services/Logger.js"
import type { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { AcpSessionStatus } from "./public-types.js"
import type { AcpSessionState } from "./types.js"

interface PromptSteeringDeps {
	sessionStates: Map<string, AcpSessionState>
	emitterForSession(sessionId: string): DiracSessionEmitter
}

/**
 * Routes client guidance ("whispers") to the task bound to the active prompt.
 *
 * Whispers that arrive before a task binds are buffered per session and flushed
 * in order once a steering-capable task is bound.
 */
export class PromptSteeringQueue {
	/** Whispers received while a processing prompt has not yet bound its target task. */
	private readonly pendingWhispers = new Map<string, string[]>()

	/** The task selected for the active prompt. Undefined means task selection is still in progress. */
	private readonly promptTasks = new Map<string, NonNullable<Controller["task"]>>()

	constructor(private readonly deps: PromptSteeringDeps) {}

	/** Queue client guidance in the task selected by the active prompt. */
	async queueWhisper(params: Record<string, unknown>): Promise<void> {
		const sessionId = params.sessionId
		const text = params.text
		if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) {
			Logger.debug("[DiracAgent] Ignoring malformed dev.dirac/whisper notification")
			return
		}
		if (this.deps.sessionStates.get(sessionId)?.status !== AcpSessionStatus.Processing) {
			Logger.debug("[DiracAgent] Ignoring whisper outside an active turn:", sessionId)
			return
		}

		const task = this.promptTasks.get(sessionId)
		if (!task) {
			this.bufferWhisper(sessionId, text)
			return
		}

		if (!task.canAcceptSteeringMessage()) {
			if (task.taskState.abort || task.taskState.pendingTaskReplacement) {
				this.unbindPromptTask(sessionId)
			}
			this.bufferWhisper(sessionId, text)
			return
		}

		try {
			const steeringMessageId = await task.enqueueSteeringMessage(text)
			this.emitSteeringStatus(sessionId, steeringMessageId, "queued")
		} catch (error) {
			if (task.canAcceptSteeringMessage()) throw error
			this.unbindPromptTask(sessionId)
			this.bufferWhisper(sessionId, text)
		}
	}

	async bindPromptTask(sessionId: string, task: NonNullable<Controller["task"]>): Promise<void> {
		this.promptTasks.set(sessionId, task)
		if (!task.canAcceptSteeringMessage()) return

		const whispers = this.pendingWhispers.get(sessionId)
		if (!whispers) return

		while (whispers.length > 0) {
			const steeringMessageId = await task.enqueueSteeringMessage(whispers[0])
			this.emitSteeringStatus(sessionId, steeringMessageId, "queued")
			whispers.shift()
		}
		this.pendingWhispers.delete(sessionId)
	}

	unbindPromptTask(sessionId: string): void {
		this.promptTasks.delete(sessionId)
	}

	releasePromptSteeringOwnership(sessionId: string): void {
		this.pendingWhispers.delete(sessionId)
		this.unbindPromptTask(sessionId)
	}

	emitSteeringStatus(sessionId: string, steeringMessageId: string, status: "queued" | "sent"): void {
		this.deps.emitterForSession(sessionId).emit("steering_status", { steeringMessageId, status })
	}

	private bufferWhisper(sessionId: string, text: string): void {
		const whispers = this.pendingWhispers.get(sessionId) ?? []
		whispers.push(text.trim())
		this.pendingWhispers.set(sessionId, whispers)
	}
}
