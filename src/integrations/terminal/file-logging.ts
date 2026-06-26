/**
 * FileLoggingManager - Manages file-based output logging for large command outputs.
 *
 * Strategy 5: All state passed explicitly as parameters, returned as new objects.
 */

import { DiracTempManager } from "@services/temp"
import * as fs from "fs"
import { MAX_BYTES_BEFORE_FILE, MAX_LINES_BEFORE_FILE, SUMMARY_LINES_TO_KEEP } from "./constants"

export interface FileLogState {
	isWritingToFile: boolean
	largeOutputLogPath: string | null
	largeOutputLogStream: fs.WriteStream | null
	totalOutputBytes: number
	totalLineCount: number
	firstLines: string[]
	lastLines: string[]
}

export function createFileLogState(): FileLogState {
	return {
		isWritingToFile: false,
		largeOutputLogPath: null,
		largeOutputLogStream: null,
		totalOutputBytes: 0,
		totalLineCount: 0,
		firstLines: [],
		lastLines: [],
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
		largeOutputLogStream: fs.createWriteStream(logPath, { flags: "a" }),
		logPath,
	}
}

export function writeLineToFile(state: FileLogState, line: string): FileLogState {
	if (!state.largeOutputLogStream) return state
	state.largeOutputLogStream.write(line + "\n")

	const newLastLines = [...state.lastLines, line]
	if (newLastLines.length > SUMMARY_LINES_TO_KEEP) {
		newLastLines.shift()
	}

	return {
		...state,
		totalLineCount: state.totalLineCount + 1,
		lastLines: newLastLines,
	}
}

export function updateFirstLines(state: FileLogState, lines: string[]): FileLogState {
	return {
		...state,
		firstLines: lines.slice(0, SUMMARY_LINES_TO_KEEP),
		lastLines: lines.slice(-SUMMARY_LINES_TO_KEEP),
		totalLineCount: lines.length,
	}
}

export function cleanupFileLog(state: FileLogState): FileLogState {
	if (state.largeOutputLogStream) {
		state.largeOutputLogStream.end()
		return { ...state, largeOutputLogStream: null }
	}
	return state
}

export function buildFileSummary(
	state: FileLogState,
	processOutputFn: (lines: string[]) => string,
): { result: string; summaryLines: string[] } {
	const skippedLines = state.totalLineCount - state.firstLines.length - state.lastLines.length
	const summaryLines = [
		...state.firstLines,
		`\n... (${skippedLines} lines written to ${state.largeOutputLogPath}) ...\n`,
		...state.lastLines,
	]
	return {
		result: processOutputFn(summaryLines),
		summaryLines,
	}
}
