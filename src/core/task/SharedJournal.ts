import fs from "node:fs/promises"
import path from "node:path"
import { ulid } from "ulid"
import { atomicWriteFile } from "../storage/atomicWrite"
import type { JournalPublicationReceipt, JournalRecipient, JournalRecord, SharedJournalCallbacks, SharedJournalCapability } from "./SharedJournalTypes"

const MAX_RECORD_BYTES = 32 * 1024
const RECORD_KEYS = ["version", "id", "author", "created_at", "headline", "content"]

/** One root-owned immutable journal. Notices are volatile and belong to the runtime, not storage. */
export class SharedJournal {
	private readonly pending = new Set<Promise<unknown>>()
	private closed = false
	private closing?: Promise<void>

	constructor(private readonly rootDirectory: string, private readonly callbacks: SharedJournalCallbacks) { }

	forAgent(author: string): SharedJournalCapability {
		return {
			publish: (input) => this.publish(author, input),
			read: (input) => this.read(author, input),
		}
	}

	private assertAdmission(author: string): void {
		if (this.closed) throw new Error("Shared journal is closed")
		this.callbacks.assertActive(author)
	}

	private async publish(author: string, input: { headline: string; content: string }): Promise<JournalPublicationReceipt> {
		this.assertAdmission(author)
		validateText(input.headline, "headline", 256)
		validateText(input.content, "content", 16 * 1024)
		const record: JournalRecord = { version: 1, id: ulid(), author, created_at: Date.now(), headline: input.headline, content: input.content }
		const serialized = JSON.stringify(record)
		if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) throw new Error("Serialized journal record exceeds 32 KiB")
		const recipients = [...this.callbacks.recipients(author)]
		return this.track(this.storeAndNotify(record, serialized, recipients))
	}

	private async storeAndNotify(record: JournalRecord, serialized: string, recipients: readonly JournalRecipient[]): Promise<JournalPublicationReceipt> {
		const directory = path.join(this.rootDirectory, "journal")
		await fs.mkdir(directory, { recursive: true })
		await atomicWriteFile(path.join(directory, `${record.id}.json`), serialized)
		const notifications = this.callbacks.notify(recipients, { author: record.author, message_id: record.id, headline: record.headline })
		return { published: true, message_id: record.id, notifications }
	}

	private async read(author: string, input: { message_id: string }): Promise<JournalRecord> {
		this.assertAdmission(author)
		validateId(input.message_id)
		return this.track(this.readRecord(input.message_id))
	}

	private async readRecord(id: string): Promise<JournalRecord> {
		const file = await fs.open(path.join(this.rootDirectory, "journal", `${id}.json`), "r")
		try {
			const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
			let size = 0
			while (size < buffer.length) {
				const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
				if (!bytesRead) break
				size += bytesRead
			}
			if (size > MAX_RECORD_BYTES) throw new Error("Stored journal record exceeds 32 KiB")
			return validateRecord(JSON.parse(buffer.subarray(0, size).toString("utf8")), id)
		} finally {
			await file.close()
		}
	}

	private track<T>(operation: Promise<T>): Promise<T> {
		this.pending.add(operation)
		void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
		return operation
	}

	/** Close admission synchronously, then join all admitted reads/writes; this is not fsync durability. */
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.closing = this.joinPending()
		return this.closing
	}

	private async joinPending(): Promise<void> {
		const results = await Promise.allSettled([...this.pending])
		const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
		if (errors.length) throw new AggregateError(errors, "Shared journal operations failed during shutdown")
	}
}

function validateText(value: unknown, field: string, maximumBytes: number): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonblank text`)
	if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`)
}

function validateId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)) throw new Error("Invalid journal message_id")
}

function validateRecord(value: unknown, expectedId: string): JournalRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid journal record")
	const record = value as Record<string, unknown>
	if (Object.keys(record).length !== RECORD_KEYS.length || Object.keys(record).some((key) => !RECORD_KEYS.includes(key))) {
		throw new Error("Invalid journal record fields")
	}
	if (record.version !== 1) throw new Error("Unsupported journal record version")
	validateId(record.id)
	if (record.id !== expectedId) throw new Error("Journal record identity mismatch")
	if (typeof record.author !== "string" || !record.author.trim()) throw new Error("Invalid journal author")
	if (typeof record.created_at !== "number" || !Number.isSafeInteger(record.created_at) || record.created_at < 0) {
		throw new Error("Invalid journal timestamp")
	}
	validateText(record.headline, "headline", 256)
	validateText(record.content, "content", 16 * 1024)
	return { version: 1, id: record.id, author: record.author, created_at: record.created_at, headline: record.headline, content: record.content }
}
