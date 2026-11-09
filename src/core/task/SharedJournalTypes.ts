export interface JournalRecord {
	version: 1
	id: string
	author: string
	created_at: number
	headline: string
	content: string
}

export interface JournalNotice {
	author: string
	message_id: string
	headline: string
}

export interface JournalNotificationCounts {
	enqueued: number
	skipped_inactive: number
	rejected_capacity: number
}

export interface JournalPublicationReceipt {
	published: true
	message_id: string
	notifications: JournalNotificationCounts
}

/** Bound by the owning runtime; no caller-supplied author, root, or filesystem path. */
export interface SharedJournalCapability {
	publish(input: { headline: string; content: string }): Promise<JournalPublicationReceipt>
	read(input: { message_id: string }): Promise<JournalRecord>
}

/** Volatile publication-admission identity; not an agent address or stored journal field. */
export interface JournalRecipient {
	readonly id: string
	readonly generation: number
}

export interface SharedJournalCallbacks {
	assertActive(author: string): void
	recipients(author: string): readonly JournalRecipient[]
	notify(recipients: readonly JournalRecipient[], notice: JournalNotice): JournalNotificationCounts
}
