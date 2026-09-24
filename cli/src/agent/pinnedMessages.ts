import type { DiracMessage } from "@shared/ExtensionMessage"
import { DiracMessageType } from "@shared/ExtensionMessage"
import type { Controller } from "@/core/controller"
import type { Settings } from "@/shared/storage/state-keys"
import {
	getPinnedSessionMessages,
	type PinnedSessionMessage,
	pinSessionMessage,
	unpinSessionMessage,
} from "../acp/acp-session-pins.js"
import { copyTaskRuntimeSettings } from "../acp/acp-session-runtime-config.js"
import type { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import type { DiracAcpSession } from "./public-types.js"

interface PinnedMessagesDeps {
	sessions: Map<string, DiracAcpSession>
	getController(session: DiracAcpSession): Controller | undefined
	emitterForSession(sessionId: string): DiracSessionEmitter
	switchToActMode(sessionId: string): Promise<boolean>
	bindPromptTask(sessionId: string, task: NonNullable<Controller["task"]>): Promise<void>
	getActivePromptOverrides(sessionId: string): Partial<Settings> | undefined
}

/**
 * Owns pinned-message behavior for ACP sessions: pin/unpin/list persistence,
 * the pinned context injected into task initialization options, and the
 * `pinned_messages_update` vendor event.
 */
export class PinnedMessagesManager {
	constructor(private readonly deps: PinnedMessagesDeps) {}

	/** Pin a persisted message snapshot so it remains in every compacted request context. */
	async pinMessage(sessionId: string, messageId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		const task = this.deps.getController(session)?.task
		const message = task?.messageStateHandler.getMessageById(messageId)
		if (!message) throw new Error(`Message not found: ${messageId}`)
		const content = this.pinnedContentFromMessage(message)
		if (!content) throw new Error(`Message cannot be pinned: ${messageId}`)
		pinSessionMessage(sessionId, {
			messageId,
			content,
			pinnedAt: new Date().toISOString(),
		})
		this.applyPinnedContext(task, sessionId)
		await this.emitPinnedMessagesUpdate(sessionId, "pinned")
	}

	async unpinMessage(sessionId: string, messageId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		if (!unpinSessionMessage(sessionId, messageId)) throw new Error(`Message is not pinned: ${messageId}`)
		this.applyPinnedContext(this.deps.getController(session)?.task, sessionId)
		await this.emitPinnedMessagesUpdate(sessionId, "unpinned")
	}

	listPinnedMessages(sessionId: string): PinnedSessionMessage[] {
		if (!this.deps.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
		return getPinnedSessionMessages(sessionId)
	}

	pinnedContextInitializationOptions(sessionId: string, runtimeOverrides?: Partial<Settings>) {
		return {
			pinnedContext: this.pinnedContextForSession(sessionId),
			onContextCompacted: () => void this.emitPinnedMessagesUpdate(sessionId, "compacted"),
			switchToActMode: () => this.deps.switchToActMode(sessionId),
			enqueueSteeringMessages: (task: NonNullable<Controller["task"]>) => this.deps.bindPromptTask(sessionId, task),
			...(runtimeOverrides ? { runtimeConfigurationOverrides: copyTaskRuntimeSettings(runtimeOverrides) } : {}),
		}
	}

	activePromptInitializationOptions(sessionId: string) {
		const activeOverrides = this.deps.getActivePromptOverrides(sessionId)
		if (!activeOverrides) throw new Error(`Active prompt runtime configuration not found: ${sessionId}`)
		return this.pinnedContextInitializationOptions(sessionId, activeOverrides)
	}

	async emitPinnedMessagesUpdate(sessionId: string, event: "pinned" | "unpinned" | "compacted"): Promise<void> {
		this.deps.emitterForSession(sessionId).emit("pinned_messages_update", {
			event,
			messages: getPinnedSessionMessages(sessionId),
		})
	}

	private pinnedContentFromMessage(message: DiracMessage): string | undefined {
		if (message.content.type === DiracMessageType.MARKDOWN) return message.content.content || undefined
		if (message.content.type === DiracMessageType.CARD) return message.content.card.body || message.content.card.header
		return undefined
	}

	private pinnedContextForSession(sessionId: string): string | undefined {
		const pins = getPinnedSessionMessages(sessionId)
		if (pins.length === 0) return undefined
		return [
			"<pinned_messages>",
			...pins.map((pin) => `<message id="${pin.messageId}">\n${pin.content}\n</message>`),
			"</pinned_messages>",
		].join("\n")
	}

	private applyPinnedContext(
		task:
			| {
					taskState: { pinnedContext?: string }
					setContextCompactionObserver: (observer: () => void) => void
			  }
			| undefined,
		sessionId: string,
	): void {
		if (!task) return
		task.taskState.pinnedContext = this.pinnedContextForSession(sessionId)
		task.setContextCompactionObserver(() => void this.emitPinnedMessagesUpdate(sessionId, "compacted"))
	}
}
