import fs from "node:fs"
import * as path from "node:path"
import { once } from "node:events"

export const OPERATION_BASELINE_THRESHOLD_BYTES = 8 * 1024 * 1024

export function encodeOperationRecords(records: readonly unknown[]): string {
	return records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

/** Appends one newline-framed batch. Each JSON record is independently replayable. */
export async function appendOperationRecords(filePath: string, records: readonly unknown[]): Promise<number> {
	if (records.length === 0) return 0
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
	await discardIncompleteFinalRecord(filePath)
	const encoded = encodeOperationRecords(records)
	await fs.promises.appendFile(filePath, encoded, "utf8")
	return Buffer.byteLength(encoded, "utf8")
}

/** Removes only an unterminated tail left by an interrupted prior append. */
async function discardIncompleteFinalRecord(filePath: string): Promise<void> {
	let descriptor: fs.promises.FileHandle
	try {
		descriptor = await fs.promises.open(filePath, "r+")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}

	try {
		const size = (await descriptor.stat()).size
		if (size === 0) return
		const finalByte = Buffer.allocUnsafe(1)
		await descriptor.read(finalByte, 0, 1, size - 1)
		if (finalByte[0] === 0x0a) return

		const chunk = Buffer.allocUnsafe(64 * 1024)
		let end = size
		while (end > 0) {
			const start = Math.max(0, end - chunk.length)
			const length = end - start
			await descriptor.read(chunk, 0, length, start)
			const newlineIndex = chunk.lastIndexOf(0x0a, length - 1)
			if (newlineIndex !== -1) {
				await descriptor.truncate(start + newlineIndex + 1)
				return
			}
			end = start
		}
		await descriptor.truncate(0)
	} finally {
		await descriptor.close()
	}
}

export async function operationLogExceedsBaselineThreshold(filePath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(filePath)).size >= OPERATION_BASELINE_THRESHOLD_BYTES
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

/** Writes a framed baseline without first constructing a dataset-sized string. */
export async function writeFramedBaseline(filePath: string, records: Iterable<unknown>): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
	const output = fs.createWriteStream(temporaryPath, { encoding: "utf8", flags: "wx" })
	try {
		for (const record of records) {
			if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain")
		}
		output.end()
		await once(output, "close")
		await fs.promises.rename(temporaryPath, filePath)
	} catch (error) {
		output.destroy()
		await fs.promises.unlink(temporaryPath).catch((unlinkError) => {
			if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError
		})
		throw error
	}
}

/** Moves a completed tail out of the normal-load path while retaining it for checkpoint reconstruction. */
export async function archiveOperationLog(filePath: string, throughOffset: number): Promise<void> {
	try {
		await fs.promises.rename(filePath, `${filePath}.archive.${throughOffset}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
}

/**
 * Streams complete newline-framed records. A final unterminated record is ignored
 * because it may be the remainder of an interrupted append.
 */
export async function replayOperationRecords<T>(filePath: string, apply: (record: T, lineNumber: number) => void): Promise<void> {
	const input = fs.createReadStream(filePath)
	try {
		await once(input, "open")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	const pendingSegments: Buffer[] = []
	let pendingByteLength = 0
	let lineNumber = 0

	for await (const chunk of input) {
		let frameStart = 0
		while (frameStart < chunk.length) {
			const frameEnd = chunk.indexOf(0x0a, frameStart)
			if (frameEnd === -1) {
				const remainder = chunk.subarray(frameStart)
				pendingSegments.push(remainder)
				pendingByteLength += remainder.length
				break
			}

			const finalSegment = chunk.subarray(frameStart, frameEnd)
			const frame =
				pendingSegments.length === 0
					? finalSegment
					: Buffer.concat([...pendingSegments, finalSegment], pendingByteLength + finalSegment.length)
			pendingSegments.length = 0
			pendingByteLength = 0
			lineNumber++

			const content = frame[frame.length - 1] === 0x0d ? frame.subarray(0, -1) : frame
			parseAndApplyRecord(filePath, lineNumber, content.toString("utf8"), apply)
			frameStart = frameEnd + 1
		}
	}
}

function parseAndApplyRecord<T>(
	filePath: string,
	lineNumber: number,
	line: string,
	apply: (record: T, lineNumber: number) => void,
): void {
	if (line.length === 0) return

	let record: T
	try {
		record = JSON.parse(line) as T
	} catch (error) {
		throw new Error(`Invalid operation record at ${filePath}:${lineNumber}`, { cause: error })
	}

	try {
		apply(record, lineNumber)
	} catch (error) {
		throw new Error(`Failed to apply operation record at ${filePath}:${lineNumber}`, { cause: error })
	}
}
