import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { Logger } from "@/shared/services/Logger.js"
import { DIRAC_CLI_DIR } from "../utils/path.js"

const LEGACY_SESSION_UPDATES_FILE = path.join(DIRAC_CLI_DIR.data, "acp-session-updates.json")
const SESSION_UPDATES_DIRECTORY = path.join(DIRAC_CLI_DIR.data, "acp-session-updates")
const MIGRATION_LOCK_DIRECTORY = path.join(DIRAC_CLI_DIR.data, "acp-session-updates.migration.lock")
export const SEQUENCE_META_KEY = "dev.dirac/seq"
const JOURNAL_EXTENSION = ".jsonl"
const LEGACY_ISOLATED_EXTENSION = ".json"
const ARCHIVE_EXTENSION = ".migrated"
const DEFAULT_MAX_JOURNAL_BYTES = 32 * 1024 * 1024
const JOURNAL_COMPACTION_RETAIN_RATIO = 0.75
const TAIL_READ_BYTES = 64 * 1024
const LOCK_WAIT_TIMEOUT_MS = 15_000
const LOCK_ORPHAN_GRACE_MS = 30_000
const LOCK_RETRY_INTERVAL_MS = 10
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4))

type SessionUpdateWithMeta = acp.SessionUpdate & { _meta?: Record<string, unknown> }

export type PersistedSessionUpdate =
	| {
		kind: "session_update"
		sequenceNumber: number
		update: SessionUpdateWithMeta
	}
	| {
		kind: "client_annotation"
		sequenceNumber: number
		annotation: Record<string, unknown>
	}

type LegacyPersistedSessionUpdate =
	| PersistedSessionUpdate
	| {
		kind: "usage_update"
		sequenceNumber: number
		usage: Record<string, unknown>
	}

type LegacySessionUpdatesMap = Record<string, LegacyPersistedSessionUpdate[]>

type LockOwner = {
	pid: number
	createdAt: number
}

function maximumJournalBytes(): number {
	const configured = process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES
	if (configured === undefined) return DEFAULT_MAX_JOURNAL_BYTES

	const parsed = Number(configured)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`DIRAC_ACP_SESSION_UPDATES_MAX_BYTES must be a positive integer, received ${JSON.stringify(configured)}`)
	}
	return parsed
}

function digestFor(sessionId: string): string {
	return crypto.createHash("sha256").update(sessionId).digest("hex")
}

function journalFilePath(sessionId: string): string {
	return path.join(SESSION_UPDATES_DIRECTORY, `${digestFor(sessionId)}${JOURNAL_EXTENSION}`)
}

function legacyIsolatedJournalPath(sessionId: string): string {
	return path.join(SESSION_UPDATES_DIRECTORY, `${digestFor(sessionId)}${LEGACY_ISOLATED_EXTENSION}`)
}

function sessionLockDirectory(sessionId: string): string {
	return `${journalFilePath(sessionId)}.lock`
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function malformedJournalError(filePath: string, error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error)
	return new Error(
		`Malformed ACP session update journal at ${filePath}: ${detail}. ` +
		"Dirac will not overwrite or reset this file; move it aside for recovery or repair the JSON before retrying.",
	)
}

function validatePersistedUpdate(value: unknown, previousSequenceNumber: number, filePath: string): PersistedSessionUpdate {
	if (!isObject(value)) throw malformedJournalError(filePath, new Error("expected an object"))
	if (!Number.isSafeInteger(value.sequenceNumber) || (value.sequenceNumber as number) <= previousSequenceNumber) {
		throw malformedJournalError(filePath, new Error(`non-monotonic sequenceNumber ${JSON.stringify(value.sequenceNumber)}`))
	}

	if (value.kind === "session_update") {
		if (!isObject(value.update)) throw malformedJournalError(filePath, new Error("session update has no update payload"))
		return value as unknown as PersistedSessionUpdate
	}
	if (value.kind === "client_annotation") {
		if (!isObject(value.annotation)) {
			throw malformedJournalError(filePath, new Error("client annotation has no annotation payload"))
		}
		return value as unknown as PersistedSessionUpdate
	}
	throw malformedJournalError(filePath, new Error(`unknown kind ${JSON.stringify(value.kind)}`))
}

function validateUpdateArray(updates: unknown, allowLegacyUsageUpdates: boolean): void {
	if (!Array.isArray(updates)) {
		throw new Error("expected an array of persisted updates")
	}

	let previousSequenceNumber = 0
	for (const [index, update] of updates.entries()) {
		if (!isObject(update)) {
			throw new Error(`update ${index} is not an object`)
		}
		if (!Number.isSafeInteger(update.sequenceNumber) || (update.sequenceNumber as number) <= previousSequenceNumber) {
			throw new Error(`update ${index} has a non-monotonic sequenceNumber`)
		}
		previousSequenceNumber = update.sequenceNumber as number

		if (update.kind === "session_update") {
			if (!isObject(update.update)) throw new Error(`session update ${index} has no update payload`)
			continue
		}
		if (update.kind === "client_annotation") {
			if (!isObject(update.annotation)) throw new Error(`client annotation ${index} has no annotation payload`)
			continue
		}
		if (allowLegacyUsageUpdates && update.kind === "usage_update") {
			if (!isObject(update.usage)) throw new Error(`legacy usage update ${index} has no usage payload`)
			continue
		}
		throw new Error(`update ${index} has unknown kind ${JSON.stringify(update.kind)}`)
	}
}

function validateLegacyUpdates(updates: unknown): asserts updates is LegacyPersistedSessionUpdate[] {
	validateUpdateArray(updates, true)
}

function parseJournalJson(filePath: string, contents: string): unknown {
	try {
		return JSON.parse(contents)
	} catch (error) {
		throw malformedJournalError(filePath, error)
	}
}

function leadingJsonObjectEnd(contents: string): number | undefined {
	let index = 0
	while (index < contents.length && /\s/.test(contents[index])) index += 1
	if (contents[index] !== "{") return undefined

	const closingDelimiters = ["}"]
	let insideString = false
	let escaped = false
	for (index += 1; index < contents.length; index += 1) {
		const character = contents[index]
		if (insideString) {
			if (escaped) {
				escaped = false
				continue
			}
			if (character === "\\") {
				escaped = true
				continue
			}
			if (character === '"') insideString = false
			continue
		}

		if (character === '"') {
			insideString = true
			continue
		}
		if (character === "{") {
			closingDelimiters.push("}")
			continue
		}
		if (character === "[") {
			closingDelimiters.push("]")
			continue
		}
		if (character !== "}" && character !== "]") continue
		if (closingDelimiters.at(-1) !== character) return undefined
		closingDelimiters.pop()
		if (closingDelimiters.length === 0) return index + 1
	}
	return undefined
}

function parseLegacyJournalJson(contents: string): { parsed: unknown; hadTrailingData: boolean } {
	try {
		return { parsed: JSON.parse(contents), hadTrailingData: false }
	} catch (error) {
		const leadingObjectEnd = leadingJsonObjectEnd(contents)
		if (leadingObjectEnd === undefined || contents.slice(leadingObjectEnd).trim() === "") {
			throw malformedJournalError(LEGACY_SESSION_UPDATES_FILE, error)
		}
		try {
			return { parsed: JSON.parse(contents.slice(0, leadingObjectEnd)), hadTrailingData: true }
		} catch {
			throw malformedJournalError(LEGACY_SESSION_UPDATES_FILE, error)
		}
	}
}

// ---------------------------------------------------------------- locking

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ESRCH") return false
		if (code === "EPERM") return true
		throw error
	}
}

function removeAbandonedLock(lockDirectory: string): boolean {
	let owner: LockOwner | undefined
	try {
		owner = JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")) as LockOwner
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
	}

	if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
		if (processIsAlive(owner.pid)) return false
		fs.rmSync(lockDirectory, { recursive: true, force: true })
		return true
	}

	let age: number
	try {
		age = Date.now() - fs.statSync(lockDirectory).mtimeMs
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
		throw error
	}
	if (age < LOCK_ORPHAN_GRACE_MS) return false
	fs.rmSync(lockDirectory, { recursive: true, force: true })
	return true
}

function acquireLock(lockDirectory: string): void {
	fs.mkdirSync(path.dirname(lockDirectory), { recursive: true })
	const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
	while (true) {
		try {
			fs.mkdirSync(lockDirectory)
			try {
				fs.writeFileSync(
					path.join(lockDirectory, "owner.json"),
					JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies LockOwner),
					{ encoding: "utf8", mode: 0o600 },
				)
			} catch (error) {
				fs.rmSync(lockDirectory, { recursive: true, force: true })
				throw error
			}
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			if (removeAbandonedLock(lockDirectory)) continue
			if (Date.now() >= deadline) {
				throw new Error(`Timed out after ${LOCK_WAIT_TIMEOUT_MS} ms waiting for ACP persistence lock ${lockDirectory}`)
			}
			Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, LOCK_RETRY_INTERVAL_MS)
		}
	}
}

function withLock<T>(lockDirectory: string, action: () => T): T {
	acquireLock(lockDirectory)
	try {
		return action()
	} finally {
		fs.rmSync(lockDirectory, { recursive: true, force: true })
	}
}

// ------------------------------------------------------------- JSONL I/O

function serializeRow(entry: PersistedSessionUpdate): string {
	return `${JSON.stringify(entry)}\n`
}

/**
 * Read every committed journal entry. The final line is tolerated if it is not
 * newline-terminated and does not parse — that is a torn append from a crashed
 * writer, not file corruption. Any other malformed line is real corruption.
 */
function readJournalEntries(filePath: string): PersistedSessionUpdate[] {
	let contents: string
	try {
		contents = fs.readFileSync(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}

	const entries: PersistedSessionUpdate[] = []
	const lines = contents.split("\n")
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim()
		if (line === "") continue

		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch (error) {
			if (index === lines.length - 1) {
				// A final line without a trailing newline that does not parse is a
				// torn append from a crashed writer, not file corruption.
				continue
			}
			throw malformedJournalError(filePath, error)
		}
		const previousSequenceNumber = entries.at(-1)?.sequenceNumber ?? 0
		entries.push(validatePersistedUpdate(parsed, previousSequenceNumber, filePath))
	}
	return entries
}

/**
 * Return the highest committed sequence number by reading only the end of the
 * file, so appends stay O(1) regardless of journal size. The window grows only
 * enough to delimit a full trailing line, so a single row larger than the
 * window (e.g. a huge message) is still read correctly. Returns 0 for absent,
 * empty, or entirely-torn journals.
 */
function readLastSequence(filePath: string): number {
	let size: number
	try {
		size = fs.statSync(filePath).size
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}
	if (size === 0) return 0

	const descriptor = fs.openSync(filePath, "r")
	try {
		let windowBytes = Math.min(TAIL_READ_BYTES, size)
		while (true) {
			const readStart = size - windowBytes
			const buffer = Buffer.alloc(windowBytes)
			fs.readSync(descriptor, buffer, 0, windowBytes, readStart)

			// Slicing at newline byte boundaries avoids splitting a multibyte
			// UTF-8 character when the window opens mid-line.
			const lastNewline = buffer.lastIndexOf(0x0a)
			const secondToLastNewline = lastNewline === -1 ? -1 : buffer.lastIndexOf(0x0a, lastNewline - 1)
			if (readStart > 0 && secondToLastNewline === -1) {
				// The window cannot yet delimit a full trailing line (either it
				// is entirely inside one oversized row, or only its final newline
				// is captured). Grow the window until the previous line is reachable.
				windowBytes = Math.min(windowBytes * 2, size)
				continue
			}

			const lineStart = secondToLastNewline === -1 ? 0 : secondToLastNewline + 1
			// The region after the previous line's newline holds the last complete
			// line plus any torn tail; scan its lines from the end.
			const lines = buffer.subarray(lineStart).toString("utf8").split("\n")
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const line = lines[index].trim()
				if (line === "") continue
				try {
					const parsed = JSON.parse(line) as PersistedSessionUpdate
					if (isObject(parsed) && Number.isSafeInteger(parsed.sequenceNumber)) {
						return parsed.sequenceNumber
					}
				} catch {
					// torn or truncated tail line; scan backwards
				}
			}
			return 0
		}
	} finally {
		fs.closeSync(descriptor)
	}
}

function fsyncDirectory(directoryPath: string): void {
	let descriptor: number | undefined
	try {
		descriptor = fs.openSync(directoryPath, "r")
		fs.fsyncSync(descriptor)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (process.platform === "win32" && (code === "EINVAL" || code === "EPERM" || code === "EISDIR")) return
		throw error
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor)
	}
}

function atomicWriteRows(filePath: string, entries: PersistedSessionUpdate[]): void {
	fs.mkdirSync(SESSION_UPDATES_DIRECTORY, { recursive: true })
	const serialized = entries.map(serializeRow).join("")
	const temporaryPath = path.join(
		SESSION_UPDATES_DIRECTORY,
		`.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	)
	let descriptor: number | undefined
	try {
		descriptor = fs.openSync(temporaryPath, "wx", 0o600)
		fs.writeFileSync(descriptor, serialized, "utf8")
		fs.fsyncSync(descriptor)
		fs.closeSync(descriptor)
		descriptor = undefined
		fs.renameSync(temporaryPath, filePath)
		fsyncDirectory(SESSION_UPDATES_DIRECTORY)
	} catch (error) {
		if (descriptor !== undefined) fs.closeSync(descriptor)
		try {
			fs.unlinkSync(temporaryPath)
		} catch (cleanupError) {
			if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError
		}
		throw error
	}
}

/**
 * Append one newline-terminated row and return the resulting file size.
 * Opening with "a" positions the write at the end, so appends never rewrite
 * the existing content.
 */
function appendRow(filePath: string, row: string): number {
	fs.mkdirSync(SESSION_UPDATES_DIRECTORY, { recursive: true })
	const descriptor = fs.openSync(filePath, "a", 0o600)
	try {
		fs.writeFileSync(descriptor, row, "utf8")
		fs.fsyncSync(descriptor)
		return fs.fstatSync(descriptor).size
	} finally {
		fs.closeSync(descriptor)
	}
}

/**
 * When the journal exceeds its size budget, drop the oldest entries and
 * retain at most 75% of the budget. Leaving headroom prevents a full journal
 * parse and rewrite on every streamed chunk once a long session reaches the
 * limit. Sequence numbers are preserved; a single oversized entry is kept.
 *
 * Compaction is best-effort size maintenance, deliberately run after the append
 * has already been durably written: a failure here only leaves the journal over
 * budget and must not fail the write that already succeeded.
 */
function compactIfNeeded(filePath: string, size: number): void {
	const maximumBytes = maximumJournalBytes()
	if (size <= maximumBytes) return

	const entries = readJournalEntries(filePath)
	if (entries.length <= 1) return

	const lengths = entries.map((entry) => Buffer.byteLength(serializeRow(entry)))
	let total = lengths.reduce((sum, length) => sum + length, 0)
	let drop = 0
	const targetBytes = Math.floor(maximumBytes * JOURNAL_COMPACTION_RETAIN_RATIO)
	while (drop < entries.length - 1 && total > targetBytes) {
		total -= lengths[drop]
		drop += 1
	}
	if (drop === 0) return

	try {
		atomicWriteRows(filePath, entries.slice(drop))
	} catch (error) {
		Logger.error(`[acp-session-updates] failed to compact journal ${filePath}:`, error)
	}
}

// ------------------------------------------------------------- migration

function readLegacySessionUpdatesMap(): { sessionUpdates: LegacySessionUpdatesMap; hadTrailingData: boolean } {
	const contents = fs.readFileSync(LEGACY_SESSION_UPDATES_FILE, "utf8")
	const { parsed, hadTrailingData } = parseLegacyJournalJson(contents)
	try {
		if (!isObject(parsed)) throw new Error("expected a JSON object keyed by session ID")
		for (const [sessionId, updates] of Object.entries(parsed)) {
			try {
				validateLegacyUpdates(updates)
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				throw new Error(`session ${JSON.stringify(sessionId)}: ${detail}`)
			}
		}
		return { sessionUpdates: parsed as LegacySessionUpdatesMap, hadTrailingData }
	} catch (error) {
		throw malformedJournalError(LEGACY_SESSION_UPDATES_FILE, error)
	}
}

function finalizeLegacyJournalMigration(hadTrailingData: boolean): void {
	if (hadTrailingData) {
		const recoveryPath = `${LEGACY_SESSION_UPDATES_FILE}.recovery-${Date.now()}-${crypto.randomUUID()}`
		fs.renameSync(LEGACY_SESSION_UPDATES_FILE, recoveryPath)
	} else {
		fs.unlinkSync(LEGACY_SESSION_UPDATES_FILE)
	}
	fsyncDirectory(path.dirname(LEGACY_SESSION_UPDATES_FILE))
}

function currentUpdatesFromLegacy(updates: LegacyPersistedSessionUpdate[]): PersistedSessionUpdate[] {
	return updates.filter((update): update is PersistedSessionUpdate => update.kind !== "usage_update")
}

/**
 * Convert an old per-session object journal (`{version, sessionId, updates}`,
 * written by the previous design) into the newline-delimited journal. A missing
 * journal is a no-op; when the newline journal already exists it wins and the
 * legacy file is archived. A corrupt or invalid legacy journal is archived
 * (bytes preserved for recovery) rather than thrown on every write, so it cannot
 * stall the session or spam error logs.
 */
function migrateLegacyIsolatedJournal(sessionId: string): void {
	const legacyPath = legacyIsolatedJournalPath(sessionId)
	if (!fs.existsSync(legacyPath)) return

	if (fs.existsSync(journalFilePath(sessionId))) {
		archiveLegacyIsolatedJournal(sessionId)
		return
	}

	try {
		const parsed = parseJournalJson(legacyPath, fs.readFileSync(legacyPath, "utf8"))
		if (!isObject(parsed) || !Array.isArray(parsed.updates)) {
			throw new Error("expected a JSON object with an updates array")
		}
		const entries: PersistedSessionUpdate[] = []
		let previousSequenceNumber = 0
		for (const update of parsed.updates) {
			entries.push(validatePersistedUpdate(update, previousSequenceNumber, legacyPath))
			previousSequenceNumber = (update as PersistedSessionUpdate).sequenceNumber
		}
		atomicWriteRows(journalFilePath(sessionId), entries)
	} catch (error) {
		Logger.error(`[acp-session-updates] discarding unreadable legacy journal ${legacyPath}:`, error)
	}
	archiveLegacyIsolatedJournal(sessionId)
}

function archiveLegacyIsolatedJournal(sessionId: string): void {
	const legacyPath = legacyIsolatedJournalPath(sessionId)
	fs.renameSync(legacyPath, `${legacyPath}${ARCHIVE_EXTENSION}.${Date.now()}-${crypto.randomUUID()}`)
	fsyncDirectory(SESSION_UPDATES_DIRECTORY)
}

function migrateLegacySession(sessionId: string, legacyUpdates: PersistedSessionUpdate[]): void {
	withLock(sessionLockDirectory(sessionId), () => {
		if (fs.existsSync(journalFilePath(sessionId))) return
		// A per-session isolated journal (current format) takes precedence over the stale flat file.
		if (fs.existsSync(legacyIsolatedJournalPath(sessionId))) return
		const updates = currentUpdatesFromLegacy(legacyUpdates)
		if (updates.length === 0) return
		atomicWriteRows(journalFilePath(sessionId), updates)
	})
}

function migrateLegacyJournal(): void {
	if (!fs.existsSync(LEGACY_SESSION_UPDATES_FILE)) return

	withLock(MIGRATION_LOCK_DIRECTORY, () => {
		if (!fs.existsSync(LEGACY_SESSION_UPDATES_FILE)) return
		const { sessionUpdates, hadTrailingData } = readLegacySessionUpdatesMap()
		for (const [sessionId, updates] of Object.entries(sessionUpdates)) {
			migrateLegacySession(sessionId, currentUpdatesFromLegacy(updates))
		}
		finalizeLegacyJournalMigration(hadTrailingData)
	})
}

// ------------------------------------------------------------- public API

/**
 * Append one entry to a session's journal under its cross-process lock:
 * compute the next durable sequence from the file tail, write the single row,
 * and compact if over budget. `build` receives the sequence so the caller can
 * stamp it consistently on both the persisted entry and its returned value.
 */
function appendSessionEntry<T>(
	sessionId: string,
	build: (sequenceNumber: number) => { entry: PersistedSessionUpdate; result: T },
): T {
	migrateLegacyJournal()
	return withLock(sessionLockDirectory(sessionId), () => {
		const filePath = journalFilePath(sessionId)
		migrateLegacyIsolatedJournal(sessionId)
		const sequenceNumber = readLastSequence(filePath) + 1
		const { entry, result } = build(sequenceNumber)
		const size = appendRow(filePath, serializeRow(entry))
		compactIfNeeded(filePath, size)
		return result
	})
}

/**
 * Persist one ACP session update with its stable, per-session sequence number.
 * Appends a single line; the previous journal is never re-read or re-written.
 */
export function recordSessionUpdate(sessionId: string, update: acp.SessionUpdate): SessionUpdateWithMeta {
	return appendSessionEntry(sessionId, (sequenceNumber) => {
		const updateWithSequence: SessionUpdateWithMeta = {
			...update,
			_meta: {
				...(update as SessionUpdateWithMeta)._meta,
				[SEQUENCE_META_KEY]: sequenceNumber,
			},
		}
		return {
			entry: { kind: "session_update", sequenceNumber, update: updateWithSequence },
			result: updateWithSequence,
		}
	})
}

/** Persist one client control-plane annotation with its stable, per-session sequence number. */
export function recordClientAnnotation(sessionId: string, annotation: Record<string, unknown>): Record<string, unknown> {
	return appendSessionEntry(sessionId, (sequenceNumber) => {
		const annotationWithSequence = {
			...annotation,
			_meta: {
				...(annotation._meta as Record<string, unknown> | undefined),
				[SEQUENCE_META_KEY]: sequenceNumber,
			},
		}
		return {
			entry: { kind: "client_annotation", sequenceNumber, annotation: annotationWithSequence },
			result: annotationWithSequence,
		}
	})
}

/** Return the immutable ordered ACP update journal for a persisted session. */
export function getSessionUpdates(sessionId: string): PersistedSessionUpdate[] {
	migrateLegacyJournal()
	return withLock(sessionLockDirectory(sessionId), () => {
		const filePath = journalFilePath(sessionId)
		migrateLegacyIsolatedJournal(sessionId)
		return readJournalEntries(filePath)
	})
}

/** Remove the complete ACP update journal for a deleted session. */
export function deleteSessionUpdates(sessionId: string): void {
	migrateLegacyJournal()
	withLock(sessionLockDirectory(sessionId), () => {
		const filePath = journalFilePath(sessionId)
		for (const candidate of [filePath, legacyIsolatedJournalPath(sessionId)]) {
			try {
				fs.unlinkSync(candidate)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		fsyncDirectory(SESSION_UPDATES_DIRECTORY)
	})
}

/**
 * Copy the update journal from one session to another under per-session locks,
 * renumbering sequence numbers and embedded sequence metadata so the forked
 * journal is a valid, self-contained append-only log.
 */
export function copySessionUpdates(sourceSessionId: string, targetSessionId: string): void {
	if (sourceSessionId === targetSessionId) {
		throw new Error(`Cannot copy ACP session updates onto the same session: ${sourceSessionId}`)
	}

	const sourceEntries = getSessionUpdates(sourceSessionId)
	if (sourceEntries.length === 0) return

	withLock(sessionLockDirectory(targetSessionId), () => {
		const filePath = journalFilePath(targetSessionId)
		migrateLegacyIsolatedJournal(targetSessionId)
		const existingLastSequence = readLastSequence(filePath)

		// Renumber 0-based index continuously after existingLastSequence and stamp inner _meta[SEQUENCE_META_KEY].
		const renumbered: PersistedSessionUpdate[] = sourceEntries.map((entry, index) => {
			const sequenceNumber = existingLastSequence + index + 1
			if (entry.kind === "session_update") {
				return {
					kind: "session_update",
					sequenceNumber,
					update: {
						...entry.update,
						_meta: {
							...(isObject(entry.update._meta) ? entry.update._meta : {}),
							[SEQUENCE_META_KEY]: sequenceNumber,
						},
					},
				}
			}
			return {
				kind: "client_annotation",
				sequenceNumber,
				annotation: {
					...entry.annotation,
					_meta: {
						...(isObject(entry.annotation._meta) ? entry.annotation._meta : {}),
						[SEQUENCE_META_KEY]: sequenceNumber,
					},
				},
			}
		})

		const size = appendRow(filePath, renumbered.map(serializeRow).join(""))
		compactIfNeeded(filePath, size)
	})
}
