import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { atomicWriteFile } from "@core/storage/atomicWrite"
import type {
	ToolExecutionOutcome,
	ToolExecutionOutputPage,
	ToolExecutionOutputRequest,
	ToolExecutionOwner,
} from "@shared/toolExecution"
import { TOOL_EXECUTION_MAX_OUTPUT_PAGE_BYTES } from "@shared/toolExecutionObservation"

export interface ToolExecutionOutputStore {
	create(executionId: string): Promise<void>
	append(executionId: string, text: string): Promise<void>
	close(executionId: string): Promise<void>
	writeResult(executionId: string, outcome: ToolExecutionOutcome): Promise<void>
	read(request: ToolExecutionOutputRequest): Promise<ToolExecutionOutputPage>
}

/** Retained output, separate from frequently committed lifecycle snapshots. One writer per owner run. */
export class DiskToolExecutionOutputStore implements ToolExecutionOutputStore {
	private readonly owner: ToolExecutionOwner
	private readonly queues = new Map<string, Promise<unknown>>()

	constructor(
		private readonly directory: string,
		owner: ToolExecutionOwner,
	) {
		this.owner = { ...owner }
	}

	async create(executionId: string): Promise<void> {
		await this.serialize(executionId, async () => {
			await fs.mkdir(this.directory, { recursive: true })
			const file = await fs.open(this.file(executionId, "stream"), "wx")
			await file.close()
		})
	}

	async append(executionId: string, text: string): Promise<void> {
		await this.serialize(executionId, async () => {
			if (await this.closed(executionId)) throw new Error("Cannot append to closed execution output")
			// r+ requires durable admission/create; append must not invent an execution.
			const file = await fs.open(this.file(executionId, "stream"), "r+")
			try {
				const bytes = Buffer.from(text, "utf8")
				const { size } = await file.stat()
				try {
					let written = 0
					while (written < bytes.length) {
						const result = await file.write(bytes, written, bytes.length - written, size + written)
						if (result.bytesWritten === 0) throw new Error("Execution output write made no progress")
						written += result.bytesWritten
					}
				} catch (error) {
					// A failed append must not retain a partial UTF-8 character or duplicate
					// a prefix when the caller retries the same chunk.
					try {
						await file.truncate(size)
					} catch (rollbackError) {
						throw new AggregateError([error, rollbackError], "Execution output append and rollback failed")
					}
					throw error
				}
			} finally {
				await file.close()
			}
		})
	}

	async close(executionId: string): Promise<void> {
		await this.serialize(executionId, async () => {
			await fs.stat(this.file(executionId, "stream"))
			await atomicWriteFile(this.file(executionId, "closed"), "closed")
		})
	}

	async writeResult(executionId: string, outcome: ToolExecutionOutcome): Promise<void> {
		const serialized = JSON.stringify(outcome)
		await this.serialize(executionId, async () => {
			await fs.stat(this.file(executionId, "stream"))
			const filename = this.file(executionId, "result")
			let existing: string | undefined
			try {
				existing = await fs.readFile(filename, "utf8")
			} catch (error) {
				if (!isMissing(error)) throw error
			}
			if (existing !== undefined) {
				if (existing !== serialized) throw new Error("Cannot replace an execution's retained result")
				return
			}
			await atomicWriteFile(filename, serialized)
		})
	}

	async read(request: ToolExecutionOutputRequest): Promise<ToolExecutionOutputPage> {
		request = { ...request }
		if (!Number.isSafeInteger(request.limit) || request.limit < 4 || request.limit > TOOL_EXECUTION_MAX_OUTPUT_PAGE_BYTES) {
			throw new Error(`Execution output limit must be from 4 through ${TOOL_EXECUTION_MAX_OUTPUT_PAGE_BYTES} bytes`)
		}
		const view = request.view ?? "stream"
		const offset = request.cursor === undefined ? 0 : this.decodeCursor(request.cursor, request.execution_id, view)
		return this.serialize(request.execution_id, async () => {
			// Even an unavailable final result must reference a known execution.
			await fs.stat(this.file(request.execution_id, "stream"))
			const filename = this.file(request.execution_id, view)
			let file: fs.FileHandle
			try {
				file = await fs.open(filename, "r")
			} catch (error) {
				if (view !== "result" || !isMissing(error)) throw error
				if (offset !== 0) throw new Error("Execution result cursor is beyond available output")
				return this.page(request.execution_id, view, offset, "", false)
			}
			try {
				const { size } = await file.stat()
				if (offset > size) throw new Error("Execution output cursor is beyond available output")
				const bytes = Buffer.alloc(Math.min(request.limit, size - offset))
				let read = 0
				while (read < bytes.length) {
					const result = await file.read(bytes, read, bytes.length - read, offset + read)
					if (result.bytesRead === 0) throw new Error("Execution output changed while reading")
					read += result.bytesRead
				}
				const output = decodeUtf8Page(bytes, offset + bytes.length === size)
				return this.page(
					request.execution_id,
					view,
					offset,
					output,
					view === "result" || (await this.closed(request.execution_id)),
				)
			} finally {
				await file.close()
			}
		})
	}

	private page(
		executionId: string,
		view: "stream" | "result",
		offset: number,
		output: string,
		closed: boolean,
	): ToolExecutionOutputPage {
		return {
			execution_id: executionId,
			view,
			cursor: this.cursor(executionId, view, offset),
			next_cursor: this.cursor(executionId, view, offset + Buffer.byteLength(output, "utf8")),
			output,
			closed,
			truncated: false,
		}
	}

	private cursor(executionId: string, view: "stream" | "result", offset: number): string {
		return Buffer.from(
			JSON.stringify([this.owner.rootTaskId, this.owner.taskId, this.owner.runId, executionId, view, offset]),
			"utf8",
		).toString("base64url")
	}

	private decodeCursor(cursor: string, executionId: string, view: "stream" | "result"): number {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
		if (
			!Array.isArray(value) ||
			value.length !== 6 ||
			!Number.isSafeInteger(value[5]) ||
			value[5] < 0 ||
			this.cursor(executionId, view, value[5]) !== cursor
		) {
			throw new Error("Invalid or foreign execution output cursor")
		}
		return value[5] as number
	}

	private file(executionId: string, suffix: "stream" | "result" | "closed"): string {
		const key = JSON.stringify([this.owner.rootTaskId, this.owner.taskId, this.owner.runId, executionId])
		return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.${suffix}`)
	}

	private async closed(executionId: string): Promise<boolean> {
		try {
			await fs.stat(this.file(executionId, "closed"))
			return true
		} catch (error) {
			if (isMissing(error)) return false
			throw error
		}
	}

	private serialize<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(executionId) ?? Promise.resolve()
		// A caller observes its failure; later reads/cleanup may still recover the resource.
		const next = previous.then(operation, operation)
		this.queues.set(executionId, next)
		const release = () => {
			if (this.queues.get(executionId) === next) this.queues.delete(executionId)
		}
		void next.then(release, release)
		return next
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function decodeUtf8Page(bytes: Buffer, atEnd: boolean): string {
	if (bytes.length === 0) return ""
	if ((bytes[0] & 0xc0) === 0x80) throw new Error("Execution output cursor splits a UTF-8 character")
	let end = bytes.length
	if (!atEnd) {
		let start = end - 1
		while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--
		const first = bytes[start]
		const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4
		if (end - start < width) end = start
	}
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end))
}
