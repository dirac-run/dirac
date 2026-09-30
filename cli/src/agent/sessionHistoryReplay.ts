import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { isPlanResponseCard } from "@shared/responseTool"
import type { Controller } from "@/core/controller"
import { getSavedDiracMessages } from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger.js"
import { getSessionUpdates } from "../acp/acp-session-updates.js"
import type { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { translateMessage } from "./messageTranslator.js"
import type { DiracAcpSession } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import type { TaskMessageBridge } from "./taskMessageBridge.js"
import type { AcpSessionState } from "./types.js"

interface SessionHistoryReplayDeps {
	sessions: Map<string, DiracAcpSession>
	getController(session: DiracAcpSession): Controller | undefined
	emitterForSession(sessionId: string): DiracSessionEmitter
	bridgeForSession(sessionId: string): TaskMessageBridge
	emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void>
	emitPinnedMessagesUpdate(sessionId: string, event: "pinned" | "unpinned" | "compacted"): Promise<void>
	getClientCapabilities(): acp.ClientCapabilities | undefined
}

/**
 * Replays persisted task history for a loaded ACP session as sessionUpdate
 * events, either from the journaled update log or by re-translating saved
 * Dirac messages.
 */
export class SessionHistoryReplayer {
	constructor(private readonly deps: SessionHistoryReplayDeps) {}

	/**
	 * Replay the historical messages for a loaded session as ACP sessionUpdate events.
	 * Called by AcpAgent after subscribing to session events, so the events reach the client.
	 */
	async replayLoadedSessionHistory(sessionId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) return

		const controller = this.deps.getController(session)
		if (!controller) return

		const taskId = session.loadedTaskId ?? controller.task?.taskId
		if (!taskId) return
		let uiMessages: DiracMessage[]
		try {
			await controller.getTaskWithId(taskId)
			uiMessages = await getSavedDiracMessages(taskId)
		} catch (error) {
			Logger.debug("[DiracAgent] replayLoadedSessionHistory: could not read ui_messages:", error)
			return
		}

		const bridge = this.deps.bridgeForSession(sessionId)
		const persistedUpdates = getSessionUpdates(sessionId)
		if (persistedUpdates.length > 0) {
			const emitter = this.deps.emitterForSession(sessionId)
			for (const persistedUpdate of persistedUpdates) {
				if (persistedUpdate.kind === "session_update") {
					emitter.emit(persistedUpdate.update.sessionUpdate, persistedUpdate.update)
				} else if (persistedUpdate.kind === "client_annotation") {
					emitter.emit("client_annotation", persistedUpdate.annotation)
				}
			}

			const hasPersistedUsageUpdate = persistedUpdates.some(
				(persistedUpdate) =>
					persistedUpdate.kind === "session_update" && persistedUpdate.update.sessionUpdate === "usage_update",
			)
			await bridge.restoreUsage(sessionId, uiMessages, !hasPersistedUsageUpdate)
			await this.deps.emitPinnedMessagesUpdate(sessionId, "compacted")
			return
		}

		// Use a fresh session state for replay — don't pollute the live session's tool call tracking
		const replayState: AcpSessionState = {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		}

		for (const message of uiMessages) {
			try {
				// User-facing input messages that translateMessage skips — emit as user_message_chunk
				if (
					message.content.type === DiracMessageType.MARKDOWN &&
					message.content.role === "user" &&
					message.content.content
				) {
					await this.deps.emitSessionUpdate(sessionId, {
						sessionUpdate: "user_message_chunk",
						content: { type: "text", text: message.content.content },
					} as acp.SessionUpdate)
					continue
				}

				await this.emitPlanFromMessage(sessionId, message)
				const result = translateMessage(message, replayState, {
					clientCapabilities: this.deps.getClientCapabilities(),
				})
				for (const update of result.updates) {
					await this.deps.emitSessionUpdate(sessionId, update)
				}
			} catch (error) {
				Logger.debug("[DiracAgent] replayLoadedSessionHistory: error translating message:", error)
			}
		}
		await bridge.restoreUsage(sessionId, uiMessages, true)
	}

	private async emitPlanFromMessage(sessionId: string, message: DiracMessage): Promise<void> {
		const plan = this.planFromMessage(message)
		if (!plan) return

		await this.deps.emitSessionUpdate(sessionId, { sessionUpdate: "plan", ...plan })
	}

	private planFromMessage(message: DiracMessage): acp.Plan | undefined {
		if (message.content.type !== DiracMessageType.CARD || !isPlanResponseCard(message.content.card)) {
			return undefined
		}

		const body = message.content.card.body
		if (!body) return undefined

		const planText = this.planTextFromCard(body).trim()
		const numberedItems = planText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[-*]\s+|^\d+[.)]\s+/.test(line))
			.map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim())
			.filter(Boolean)
		const planItems = numberedItems.length > 0 ? numberedItems : planText ? [planText] : []
		const status = this.planStatusFromCard(message.content.card.status)
		const entries: acp.PlanEntry[] = planItems.map((content, index) => ({
			content,
			priority: index === 0 ? "high" : "medium",
			status,
		}))

		return entries.length > 0 ? { entries } : undefined
	}

	private planStatusFromCard(status: CardStatus): acp.PlanEntryStatus {
		if (status === CardStatus.SUCCESS) return "completed"
		if (status === CardStatus.RUNNING || status === CardStatus.BUILDING) return "in_progress"
		return "pending"
	}

	private planTextFromCard(body: string): string {
		try {
			const parsed = JSON.parse(body) as { response?: unknown }
			return typeof parsed.response === "string" ? parsed.response : body
		} catch {
			return body
		}
	}
}
