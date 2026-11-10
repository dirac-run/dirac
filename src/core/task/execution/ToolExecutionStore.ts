import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { atomicWriteFile } from "@core/storage/atomicWrite"
import type { ToolExecutionArgumentValue, ToolExecutionOwner, ToolExecutionRecord } from "@shared/toolExecution"
import { z } from "zod"

export interface ToolExecutionStoreSnapshot {
	readonly schemaVersion: 1
	readonly revision: number
	readonly owner: ToolExecutionOwner
	readonly admissionClosed: boolean
	readonly records: readonly ToolExecutionRecord[]
	/** Stable outbox entries live in records[].completionEvent; acknowledgements commit with them. */
	readonly acknowledgedEventIds: readonly string[]
}


/** Upserts and newly acknowledged events; omitted data is retained without copying payloads. */
export interface ToolExecutionStoreUpdate {
	readonly records?: readonly ToolExecutionRecord[]
	readonly admissionClosed?: boolean
	readonly acknowledgeEventIds?: readonly string[]
}

export interface ToolExecutionStore {
	/** Creates and persists an empty revision-zero snapshot if no file exists. Returns an isolated copy. */
	load(): Promise<ToolExecutionStoreSnapshot>
	/** Replaces one coherent snapshot, requiring next.revision === expectedRevision + 1. */
	commit(expectedRevision: number, next: ToolExecutionStoreSnapshot): Promise<void>
	/** Optional incremental protocol. The same CAS and atomic visibility rules apply. */
	commitUpdate?(expectedRevision: number, update: ToolExecutionStoreUpdate): Promise<void>
}

const identifier = z.string().min(1)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ownerSchema = z.object({ rootTaskId: identifier, taskId: identifier, runId: identifier }).strict()
const jsonValue: z.ZodType<ToolExecutionArgumentValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(jsonValue)]),
)
const contentSchema = z.union([
	z.string(),
	z.array(
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("text"), text: z.string() }).catchall(jsonValue),
			z
				.object({
					type: z.literal("image"),
					source: z.discriminatedUnion("type", [
						z
							.object({
								type: z.literal("base64"),
								media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
								data: z.string(),
							})
							.strict(),
						z.object({ type: z.literal("url"), url: z.string() }).strict(),
					]),
				})
				.catchall(jsonValue),
		]),
	),
])
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict()
const workOutcomeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("success"), content: contentSchema }).strict(),
	z.object({ kind: z.literal("failure"), error: errorSchema, content: contentSchema.optional() }).strict(),
	z.object({ kind: z.literal("cancelled"), reason: z.string(), content: contentSchema.optional() }).strict(),
	z.object({ kind: z.literal("interrupted"), reason: z.string(), content: contentSchema.optional() }).strict(),
])
const outcomeSchema = z.union([
	workOutcomeSchema,
	z.object({ kind: z.literal("settlement_failed"), error: errorSchema, operationOutcome: workOutcomeSchema }).strict(),
])
const identitySchema = z
	.object({
		executionId: identifier,
		owner: ownerSchema,
		requestId: identifier,
		nativeToolCallId: identifier.nullable(),
		toolName: identifier,
		toolSnapshot: z
			.object({
				requestId: identifier,
				inventoryVersion: revision,
				configurationRevision: revision.optional(),
			})
			.strict(),
	})
	.strict()
const recordSchema = z
	.object({
		identity: identitySchema,
		arguments: z.record(jsonValue),
		revision,
		state: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("queued") }).strict(),
			z.object({ kind: z.literal("running") }).strict(),
			z.object({ kind: z.literal("waiting_permission"), permissionRequestId: identifier }).strict(),
			z.object({ kind: z.literal("waiting_resource"), resourceId: identifier }).strict(),
			z.object({ kind: z.literal("waiting_input"), inputRequestId: identifier }).strict(),
			z
				.object({
					kind: z.literal("settling"),
					operationOutcome: workOutcomeSchema,
					settlementError: errorSchema.optional(),
				})
				.strict(),
			z.object({ kind: z.literal("terminal"), outcome: outcomeSchema }).strict(),
		]),
		hasStarted: z.boolean(),
		cancellation: z
			.object({ requestedBy: ownerSchema, requestedAt: z.number().finite(), reason: z.string().optional() })
			.strict()
			.nullable(),
		originalResponse: z
			.discriminatedUnion("kind", [
				z.object({ kind: z.literal("accepted"), executionId: identifier, content: contentSchema }).strict(),
				z.object({ kind: z.literal("settled"), executionId: identifier, outcome: outcomeSchema }).strict(),
			])
			.nullable(),
		originalResponseCommitted: z.boolean(),
		completionEvent: z
			.object({
				kind: z.literal("tool_execution_completed"),
				eventId: identifier,
				identity: identitySchema,
				outcome: outcomeSchema,
			})
			.strict()
			.nullable(),
	})
	.strict()
const snapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		revision,
		owner: ownerSchema,
		admissionClosed: z.boolean(),
		records: z.array(recordSchema),
		acknowledgedEventIds: z.array(identifier),
	})
	.strict()

function validateSnapshot(value: unknown, owner: ToolExecutionOwner): ToolExecutionStoreSnapshot {
	const snapshot = snapshotSchema.parse(value)
	if (!isDeepStrictEqual(snapshot.owner, owner)) throw new Error("Tool execution store owner mismatch")
	const executionIds = new Set<string>()
	const nativeCallIds = new Set<string>()
	const eventIds = new Set<string>()
	for (const record of snapshot.records) {
		const { identity, originalResponse, completionEvent, state } = record
		if (!isDeepStrictEqual(identity.owner, owner)) throw new Error("Tool execution record owner mismatch")
		if (identity.requestId !== identity.toolSnapshot.requestId) throw new Error("Tool execution request snapshot mismatch")
		if (executionIds.has(identity.executionId)) throw new Error("Duplicate tool execution identity")
		executionIds.add(identity.executionId)
		if (identity.nativeToolCallId !== null) {
			const nativeCallId = JSON.stringify([identity.requestId, identity.nativeToolCallId])
			if (nativeCallIds.has(nativeCallId)) throw new Error("Duplicate tool execution native call identity")
			nativeCallIds.add(nativeCallId)
		}
		if (state.kind === "running" && !record.hasStarted) throw new Error("Running tool execution has not started")
		if (originalResponse?.executionId !== undefined && originalResponse.executionId !== identity.executionId) {
			throw new Error("Tool execution original response identity mismatch")
		}
		if (record.originalResponseCommitted && originalResponse === null) throw new Error("Committed response is missing")
		if (
			originalResponse?.kind === "settled" &&
			(state.kind !== "terminal" || !isDeepStrictEqual(originalResponse.outcome, state.outcome))
		) {
			throw new Error("Settled response does not match terminal outcome")
		}
		if (completionEvent === null) continue
		const eventId = JSON.stringify([owner.rootTaskId, owner.taskId, owner.runId, identity.executionId, "completion"])
		if (
			completionEvent.eventId !== eventId ||
			!isDeepStrictEqual(completionEvent.identity, identity) ||
			originalResponse?.kind !== "accepted" ||
			!record.originalResponseCommitted ||
			state.kind !== "terminal" ||
			!isDeepStrictEqual(completionEvent.outcome, state.outcome)
		)
			throw new Error("Invalid tool execution completion outbox entry")
		eventIds.add(completionEvent.eventId)
	}
	const acknowledgements = new Set(snapshot.acknowledgedEventIds)
	if (acknowledgements.size !== snapshot.acknowledgedEventIds.length) throw new Error("Duplicate completion acknowledgement")
	for (const eventId of acknowledgements) {
		if (!eventIds.has(eventId)) throw new Error("Acknowledgement has no completion outbox entry")
	}
	return snapshot
}

const digest = z.string().regex(/^[a-f0-9]{64}$/)
function hash(contents: string): string {
	return createHash("sha256").update(contents).digest("hex")
}

const headSchema = z
	.object({
		storageVersion: z.literal(1),
		owner: ownerSchema,
		revision,
		baseRevision: revision,
		baseHash: digest,
		transactionHash: digest,
	})
	.strict()
type StoreHead = z.infer<typeof headSchema>
const updateSchema = z
	.object({
		revision,
		records: z.array(recordSchema).optional(),
		admissionClosed: z.boolean().optional(),
		acknowledgeEventIds: z.array(identifier).optional(),
	})
	.strict()
const transactionSchema = updateSchema.extend({ previousHash: digest })

function applyUpdate(snapshot: ToolExecutionStoreSnapshot, update: ToolExecutionStoreUpdate): ToolExecutionStoreSnapshot {
	const replacements = new Map(update.records?.map((record) => [record.identity.executionId, record]))
	const records = snapshot.records.map((record) => {
		const next = replacements.get(record.identity.executionId) ?? record
		replacements.delete(record.identity.executionId)
		return next
	})
	return {
		...snapshot,
		revision: snapshot.revision + 1,
		admissionClosed: update.admissionClosed ?? snapshot.admissionClosed,
		records: [...records, ...replacements.values()],
		acknowledgedEventIds: [...new Set([...snapshot.acknowledgedEventIds, ...(update.acknowledgeEventIds ?? [])])],
	}
}

/**
 * Sole writer for one root/task/run. No cross-process locking is implied.
 * A transaction is durable before the compact head advances atomically. Files beyond
 * the committed head are orphans, never recovery input. Legacy snapshot commits and
 * loads remain supported; only explicit incremental commits use the journal.
 * Like atomicWriteFile, durability here is rename-based, not power-loss fsync.
 */
export class DiskToolExecutionStore implements ToolExecutionStore {
	private readonly owner: ToolExecutionOwner
	private pending: Promise<void> = Promise.resolve()
	private initialized = false
	private cached?: ToolExecutionStoreSnapshot
	private cachedHead?: StoreHead

	constructor(
		private readonly filePath: string,
		owner: ToolExecutionOwner,
	) {
		this.owner = ownerSchema.parse(owner)
	}

	load(): Promise<ToolExecutionStoreSnapshot> {
		return this.serialize(async () => structuredClone(await this.readSnapshot(true)))
	}

	commit(expectedRevision: number, next: ToolExecutionStoreSnapshot): Promise<void> {
		// Compatibility path deliberately captures the entire caller-owned snapshot.
		const captured = structuredClone(next)
		return this.serialize(async () => {
			revision.parse(expectedRevision)
			const snapshot = validateSnapshot(captured, this.owner)
			if (snapshot.revision !== expectedRevision + 1)
				throw new Error("Tool execution store next revision must increment by one")
			const current = await this.readSnapshot()
			if (current.revision !== expectedRevision) throw new Error("Tool execution store revision conflict")
			await atomicWriteFile(this.filePath, JSON.stringify(snapshot))
			this.cached = snapshot
			this.cachedHead = undefined
		})
	}

	commitUpdate(expectedRevision: number, update: ToolExecutionStoreUpdate): Promise<void> {
		// Capture only this transaction, never any retained result from another execution.
		const captured = structuredClone(update)
		return this.serialize(async () => {
			revision.parse(expectedRevision)
			const transaction = updateSchema.parse({ ...captured, revision: expectedRevision + 1 })
			const document = await this.readDocument()
			const current = await this.snapshotFromDocument(document)
			if (current.revision !== expectedRevision) throw new Error("Tool execution store revision conflict")
			this.validateUpdate(current, transaction)
			const next = applyUpdate(current, transaction)
			const previousHead = "storageVersion" in document ? headSchema.parse(document) : undefined
			const baseRevision = previousHead?.baseRevision ?? current.revision
			await fs.mkdir(this.journalPath(), { recursive: true })
			// The baseline is written once during migration, not at each transition.
			const baseline = previousHead ? undefined : JSON.stringify(current)
			const baseHash = previousHead?.baseHash ?? hash(baseline!)
			if (baseline !== undefined) await atomicWriteFile(this.journalPath(`base-${baseRevision}.json`), baseline)
			const contents = JSON.stringify({ ...transaction, previousHash: previousHead?.transactionHash ?? baseHash })
			await atomicWriteFile(this.journalPath(`${next.revision}.json`), contents)
			const head: StoreHead = {
				storageVersion: 1,
				owner: this.owner,
				revision: next.revision,
				baseRevision,
				baseHash,
				transactionHash: hash(contents),
			}
			await atomicWriteFile(this.filePath, JSON.stringify(head))
			// Neither failed transaction writes nor failed head writes publish in memory.
			this.cached = next
			this.cachedHead = head
		})
	}

	private validateUpdate(current: ToolExecutionStoreSnapshot, update: ToolExecutionStoreUpdate): void {
		// Validate payloads only in changed records. Cross-record constraints inspect
		// identities/event keys, not retained argument or outcome trees.
		const changed = validateSnapshot(
			{ ...current, records: update.records ?? [], acknowledgedEventIds: [] },
			this.owner,
		).records
		const replacements = new Map(changed.map((record) => [record.identity.executionId, record]))
		const nativeCalls = new Set<string>()
		const events = new Set<string>()
		for (const record of [
			...current.records.filter((record) => !replacements.has(record.identity.executionId)),
			...changed,
		]) {
			if (record.identity.nativeToolCallId !== null) {
				const key = JSON.stringify([record.identity.requestId, record.identity.nativeToolCallId])
				if (nativeCalls.has(key)) throw new Error("Duplicate tool execution native call identity")
				nativeCalls.add(key)
			}
			if (record.completionEvent) events.add(record.completionEvent.eventId)
		}
		for (const id of [...current.acknowledgedEventIds, ...(update.acknowledgeEventIds ?? [])]) {
			if (!events.has(id)) throw new Error("Acknowledgement has no completion outbox entry")
		}
	}

	private journalPath(file = ""): string {
		return path.join(`${this.filePath}.transactions`, file)
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation)
		this.pending = result.then(
			() => { },
			() => { },
		)
		return result
	}

	private async readDocument(allowInitialization = false): Promise<Record<string, unknown>> {
		let contents: string
		try {
			contents = await fs.readFile(this.filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			if (this.initialized) throw new Error("Tool execution store snapshot was lost after initialization", { cause: error })
			if (!allowInitialization)
				throw new Error("Tool execution store snapshot is missing; load before committing", { cause: error })
			const initial: ToolExecutionStoreSnapshot = {
				schemaVersion: 1,
				revision: 0,
				owner: { ...this.owner },
				admissionClosed: false,
				records: [],
				acknowledgedEventIds: [],
			}
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await atomicWriteFile(this.filePath, JSON.stringify(initial))
			this.initialized = true
			return { ...initial }
		}
		return z.record(z.unknown()).parse(JSON.parse(contents))
	}

	private async readSnapshot(allowInitialization = false): Promise<ToolExecutionStoreSnapshot> {
		return this.snapshotFromDocument(await this.readDocument(allowInitialization))
	}

	private async snapshotFromDocument(document: Record<string, unknown>): Promise<ToolExecutionStoreSnapshot> {
		if (!("storageVersion" in document)) {
			const snapshot = validateSnapshot(document, this.owner)
			this.initialized = true
			return snapshot
		}
		const head = headSchema.parse(document)
		if (!isDeepStrictEqual(head.owner, this.owner)) throw new Error("Tool execution store owner mismatch")
		if (head.baseRevision > head.revision) throw new Error("Invalid tool execution store base revision")
		if (this.cached && isDeepStrictEqual(this.cachedHead, head)) return this.cached
		const baseline = await fs.readFile(this.journalPath(`base-${head.baseRevision}.json`), "utf8")
		if (hash(baseline) !== head.baseHash) throw new Error("Tool execution store baseline hash mismatch")
		let snapshot = validateSnapshot(JSON.parse(baseline), this.owner)
		if (snapshot.revision !== head.baseRevision) throw new Error("Tool execution store base revision mismatch")
		let previousHash = head.baseHash
		for (let next = head.baseRevision + 1; next <= head.revision; next++) {
			const contents = await fs.readFile(this.journalPath(`${next}.json`), "utf8")
			const transaction = transactionSchema.parse(JSON.parse(contents))
			if (transaction.revision !== next) throw new Error("Tool execution store transaction revision mismatch")
			if (transaction.previousHash !== previousHash) throw new Error("Tool execution store transaction hash mismatch")
			this.validateUpdate(snapshot, transaction)
			snapshot = applyUpdate(snapshot, transaction)
			previousHash = hash(contents)
		}
		if (previousHash !== head.transactionHash) throw new Error("Tool execution store committed hash mismatch")
		this.cached = snapshot
		this.cachedHead = head
		this.initialized = true
		return snapshot
	}
}
