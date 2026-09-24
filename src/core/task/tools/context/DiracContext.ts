import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import Mutex from "p-mutex"
import { z } from "zod"
import { safeParseJson } from "@/shared/safe-json-parse"
import { StateManager } from "../../../storage/StateManager"
import { GlobalFileNames } from "../../../storage/fileNames"
import {
	appendOperationRecords,
	archiveOperationLog,
	operationLogExceedsBaselineThreshold,
	replayOperationRecords,
	writeFramedBaseline,
} from "../../../storage/operationLog"
import { AnchorStateManager, PersistedAnchorDocument, PersistedAnchorState } from "@utils/AnchorStateManager"
import { IDiracContext } from "../interfaces/IDiracContext"

const ANCHOR_STATE_KEY = "anchorState"
const MAX_PENDING_OPERATION_BYTES = 2 * 1024 * 1024

type ToolContextOperation =
	| { offset: number; type: "set"; key: string; value: unknown }
	| { offset: number; type: "update_entries"; key: string; updates: Record<string, unknown>; deletions: string[] }
	| { offset: number; type: "set_anchor_document"; document: PersistedAnchorDocument }
	| { offset: number; type: "delete_anchor_document"; absolutePath: string }
	| { offset: number; type: "reset"; values: Record<string, unknown> }

type PendingToolContextOperation<T = ToolContextOperation> = T extends ToolContextOperation ? Omit<T, "offset"> : never

type ToolContextBaselineRecord =
	| { type: "baseline"; offset: number }
	| { type: "value"; key: string; value: unknown }
	| { type: "entry"; key: string; entryKey: string; value: unknown }
	| { type: "anchor"; version: 1 }
	| { type: "anchor_document"; document: PersistedAnchorDocument }

export class DiracContext implements IDiracContext {
	private taskData: Record<string, any> = {}
	private taskPath: string
	private baselinePath: string
	private operationPath: string
	private loaded = false
	private anchorStateLoaded = false
	private operationOffset = -1
	private pendingOperations: ToolContextOperation[] = []
	private pendingOperationBytes = 0
	private dirtyAnchorPaths = new Set<string>()
	private completeAnchorStateDirty = false
	private stateMutex = new Mutex()

	constructor(
		private taskId: string,
		private stateManager: StateManager,
		private conversationUlid: string,
	) {
		const diracHome = process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac")
		const taskDirectory = path.join(diracHome, "data", "tasks", taskId)
		this.taskPath = path.join(taskDirectory, GlobalFileNames.toolContext)
		this.baselinePath = path.join(taskDirectory, GlobalFileNames.toolContextBaseline)
		this.operationPath = path.join(taskDirectory, GlobalFileNames.toolContextOperations)
	}

	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	private async loadTaskData(): Promise<void> {
		if (this.loaded) return
		const baseline = await this.readBaseline()
		this.taskData = baseline.values
		this.operationOffset = baseline.offset
		await replayOperationRecords<ToolContextOperation>(this.operationPath, (operation) => {
			if (operation.offset <= this.operationOffset) return
			if (
				!Number.isSafeInteger(operation.offset) ||
				(operation.offset !== this.operationOffset + 1 && operation.type !== "reset")
			) {
				throw new Error(`Non-contiguous tool-context offset ${operation.offset} after ${this.operationOffset}`)
			}
			this.operationOffset = operation.offset
			this.applyOperation(operation)
		})
		this.loaded = true
	}

	private applyOperation(operation: ToolContextOperation): void {
		if (operation.type === "reset") {
			this.taskData = operation.values
			return
		}
		if (operation.type === "set") {
			this.taskData[operation.key] = operation.value
			return
		}
		if (operation.type === "update_entries") {
			const entries = (this.taskData[operation.key] ?? {}) as Record<string, unknown>
			Object.assign(entries, operation.updates)
			for (const key of operation.deletions) delete entries[key]
			this.taskData[operation.key] = entries
			return
		}

		const anchorState = (this.taskData[ANCHOR_STATE_KEY] as PersistedAnchorState | undefined) ?? {
			version: 1,
			documents: [],
		}
		const absolutePath =
			operation.type === "set_anchor_document" ? operation.document.absolutePath : operation.absolutePath
		const documentIndex = anchorState.documents.findIndex((document) => document.absolutePath === absolutePath)
		if (documentIndex !== -1) anchorState.documents.splice(documentIndex, 1)
		if (operation.type === "set_anchor_document") {
			anchorState.documents.push(operation.document)
			if (anchorState.documents.length > AnchorStateManager.MAX_TRACKED_FILES) anchorState.documents.shift()
		}
		this.taskData[ANCHOR_STATE_KEY] = anchorState
	}

	private ensureAnchorStateLoaded(): void {
		if (this.anchorStateLoaded) return
		const persistedAnchorState = this.taskData[ANCHOR_STATE_KEY] as PersistedAnchorState | undefined
		AnchorStateManager.hydrate(this.conversationUlid, persistedAnchorState)
		this.anchorStateLoaded = true
	}

	private queueOperation(operation: PendingToolContextOperation): void {
		const recorded = { offset: ++this.operationOffset, ...operation } as ToolContextOperation
		this.pendingOperations.push(recorded)
		this.pendingOperationBytes += Buffer.byteLength(JSON.stringify(recorded), "utf8")
		if (this.pendingOperationBytes <= MAX_PENDING_OPERATION_BYTES) return
		const reset: ToolContextOperation = {
			offset: ++this.operationOffset,
			type: "reset",
			values: this.snapshotTaskData(),
		}
		this.pendingOperations = [reset]
		this.pendingOperationBytes = Buffer.byteLength(JSON.stringify(reset), "utf8")
	}

	private snapshotTaskData(): Record<string, unknown> {
		const snapshot = structuredClone(this.taskData) as Record<string, unknown>
		if (this.anchorStateLoaded) snapshot[ANCHOR_STATE_KEY] = AnchorStateManager.exportState(this.conversationUlid)
		return snapshot
	}

	private queueAnchorOperations(): void {
		if (this.completeAnchorStateDirty) {
			this.queueOperation({
				type: "set",
				key: ANCHOR_STATE_KEY,
				value: AnchorStateManager.exportState(this.conversationUlid),
			})
			this.completeAnchorStateDirty = false
			this.dirtyAnchorPaths.clear()
			return
		}

		for (const absolutePath of this.dirtyAnchorPaths) {
			const document = AnchorStateManager.exportDocument(absolutePath, this.conversationUlid)
			if (document) this.queueOperation({ type: "set_anchor_document", document })
			else this.queueOperation({ type: "delete_anchor_document", absolutePath })
		}
		this.dirtyAnchorPaths.clear()
	}

	private async saveInternal(): Promise<void> {
		if (!this.loaded) return
		if (this.anchorStateLoaded) this.queueAnchorOperations()
		if (this.pendingOperations.length === 0) return

		const pending = this.pendingOperations.splice(0)
		const pendingBytes = this.pendingOperationBytes
		this.pendingOperationBytes = 0
		try {
			await appendOperationRecords(this.operationPath, pending)
		} catch (error) {
			this.pendingOperations.unshift(...pending)
			this.pendingOperationBytes += pendingBytes
			if (this.pendingOperationBytes > MAX_PENDING_OPERATION_BYTES) {
				const reset: ToolContextOperation = {
					offset: ++this.operationOffset,
					type: "reset",
					values: this.snapshotTaskData(),
				}
				this.pendingOperations = [reset]
				this.pendingOperationBytes = Buffer.byteLength(JSON.stringify(reset), "utf8")
			}
			throw error
		}
		await this.stateManager.flushPendingState()
		if (await operationLogExceedsBaselineThreshold(this.operationPath)) {
			await writeFramedBaseline(this.baselinePath, this.baselineRecords())
			await archiveOperationLog(this.operationPath, this.operationOffset)
		}
	}

	public async load(): Promise<void> {
		await this.withStateLock(() => this.loadTaskData())
	}

	public async ensureAnchorState(): Promise<void> {
		await this.withStateLock(async () => {
			await this.loadTaskData()
			this.ensureAnchorStateLoaded()
		})
	}

	public markAnchorStateDirty(absolutePath?: string): void {
		if (absolutePath) this.dirtyAnchorPaths.add(absolutePath)
		else this.completeAnchorStateDirty = true
	}

	public async save(): Promise<void> {
		await this.withStateLock(() => this.saveInternal())
	}

	private async readBaseline(): Promise<{ values: Record<string, any>; offset: number }> {
		try {
			await fs.access(this.baselinePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			try {
				const values = safeParseJson(
					z.record(z.unknown()),
					await fs.readFile(this.taskPath, "utf8"),
					`task context state '${this.taskPath}'`,
				)
				return { values, offset: -1 }
			} catch (legacyError) {
				if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return { values: {}, offset: -1 }
				throw legacyError
			}
		}

		const values: Record<string, any> = {}
		let offset: number | undefined
		await replayOperationRecords<ToolContextBaselineRecord>(this.baselinePath, (record, lineNumber) => {
			if (lineNumber === 1 && record.type === "baseline" && Number.isSafeInteger(record.offset)) {
				offset = record.offset
				return
			}
			if (offset === undefined) throw new Error(`Tool-context baseline has no header: ${this.baselinePath}`)
			if (record.type === "value") {
				values[record.key] = record.value
				return
			}
			if (record.type === "entry") {
				const entries = (values[record.key] ?? {}) as Record<string, unknown>
				entries[record.entryKey] = record.value
				values[record.key] = entries
				return
			}
			if (record.type === "anchor") {
				values[ANCHOR_STATE_KEY] = { version: record.version, documents: [] } satisfies PersistedAnchorState
				return
			}
			if (record.type === "anchor_document") {
				const anchorState = values[ANCHOR_STATE_KEY] as PersistedAnchorState | undefined
				if (!anchorState) throw new Error(`Anchor document precedes anchor header at ${this.baselinePath}:${lineNumber}`)
				anchorState.documents.push(record.document)
				return
			}
			throw new Error(`Invalid tool-context baseline record ${lineNumber}`)
		})
		if (offset === undefined) throw new Error(`Tool-context baseline has no header: ${this.baselinePath}`)
		return { values, offset }
	}

	private *baselineRecords(): Generator<ToolContextBaselineRecord> {
		yield { type: "baseline", offset: this.operationOffset }
		let wroteAnchorState = false
		for (const [key, value] of Object.entries(this.taskData)) {
			if (key === ANCHOR_STATE_KEY) {
				wroteAnchorState = true
				const anchorState = this.anchorStateLoaded
					? AnchorStateManager.exportState(this.conversationUlid)
					: value as PersistedAnchorState
				yield { type: "anchor", version: anchorState.version }
				for (const document of anchorState.documents) yield { type: "anchor_document", document }
				continue
			}
			if (isPlainRecord(value)) {
				const entries = Object.entries(value)
				if (entries.length === 0) yield { type: "value", key, value }
				else for (const [entryKey, entryValue] of entries) yield { type: "entry", key, entryKey, value: entryValue }
				continue
			}
			yield { type: "value", key, value }
		}
		if (this.anchorStateLoaded && !wroteAnchorState) {
			const anchorState = AnchorStateManager.exportState(this.conversationUlid)
			yield { type: "anchor", version: anchorState.version }
			for (const document of anchorState.documents) yield { type: "anchor_document", document }
		}
	}

	private async replaceTaskValue<T>(key: string, value: T): Promise<void> {
		await this.loadTaskData()
		if (isDeepStrictEqual(this.taskData[key], value)) return
		const storedValue = structuredClone(value)
		this.taskData[key] = storedValue
		this.queueOperation({ type: "set", key, value: storedValue })
	}

	public task = {
		get: async <T>(key: string): Promise<T | undefined> =>
			await this.withStateLock(async () => {
				await this.loadTaskData()
				const value = this.taskData[key] as T | undefined
				return value === undefined ? undefined : structuredClone(value)
			}),
		getEntry: async <T>(key: string, entryKey: string): Promise<T | undefined> =>
			await this.withStateLock(async () => {
				await this.loadTaskData()
				const value = (this.taskData[key] as Record<string, T> | undefined)?.[entryKey]
				return value === undefined ? undefined : structuredClone(value)
			}),
		getEntries: async <T>(key: string, entryKeys: readonly string[]): Promise<Record<string, T>> =>
			await this.withStateLock(async () => {
				await this.loadTaskData()
				const entries = (this.taskData[key] ?? {}) as Record<string, T>
				const selected: Record<string, T> = {}
				for (const entryKey of entryKeys) {
					if (entries[entryKey] !== undefined) selected[entryKey] = structuredClone(entries[entryKey])
				}
				return selected
			}),
		set: async <T>(key: string, value: T): Promise<void> => {
			await this.withStateLock(() => this.replaceTaskValue(key, value))
		},
		update: async <T>(key: string, updater: (value: T | undefined) => T): Promise<void> => {
			await this.withStateLock(async () => {
				await this.loadTaskData()
				const value = this.taskData[key] as T | undefined
				await this.replaceTaskValue(key, updater(value === undefined ? undefined : structuredClone(value)))
			})
		},
		updateEntries: async <T>(key: string, updates: Record<string, T>, deletions: readonly string[] = []): Promise<void> => {
			await this.withStateLock(async () => {
				await this.loadTaskData()
				const entries = (this.taskData[key] ?? {}) as Record<string, T>
				const changedUpdates: Record<string, T> = {}
				const changedDeletions: string[] = []
				for (const [entryKey, value] of Object.entries(updates)) {
					if (isDeepStrictEqual(entries[entryKey], value)) continue
					const storedValue = structuredClone(value)
					entries[entryKey] = storedValue
					changedUpdates[entryKey] = storedValue
				}
				for (const entryKey of deletions) {
					if (!(entryKey in entries)) continue
					delete entries[entryKey]
					changedDeletions.push(entryKey)
				}
				if (Object.keys(changedUpdates).length === 0 && changedDeletions.length === 0) return
				this.taskData[key] = entries
				this.queueOperation({ type: "update_entries", key, updates: changedUpdates, deletions: changedDeletions })
			})
		},
	}

	public workspace = {
		get: <T>(key: string): T | undefined => this.stateManager.getWorkspaceStateKey(key as any) as T,
		set: <T>(key: string, value: T): void => {
			this.stateManager.setWorkspaceState(key as any, value as any)
		},
	}

	public async resetTaskContext(): Promise<void> {
		await this.withStateLock(async () => {
			await this.loadTaskData()
			this.ensureAnchorStateLoaded()
			this.taskData = { [ANCHOR_STATE_KEY]: AnchorStateManager.exportState(this.conversationUlid) }
			this.completeAnchorStateDirty = false
			this.dirtyAnchorPaths.clear()
			this.queueOperation({ type: "reset", values: this.taskData })
			await this.saveInternal()
		})
	}

	public global = {
		get: <T>(key: string): T | undefined => this.stateManager.getGlobalStateKey(key as any) as T,
		set: <T>(key: string, value: T): void => {
			this.stateManager.setGlobalState(key as any, value as any)
		},
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
