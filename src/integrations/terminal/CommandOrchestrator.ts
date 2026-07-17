/**
 * CommandOrchestrator - Shared command execution orchestration logic.
 *
 * Strategy 5: Functional composition with direct params.
 * Process EventEmitter passed directly as function parameter, never via context object wrapper.
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { Logger } from "@/shared/services/Logger"
import { type BuildResultInput, buildResult } from "./buildResult"
import {
	buildFileSummary,
	cleanupFileLog,
	createFileLog,
	createFileLogState,
	shouldSwitchToFile,
	updateFirstLines,
	writeInitialLinesToFile,
	writeLineToFile,
} from "./file-logging"
import { attachProcessListeners } from "./process-listeners"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	OrchestrationOptions,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalProcessResultPromise,
} from "./types"



export async function orchestrateCommandExecution(
	process: TerminalProcessResultPromise,
	terminalManager: ITerminalManager,
	callbacks: CommandExecutorCallbacks,
	options: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const {
		timeoutSeconds,
		showShellIntegrationSuggestion,
		onProceedWhileRunning,
		terminalType = "vscode",
		suppressUserInteraction = false,
	} = options
	const taskMessenger = callbacks.taskMessenger

	callbacks.updateBackgroundCommandState(true)
	const clearCommandState = async () => callbacks.updateBackgroundCommandState(false)
	process.once("completed", clearCommandState)
	process.once("error", clearCommandState)
	process.once("continue", clearCommandState)
	process.catch(() => clearCommandState())

	const outputLines: string[] = []
	let fileState = createFileLogState()
	let fileLogError: Error | undefined
	let largeOutputNotification: Promise<void> | undefined
	let handedOffToBackground = false
	let outputListenerAttached = true
	let processListenersCleaned = false

	const onLine = (line: string) => {
		if (fileLogError) return

		try {
			const lineBytes = Buffer.byteLength(line, "utf8") + 1
			fileState.totalOutputBytes += lineBytes
			fileState.totalLineCount++

			if (!fileState.isWritingToFile && shouldSwitchToFile(outputLines.length, fileState.totalOutputBytes)) {
				const linesBeforeFile = outputLines.length
				const fileLog = createFileLog()
				fileState = {
					...fileLog,
					totalOutputBytes: fileState.totalOutputBytes,
					totalLineCount: fileState.totalLineCount,
				}
				fileState = writeInitialLinesToFile(fileState, outputLines)
				fileState = updateFirstLines(fileState, outputLines)
				if (!suppressUserInteraction) {
					largeOutputNotification = taskMessenger
						.upsertText(
							`\n📋 Output is large (${linesBeforeFile} lines, ${Math.round(fileState.totalOutputBytes / 1024)}KB). Writing to: ${fileState.largeOutputLogPath}`,
						)
						.catch((error) => Logger.error("Failed to publish large command output notification", error))
				}
			}

			if (fileState.isWritingToFile) {
				fileState = writeLineToFile(fileState, line)
			} else {
				outputLines.push(line)
			}
		} catch (error) {
			fileLogError = error instanceof Error ? error : new Error(String(error))
		}
	}
	process.on("line", onLine)

	const completionState = { completed: false, details: undefined as TerminalCompletionDetails | undefined }
	const { cleanup: cleanupListeners } = attachProcessListeners(
		{ process, taskMessenger, terminalType, showShellIntegrationSuggestion, suppressUserInteraction },
		(details?: TerminalCompletionDetails) => {
			completionState.completed = true
			completionState.details = details
		},
	)

	const detachOutputListener = () => {
		if (!outputListenerAttached) return
		process.off("line", onLine)
		outputListenerAttached = false
	}
	const cleanupProcessListeners = () => {
		if (processListenersCleaned) return
		cleanupListeners()
		processListenersCleaned = true
	}
	const flushFileOutput = async () => {
		await largeOutputNotification
		fileState = await cleanupFileLog(fileState)
		if (fileLogError) throw fileLogError
	}

	try {
		if (timeoutSeconds) {
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), timeoutSeconds * 1000)
			})

			try {
				await Promise.race([process, timeoutPromise])
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "COMMAND_TIMEOUT") throw error

				if (onProceedWhileRunning) {
					let resolveOutputReady: (() => void) | undefined
					let rejectOutputReady: ((error: unknown) => void) | undefined
					const outputReady = fileState.isWritingToFile
						? new Promise<void>((resolve, reject) => {
							resolveOutputReady = resolve
							rejectOutputReady = reject
						})
						: undefined
					const trackingResult = onProceedWhileRunning(
						fileState.isWritingToFile ? [] : outputLines,
						fileState.largeOutputLogPath ?? undefined,
						outputReady,
					)
					handedOffToBackground = trackingResult !== undefined
					detachOutputListener()
					cleanupProcessListeners()
					try {
						await flushFileOutput()
						resolveOutputReady?.()
					} catch (error) {
						rejectOutputReady?.(error)
						throw error
					}

					const fileSummary = fileState.isWritingToFile
						? buildFileSummary(fileState, terminalManager.processOutput.bind(terminalManager))
						: undefined
					const result = fileSummary?.result ?? terminalManager.processOutput(outputLines)

					if (trackingResult?.logFilePath && !suppressUserInteraction) {
						await taskMessenger.upsertText(
							`\n⏱️ Command timed out. Output is being logged to: ${trackingResult.logFilePath}`,
						)
					}
					process.continue()
					return {
						userRejected: false,
						result: `Command timed out after ${timeoutSeconds} seconds. Running in background.\n${trackingResult?.logFilePath ? `Log file: ${trackingResult.logFilePath}\n` : ""
							}${result.length > 0 ? `\nOutput so far:\n${result}` : ""}`,
						completed: false,
						outputLines: fileSummary?.summaryLines ?? outputLines,
						logFilePath: trackingResult?.logFilePath ?? fileState.largeOutputLogPath ?? undefined,
					}
				}

				await setTimeoutPromise(50)
				detachOutputListener()
				cleanupProcessListeners()
				await flushFileOutput()
				const fileSummary = fileState.isWritingToFile
					? buildFileSummary(fileState, terminalManager.processOutput.bind(terminalManager))
					: undefined
				const result = fileSummary?.result ?? terminalManager.processOutput(outputLines)
				process.continue()
				return {
					userRejected: false,
					result: `Command execution timed out after ${timeoutSeconds} seconds. ${result.length > 0 ? `\nOutput so far:\n${result}` : ""
						}`,
					completed: false,
					outputLines: fileSummary?.summaryLines ?? outputLines,
					logFilePath: fileState.largeOutputLogPath || undefined,
				}
			}
		} else {
			await process
		}

		await setTimeoutPromise(50)
		detachOutputListener()
		cleanupProcessListeners()
		await flushFileOutput()

		const fileSummary =
			fileState.isWritingToFile && fileState.largeOutputLogPath
				? buildFileSummary(fileState, terminalManager.processOutput.bind(terminalManager))
				: undefined
		const input: BuildResultInput = {
			userRejected: false,
			result: fileSummary?.result ?? terminalManager.processOutput(outputLines),
			completed: completionState.completed,
			outputLines: fileSummary?.summaryLines ?? outputLines,
			logFilePath: fileState.largeOutputLogPath || undefined,
			exitCode: completionState.details?.exitCode,
			signal: completionState.details?.signal,
		}

		return buildResult(input)
	} finally {
		if (!handedOffToBackground) detachOutputListener()
		cleanupProcessListeners()
		if (!handedOffToBackground && fileState.isWritingToFile && fileState.writer) {
			await cleanupFileLog(fileState)
		}
	}
}

export function findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
	for (let i = array.length - 1; i >= 0; i--) {
		if (predicate(array[i])) return i
	}
	return -1
}
