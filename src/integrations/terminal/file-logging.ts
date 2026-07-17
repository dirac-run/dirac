/**
 * File-based logging for command output that is too large to retain in memory.
 */

import { DiracTempManager } from "@services/temp"
import { MAX_BYTES_BEFORE_FILE, MAX_LINES_BEFORE_FILE, SUMMARY_BYTES_TO_KEEP, SUMMARY_LINES_TO_KEEP } from "./constants"

export interface FileLogState {
	isWritingToFile: boolean
	largeOutputLogPath: string | null
	totalOutputBytes: number
	totalLineCount: number
	firstLines: string[]
	lastLines: string[]
	pendingOutput: string
	pendingOutputBytes: number
	writer: QueuedFileWriter | null
}

const SUMMARY_HALF_BYTE_LIMIT = Math.floor(SUMMARY_BYTES_TO_KEEP / 2)
const FILE_FLUSH_BYTE_LIMIT = 64 * 1024

class QueuedFileWriter {
	private readonly handlePromise
	private pendingWrites: Promise<void> = Promise.resolve()
	private firstError: Error | undefined
	private closePromise: Promise<void> | undefined

	constructor(path: string) {
		this.handlePromise = import("node:fs/promises").then(({ open }) => open(path, "wx"))
	}

	write(output: string): void {
		if (output.length === 0) return
		if (this.closePromise) throw new Error("Cannot write to a closed command output log")
		this.pendingWrites = this.pendingWrites
			.then(async () => {
				const handle = await this.handlePromise
				await handle.appendFile(output, "utf8")
			})
			.catch((error) => {
				this.firstError ??= error instanceof Error ? error : new Error(String(error))
			})
	}

	async close(): Promise<void> {
		this.closePromise ??= this.closeAfterPendingWrites()
		await this.closePromise
	}

	private async closeAfterPendingWrites(): Promise<void> {
		await this.pendingWrites
		const handle = await this.handlePromise
		await handle.close()
		if (this.firstError) throw this.firstError
	}
}

function takeUtf8Prefix(content: string, maxBytes: number): string {
	return Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "")
}

function takeUtf8Suffix(content: string, maxBytes: number): string {
	const buffer = Buffer.from(content, "utf8")
	return buffer
		.subarray(Math.max(0, buffer.byteLength - maxBytes))
		.toString("utf8")
		.replace(/^\uFFFD/, "")
}


function takeSummaryFromStart(lines: string[]): string[] {
	const summary: string[] = []
	let usedBytes = 0

	for (const line of lines.slice(0, SUMMARY_LINES_TO_KEEP)) {
		const separatorBytes = summary.length > 0 ? 1 : 0
		const remainingBytes = SUMMARY_HALF_BYTE_LIMIT - usedBytes - separatorBytes
		if (remainingBytes <= 0) break

		const lineBytes = Buffer.byteLength(line, "utf8")
		summary.push(lineBytes <= remainingBytes ? line : takeUtf8Prefix(line, remainingBytes))
		usedBytes += separatorBytes + Math.min(lineBytes, remainingBytes)
		if (lineBytes > remainingBytes) break
	}

	return summary
}

function takeSummaryFromEnd(lines: string[]): string[] {
	const summary: string[] = []
	let usedBytes = 0

	for (let index = lines.length - 1; index >= 0 && summary.length < SUMMARY_LINES_TO_KEEP; index--) {
		const separatorBytes = summary.length > 0 ? 1 : 0
		const remainingBytes = SUMMARY_HALF_BYTE_LIMIT - usedBytes - separatorBytes
		if (remainingBytes <= 0) break

		const line = lines[index]
		const lineBytes = Buffer.byteLength(line, "utf8")
		summary.unshift(lineBytes <= remainingBytes ? line : takeUtf8Suffix(line, remainingBytes))
		usedBytes += separatorBytes + Math.min(lineBytes, remainingBytes)
		if (lineBytes > remainingBytes) break
	}

	return summary
}

function appendOutput(state: FileLogState, output: string, forceFlush = false): FileLogState {
	const pendingOutput = state.pendingOutput + output
	const pendingOutputBytes = state.pendingOutputBytes + Buffer.byteLength(output, "utf8")
	if (!forceFlush && pendingOutputBytes < FILE_FLUSH_BYTE_LIMIT) {
		return { ...state, pendingOutput, pendingOutputBytes }
	}

	state.writer!.write(pendingOutput)
	return { ...state, pendingOutput: "", pendingOutputBytes: 0 }
}

export function createFileLogState(): FileLogState {
	return {
		isWritingToFile: false,
		largeOutputLogPath: null,
		totalOutputBytes: 0,
		totalLineCount: 0,
		firstLines: [],
		lastLines: [],
		pendingOutput: "",
		pendingOutputBytes: 0,
		writer: null,
	}
}

export function shouldSwitchToFile(outputLinesLength: number, totalBytes: number): boolean {
	return outputLinesLength >= MAX_LINES_BEFORE_FILE || totalBytes >= MAX_BYTES_BEFORE_FILE
}

export function createFileLog(): FileLogState & { logPath: string } {
	const logPath = DiracTempManager.createTempFilePath("large-output")

	return {
		...createFileLogState(),
		isWritingToFile: true,
		largeOutputLogPath: logPath,
		logPath,
		writer: new QueuedFileWriter(logPath),
	}
}

export function writeInitialLinesToFile(state: FileLogState, lines: string[]): FileLogState {
	if (lines.length === 0) return state
	return appendOutput(state, lines.join("\n") + "\n", true)
}

export function writeLineToFile(state: FileLogState, line: string): FileLogState {
	const nextState = appendOutput(state, line + "\n")
	return {
		...nextState,
		firstLines: state.firstLines.length > 0 ? state.firstLines : takeSummaryFromStart([line]),
		lastLines: takeSummaryFromEnd([...state.lastLines, line]),
	}
}

export function updateFirstLines(state: FileLogState, lines: string[]): FileLogState {
	return {
		...state,
		firstLines: takeSummaryFromStart(lines),
		lastLines: takeSummaryFromEnd(lines),
	}
}

export async function cleanupFileLog(state: FileLogState): Promise<FileLogState> {
	if (!state.isWritingToFile) return state
	const flushedState = state.pendingOutputBytes === 0 ? state : appendOutput(state, "", true)
	await flushedState.writer!.close()
	return flushedState
}



export function buildFileSummary(
	state: FileLogState,
	processOutputFn: (lines: string[]) => string,
): { result: string; summaryLines: string[] } {
	const singleLineWasTruncated =
		state.totalLineCount === 1 &&
		state.firstLines.length === 1 &&
		state.lastLines.length === 1 &&
		state.firstLines[0] !== state.lastLines[0]
	const overlapCount = singleLineWasTruncated
		? 0
		: Math.max(0, state.firstLines.length + state.lastLines.length - state.totalLineCount)
	const lastLines = state.lastLines.slice(overlapCount)
	const retainedLineCount = singleLineWasTruncated ? 1 : state.firstLines.length + lastLines.length
	const skippedLines = Math.max(0, state.totalLineCount - retainedLineCount)
	const summaryLines = [
		...state.firstLines,
		`\n... (${skippedLines} lines written to ${state.largeOutputLogPath}) ...\n`,
		...lastLines,
	]
	return {
		result: processOutputFn(summaryLines),
		summaryLines,
	}
}
