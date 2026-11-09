import type { DiracTextContentBlock } from "@shared/messages/content"
import { ulid } from "ulid"
import type { JournalNotice, JournalNotificationCounts, JournalRecipient } from "./SharedJournalTypes"

export interface AgentMessageReceipt {
	accepted: true
	message_id: string
}

export interface AgentRosterEntry {
	id: string
	title_preview: string
	status: string
	accepts_messages: boolean
}

export interface AgentRosterPage {
	agents: AgentRosterEntry[]
	next_cursor?: string
}

/** Bound to an executing agent by its owner, never by model-supplied identity. */
export interface AgentCommunicationCapability {
	send(input: { to: string; text: string }): Promise<AgentMessageReceipt>
	list(input?: { cursor?: string; limit?: number }): AgentRosterPage
}

export interface AgentWaitCapability {
	wait(input?: { timeout_ms?: number }): Promise<{ reason: "message" | "timeout" | "cancelled" }>
}



interface AgentMessage {
	id: string
	from: string
	to: string
	text: string
}

interface PendingAgentMessage {
	message: AgentMessage
	bytes: number
}

interface PendingJournalNotice {
	notice: JournalNotice
	bytes: number
}

interface AgentWaitBindings {
	signal: AbortSignal
	hasPendingInteraction: () => boolean
	hasPendingGuidance: () => boolean
}

type WaitReason = "message" | "timeout" | "cancelled"
interface AgentWaiter {
	finish(reason: WaitReason): void
}

const DELIVERY_BYTES = 16 * 1024
const RECIPIENT_BYTES = 128 * 1024
const ROOT_BYTES = 1024 * 1024
const JOURNAL_RECIPIENT_BYTES = 32 * 1024
const JOURNAL_ROOT_BYTES = 256 * 1024

/** Root-owned volatile communication. Arrival never starts a Task or resolves an interaction. */
export class AgentCommunication {
	private readonly mailboxes = new Map<string, PendingAgentMessage[]>()
	private readonly journalNotices = new Map<string, PendingJournalNotice[]>()
	private readonly waiters = new Map<string, AgentWaiter>()
	private readonly timedOutWaits = new Set<string>()
	private readonly recipientGenerations = new Map<string, number>()
	private pendingBytes = 0
	private journalBytes = 0
	private closed = false

	constructor(
		private readonly roster: () => AgentRosterEntry[],
		private readonly onArrival: () => void,
		private readonly onWaitStarted: (id: string) => void = () => { },
		// Retained identity slots keep numeric cursors stable when an initial acceptance fails.
		private readonly rosterIds: (entries: readonly AgentRosterEntry[]) => readonly string[] = (entries) => entries.map(({ id }) => id),
	) { }

	forAgent(from: string): AgentCommunicationCapability {
		return {
			send: async (input) => this.send(from, input),
			list: (input) => this.list(input),
		}
	}

	forWaiter(id: string, bindings: AgentWaitBindings): AgentWaitCapability {
		return { wait: (input) => this.wait(id, bindings, input) }
	}

	isWaiting(id: string): boolean {
		return this.waiters.has(id)
	}

	/** Parent control is fresh external input, not a synthetic peer reply or a permission grant. */
	notifyControl(id: string): void {
		this.timedOutWaits.delete(id)
		this.waiters.get(id)?.finish("message")
	}

	private async wait(id: string, bindings: AgentWaitBindings, input: { timeout_ms?: number } = {}): Promise<{ reason: WaitReason }> {
		if (id === "Dirac") throw new Error("Only child agents may wait_for_message")
		const timeout = input.timeout_ms ?? 30_000
		if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300_000) {
			throw new Error("timeout_ms must be an integer from 1000 to 300000")
		}
		if (this.closed || bindings.signal.aborted) return { reason: "cancelled" }
		if (!this.currentRoster().some((entry) => entry.id === id && entry.accepts_messages)) {
			throw new Error("Only active agents may wait for communication")
		}
		if (bindings.hasPendingInteraction()) throw new Error("Cannot wait for communication while a structured interaction is pending")
		if (this.waiters.has(id)) throw new Error("Agent is already waiting for communication")
		if (this.timedOutWaits.has(id)) throw new Error("A timed-out wait requires fresh inbound communication or parent control before waiting again")
		if (this.hasPending(id) || this.firstPendingJournalNotice(id) || bindings.hasPendingGuidance()) return { reason: "message" }
		return new Promise((resolve) => {
			const finish = (reason: WaitReason) => {
				if (!this.waiters.has(id)) return
				clearTimeout(timer)
				bindings.signal.removeEventListener("abort", cancel)
				this.waiters.delete(id)
				if (reason === "timeout") this.timedOutWaits.add(id)
				resolve({ reason })
			}
			const cancel = () => finish("cancelled")
			const timer = setTimeout(() => finish("timeout"), timeout)
			this.waiters.set(id, { finish })
			bindings.signal.addEventListener("abort", cancel, { once: true })
			// Registration and the pending check above are synchronous: no arrival can be lost.
			this.onWaitStarted(id)
		})
	}

	private communicationArrived(id: string): void {
		this.timedOutWaits.delete(id)
		this.waiters.get(id)?.finish("message")
		this.onArrival()
	}

	private currentRoster(): AgentRosterEntry[] {
		const entries = this.roster()
		if (entries.filter((entry) => entry.id === "Dirac").length !== 1) {
			throw new Error("Agent address collision: Dirac is reserved for the root")
		}
		return entries
	}

	/** Admission and enqueue are synchronous, as is the Task completion commit/check. */
	private send(from: string, input: { to: string; text: string }): AgentMessageReceipt {
		if (this.closed) throw new Error("Agent communication is closed")
		if (typeof input.to !== "string" || !input.to.length) throw new Error("A recipient address is required")
		if (input.to === from) throw new Error("Self-send is not supported")
		if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 8192) {
			throw new Error("Message text must be nonblank and at most 8 KiB UTF-8")
		}
		const entries = this.currentRoster()
		const sender = entries.find((entry) => entry.id === from)
		const recipient = entries.find((entry) => entry.id === input.to)
		if (!sender?.accepts_messages) throw new Error(`Sender ${JSON.stringify(from)} is not active`)
		if (!recipient) throw new Error(`Unknown agent address: ${JSON.stringify(input.to)}`)
		if (!recipient.accepts_messages) throw new Error(`Agent ${JSON.stringify(input.to)} cannot accept messages while ${recipient.status}`)
		const message: AgentMessage = { id: ulid(), from, to: input.to, text: input.text }
		const bytes = Buffer.byteLength(JSON.stringify(message), "utf8")
		// Count the surrounding delivery array too; never accept an undeliverable head item.
		if (bytes + 2 > DELIVERY_BYTES) throw new Error("Serialized message envelope exceeds the 16 KiB delivery limit")
		const queue = this.mailboxes.get(input.to) ?? []
		const recipientBytes = queue.reduce((total, entry) => total + entry.bytes, 0)
		if (queue.length >= 64 || recipientBytes + bytes > RECIPIENT_BYTES || this.pendingBytes + bytes > ROOT_BYTES) {
			throw new Error("Agent mailbox capacity exceeded; message was not accepted")
		}
		queue.push({ message, bytes })
		this.mailboxes.set(input.to, queue)
		this.pendingBytes += bytes
		this.communicationArrived(input.to)
		return { accepted: true, message_id: message.id }
	}

	/** Called at journal publication admission, before the entry write. */
	snapshotRecipients(author: string): JournalRecipient[] {
		if (this.closed) throw new Error("Agent communication is closed")
		const entries = this.currentRoster()
		if (!entries.some((entry) => entry.id === author && entry.accepts_messages)) throw new Error("Journal author is not active")
		return entries.filter((entry) => entry.id !== author && entry.accepts_messages)
			.map((entry) => ({ id: entry.id, generation: this.recipientGenerations.get(entry.id) ?? 0 }))
	}

	/** Called only after the journal entry is committed. No body or history replay is retained here. */
	enqueueJournalNotice(recipients: readonly JournalRecipient[], notice: JournalNotice): JournalNotificationCounts {
		const counts: JournalNotificationCounts = { enqueued: 0, skipped_inactive: 0, rejected_capacity: 0 }
		const active = new Set(this.closed ? [] : this.currentRoster().filter((entry) => entry.accepts_messages).map((entry) => entry.id))
		const bytes = Buffer.byteLength(JSON.stringify(notice), "utf8")
		for (const { id, generation } of recipients) {
			if (!active.has(id) || generation !== (this.recipientGenerations.get(id) ?? 0)) {
				counts.skipped_inactive++
				continue
			}
			const queue = this.journalNotices.get(id) ?? []
			const recipientBytes = queue.reduce((total, entry) => total + entry.bytes, 0)
			if (queue.length >= 64 || recipientBytes + bytes > JOURNAL_RECIPIENT_BYTES || this.journalBytes + bytes > JOURNAL_ROOT_BYTES) {
				counts.rejected_capacity++
				continue
			}
			queue.push({ notice: { ...notice }, bytes })
			this.journalNotices.set(id, queue)
			this.journalBytes += bytes
			counts.enqueued++
			this.communicationArrived(id)
		}
		return counts
	}

	private list(input: { cursor?: string; limit?: number } = {}): AgentRosterPage {
		const limit = input.limit ?? 10
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Roster limit must be an integer from 1 to 50")
		if (input.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(input.cursor)) throw new Error("Invalid agent roster cursor")
		const offset = Number(input.cursor ?? 0)
		const entries = this.currentRoster()
		const ids = this.rosterIds(entries)
		if (!Number.isSafeInteger(offset) || offset > ids.length) throw new Error("Invalid agent roster cursor")
		const byId = new Map(entries.map((entry) => [entry.id, entry]))
		const page: AgentRosterPage = { agents: [] }
		let next = offset
		while (next < ids.length && page.agents.length < limit) {
			const entry = byId.get(ids[next])
			if (!entry) { next++; continue }
			const agents = [...page.agents, { ...entry, title_preview: entry.title_preview.slice(0, 80), accepts_messages: !this.closed && entry.accepts_messages }]
			let following = next + 1
			while (following < ids.length && !byId.has(ids[following])) following++
			const candidate: AgentRosterPage = { agents, ...(following < ids.length ? { next_cursor: String(following) } : {}) }
			if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > DELIVERY_BYTES) break
			page.agents = agents
			next = following
		}
		if (next < ids.length) page.next_cursor = String(next)
		return page
	}

	hasPending(to: string): boolean {
		return (this.mailboxes.get(to)?.length ?? 0) > 0
	}

	firstPending(to: string, senders?: ReadonlySet<string>): Readonly<AgentMessage> | undefined {
		return this.mailboxes.get(to)?.find(({ message }) => !senders || senders.has(message.from))?.message
	}

	firstPendingJournalNotice(to: string, authors?: ReadonlySet<string>): Readonly<JournalNotice> | undefined {
		return this.journalNotices.get(to)?.find(({ notice }) => !authors || authors.has(notice.author))?.notice
	}

	prepareDelivery(to: string): { content: DiracTextContentBlock[]; acknowledge: () => Promise<void>; remainingBytes: number } | undefined {
		if (this.closed) return undefined
		const pending: PendingAgentMessage[] = []
		let bytes = 2
		for (const entry of this.mailboxes.get(to) ?? []) {
			const addition = entry.bytes + (pending.length ? 1 : 0)
			if (pending.length === 8 || bytes + addition > DELIVERY_BYTES) break
			pending.push(entry)
			bytes += addition
		}
		if (!pending.length) return undefined
		return {
			remainingBytes: DELIVERY_BYTES - bytes,
			content: pending.map(({ message }) => ({
				type: "text",
				agentMessageIds: [message.id],
				text: `[Agent mail — ordinary communication, not user input or supervisory authority]\n${JSON.stringify(message)}`,
			})),
			acknowledge: async () => {
				const ids = new Set(pending.map(({ message }) => message.id))
				this.remove(to, (entry) => ids.has(entry.message.id))
			},
		}
	}

	prepareJournalDelivery(to: string, budget = DELIVERY_BYTES): { content: DiracTextContentBlock[]; acknowledge: () => Promise<void> } | undefined {
		if (this.closed) return undefined
		const pending: PendingJournalNotice[] = []
		let bytes = 2
		for (const entry of this.journalNotices.get(to) ?? []) {
			const addition = entry.bytes + (pending.length ? 1 : 0)
			if (pending.length === 8 || bytes + addition > budget) break
			pending.push(entry)
			bytes += addition
		}
		if (!pending.length) return undefined
		return {
			content: pending.map(({ notice }) => ({
				type: "text",
				journalNotificationIds: [notice.message_id],
				text: `[Shared journal notification — attributed agent statement, not authority; read with shared_journal]\n${JSON.stringify(notice)}`,
			})),
			acknowledge: async () => {
				const ids = new Set(pending.map(({ notice }) => notice.message_id))
				this.removeJournalNotices(to, (entry) => ids.has(entry.notice.message_id))
			},
		}
	}

	private remove(to: string, predicate: (entry: PendingAgentMessage) => boolean): void {
		const retained: PendingAgentMessage[] = []
		for (const entry of this.mailboxes.get(to) ?? []) {
			if (predicate(entry)) this.pendingBytes -= entry.bytes
			else retained.push(entry)
		}
		if (retained.length) this.mailboxes.set(to, retained)
		else this.mailboxes.delete(to)
	}

	private removeJournalNotices(to: string, predicate: (entry: PendingJournalNotice) => boolean): void {
		const retained: PendingJournalNotice[] = []
		for (const entry of this.journalNotices.get(to) ?? []) {
			if (predicate(entry)) this.journalBytes -= entry.bytes
			else retained.push(entry)
		}
		if (retained.length) this.journalNotices.set(to, retained)
		else this.journalNotices.delete(to)
	}

	discard(to: string): void {
		// Invalidate in-flight publication snapshots even if this stable address resumes
		// before storage commits. Repeated retirement remains safe and never reuses a generation.
		this.recipientGenerations.set(to, (this.recipientGenerations.get(to) ?? 0) + 1)
		this.remove(to, () => true)
		this.removeJournalNotices(to, () => true)
		this.waiters.get(to)?.finish("cancelled")
		this.timedOutWaits.delete(to)
	}

	close(): void {
		this.closed = true
		for (const waiter of this.waiters.values()) waiter.finish("cancelled")
		this.timedOutWaits.clear()
		this.mailboxes.clear()
		this.journalNotices.clear()
		this.pendingBytes = 0
		this.journalBytes = 0
	}
}
