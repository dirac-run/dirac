import type * as acp from "@agentclientprotocol/sdk"
import { Logger } from "@/shared/services/Logger.js"
import { recordSessionUpdate, SEQUENCE_META_KEY } from "../acp/acp-session-updates.js"
import type { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import type { DiracAcpSession } from "./public-types.js"

/**
 * Persists and emits ACP session updates for live sessions.
 *
 * Owns the journal-sequence bookkeeping so persistence failures degrade to
 * ephemeral in-process sequencing instead of crashing the session.
 */
export class SessionUpdateJournal {
	/**
	 * Highest persisted journal sequence per session for this process, used to
	 * synthesize a monotonic sequence when journal persistence fails so the live
	 * ACP emit can continue without crashing the session.
	 */
	private readonly lastJournalSequence = new Map<string, number>()

	constructor(private readonly emitterForSession: (sessionId: string) => DiracSessionEmitter) {}

	async emitSessionInfoUpdate(session: DiracAcpSession): Promise<void> {
		await this.emitSessionUpdate(session.sessionId, {
			sessionUpdate: "session_info_update",
			title: session.title ?? null,
			updatedAt: new Date(session.lastActivityAt).toISOString(),
		})
	}

	async persistAndSendSessionUpdate(
		connection: acp.AgentSideConnection,
		sessionId: string,
		update: acp.SessionUpdate,
	): Promise<void> {
		const persistedUpdate = this.persistSessionUpdate(sessionId, update)
		await connection.sessionUpdate({ sessionId, update: persistedUpdate })
	}

	async emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void> {
		const emitter = this.emitterForSession(sessionId)
		const persistedUpdate = this.persistSessionUpdate(sessionId, update)

		try {
			emitter.emit(persistedUpdate.sessionUpdate, persistedUpdate)
		} catch (error) {
			Logger.debug("[DiracAgent] Error emitting session update:", error)
			emitter.emit("error", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/**
	 * Persist a session update, falling back to an ephemeral, in-process sequence
	 * when the journal cannot be written. A persistence failure must not take down
	 * the live ACP session, so the caller can still emit the update to the client.
	 *
	 * NOTE: the fallback sequence is a best-effort degradation, not durable
	 * ordering. It is only seeded from a successful write, so when persistence
	 * fails from the very first call (e.g. an already over-cap journal) it starts
	 * at 1 and counts up in memory — colliding with the sequence numbers already
	 * persisted in the journal, and resetting on process restart. Acceptable as an
	 * immediate unblock; Step 2 (append-only journal) removes this entirely.
	 */
	persistSessionUpdate(sessionId: string, update: acp.SessionUpdate): ReturnType<typeof recordSessionUpdate> {
		try {
			const persisted = recordSessionUpdate(sessionId, update)
			const sequence = persisted._meta?.[SEQUENCE_META_KEY]
			if (typeof sequence === "number") {
				this.lastJournalSequence.set(sessionId, sequence)
			}
			return persisted
		} catch (error) {
			Logger.error("[DiracAgent] ACP journal persistence failed; emitting session update ephemerally:", error)
			const sequence = (this.lastJournalSequence.get(sessionId) ?? 0) + 1
			this.lastJournalSequence.set(sessionId, sequence)
			return {
				...update,
				_meta: {
					...(update as acp.SessionUpdate & { _meta?: Record<string, unknown> })._meta,
					[SEQUENCE_META_KEY]: sequence,
				},
			}
		}
	}
}
