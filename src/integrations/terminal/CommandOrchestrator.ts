/**
 * CommandOrchestrator - Shared command execution orchestration logic.
 *
 * Strategy 5: Functional composition with direct params.
 * Process EventEmitter passed directly as function parameter, never via context object wrapper.
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger"
import { type BuildResultInput, buildResult } from "./buildResult"
import { BUFFER_STUCK_TIMEOUT_MS, CHUNK_BYTE_SIZE, CHUNK_DEBOUNCE_MS, CHUNK_LINE_COUNT } from "./constants"
import {
	buildFileSummary,
	cleanupFileLog,
	createFileLog,
	createFileLogState,
	shouldSwitchToFile,
	updateFirstLines,
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
		command,
		timeoutSeconds,
		onOutputLine,
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

	// Mutable state tracked locally (not in a context object wrapper)
	let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
	let didContinue = false
	let didCancelViaUi = false
	let backgroundTrackingResult: OrchestrationResult | null = null

	const chunkTimerRef: { current: NodeJS.Timeout | null } = { current: null }
	const bufferStuckTimerRef: { current: NodeJS.Timeout | null } = { current: null }

	// outputLines = all captured lines (for final result)
	const outputLines: string[] = []
	// outputBuffer = chunked subset for UI flushing
	let outputBuffer: string[] = []
	let outputBufferSize = 0

	// File logging state
	let fileState = createFileLogState()

	// ---- Flush function (defined before line listener so it can be referenced) ----
	const flushBufferFn = async (force = false): Promise<OrchestrationResult | null> => {
		if (outputBuffer.length === 0 && !force) return null

		const chunk = outputBuffer.join("\n")
		outputBuffer = []
		outputBufferSize = 0

		if (!didContinue) {
			bufferStuckTimerRef.current = setTimeout(() => {
				bufferStuckTimerRef.current = null
			}, BUFFER_STUCK_TIMEOUT_MS)

			if (suppressUserInteraction) return null

			try {
				const cardHandle = await taskMessenger.createCard({
					header: "Command Output",
					body: chunk,
					requireApproval: false,
					requireFeedback: true,
					feedbackPlaceholder: "Type a message to the agent...",
					actions: [
						{ label: "Proceed While Running", value: DiracAskResponse.APPROVE, primary: true },
						{ label: "Cancel Command", value: DiracAskResponse.REJECT, style: "danger" },
					],
				})

				const interaction = await cardHandle.waitForInteraction()
				const { response, text, images, files } = interaction

				if (response === DiracAskResponse.APPROVE) {
					if (text || (images && images.length > 0) || (files && files.length > 0)) {
						userFeedback = { text, images, files }
					}
					didContinue = true

					if (onProceedWhileRunning) {
						const trackingResult = onProceedWhileRunning(outputLines)
						clearChunkTimer(chunkTimerRef)
						const result = terminalManager.processOutput(outputLines)
						const logMsg = trackingResult?.logFilePath ? `Log file: ${trackingResult.logFilePath}\n` : ""
						const outputMsg = result.length > 0 ? `Output so far:\n${result}` : ""

						backgroundTrackingResult = {
							userRejected: false,
							result: `Command is running in the background. You can proceed with other tasks.\n${logMsg}${outputMsg}`,
							completed: false,
							outputLines,
						}

						if (trackingResult?.logFilePath) {
							await taskMessenger.upsertText(`\n📋 Output is being logged to: ${trackingResult.logFilePath}`)
						}
						process.continue()
						return backgroundTrackingResult
					}
					process.continue()
				} else if (response === DiracAskResponse.REJECT) {
					didCancelViaUi = true
					userFeedback = undefined
					didContinue = true
					await taskMessenger.upsertText("Command cancelled")
					process.continue()
				} else {
					userFeedback = { text, images, files }
					didContinue = true
					process.continue()
				}
			} catch (error) {
				Logger.error("Error while asking for command output", error)
			} finally {
				if (bufferStuckTimerRef.current) {
					clearTimeout(bufferStuckTimerRef.current)
					bufferStuckTimerRef.current = null
				}
			}
		} else {
			await taskMessenger.upsertText(chunk)
		}
		return null
	}

	const scheduleFlush = () => {
		if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current)
		chunkTimerRef.current = setTimeout(async () => await flushBufferFn(), CHUNK_DEBOUNCE_MS)
	}

	const clearChunkTimer = (ref: typeof chunkTimerRef) => {
		if (ref.current) {
			clearTimeout(ref.current)
			ref.current = null
		}
	}

	// ---- Line listener ----
	process.on("line", async (line: string) => {
		if (didCancelViaUi || backgroundTrackingResult) return

		const lineBytes = Buffer.byteLength(line, "utf8")
		fileState.totalOutputBytes += lineBytes
		fileState.totalLineCount++

		// Check if we should switch to file-based logging for large outputs
		if (!fileState.isWritingToFile && shouldSwitchToFile(outputLines.length, fileState.totalOutputBytes)) {
			const fileLog = createFileLog()
			fileState = { ...fileLog, totalOutputBytes: fileState.totalOutputBytes, totalLineCount: fileState.totalLineCount }
			// Write all existing lines to file in a single batch
			if (outputLines.length > 0 && fileState.largeOutputLogStream) {
				fileState.largeOutputLogStream.write(outputLines.join("\n") + "\n")
			}
			fileState = updateFirstLines(fileState, outputLines)
			await taskMessenger.upsertText(
				`\n📋 Output is large (${outputLines.length} lines, ${Math.round(fileState.totalOutputBytes / 1024)}KB). Writing to: ${fileState.largeOutputLogPath}`,
			)
		}

		if (fileState.isWritingToFile) {
			fileState = writeLineToFile(fileState, line)
		} else {
			outputLines.push(line)
		}

		if (onOutputLine) onOutputLine(line)

		if (!didContinue && !fileState.isWritingToFile) {
			outputBuffer.push(line)
			outputBufferSize += lineBytes

			if (outputBuffer.length >= CHUNK_LINE_COUNT || outputBufferSize >= CHUNK_BYTE_SIZE) {
				await flushBufferFn()
			} else {
				scheduleFlush()
			}
		} else if (!fileState.isWritingToFile && didContinue) {
			await taskMessenger.upsertText(line)
		}
	})

	// ---- Completion listener ----
	const completionState = { completed: false, details: undefined as TerminalCompletionDetails | undefined }
	const { cleanup: cleanupListeners } = attachProcessListeners(
		{ process, taskMessenger, terminalType, showShellIntegrationSuggestion },
		async (details?: TerminalCompletionDetails) => {
			completionState.completed = true
			completionState.details = details
			if (!didContinue && outputBuffer.length > 0) {
				clearChunkTimer(chunkTimerRef)
				await flushBufferFn(true)
			}
		},
	)

	// ---- Timeout handling ----
	const timeoutResult: OrchestrationResult | null = null
	if (timeoutSeconds) {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), timeoutSeconds * 1000)
		})

		try {
			await Promise.race([process, timeoutPromise])
		} catch (error: any) {
			if (error.message === "COMMAND_TIMEOUT") {
				didContinue = true
				clearChunkTimer(chunkTimerRef)

				if (onProceedWhileRunning) {
					const trackingResult = onProceedWhileRunning(outputLines)
					const result = terminalManager.processOutput(outputLines)
					const logMsg = trackingResult?.logFilePath ? `Log file: ${trackingResult.logFilePath}\n` : ""
					backgroundTrackingResult = {
						userRejected: false,
						result: `Command timed out after ${timeoutSeconds} seconds. Running in background.\n${logMsg}${result.length > 0 ? `\nOutput so far:\n${result}` : ""}`,
						completed: false,
						outputLines,
					}
					if (trackingResult?.logFilePath) {
						await taskMessenger.upsertText(
							`\n⏱️ Command timed out. Output is being logged to: ${trackingResult.logFilePath}`,
						)
					}
					process.continue()
					cleanupFileLog(fileState)
					return backgroundTrackingResult
				}

				process.continue()
				await setTimeoutPromise(50)
				const result = terminalManager.processOutput(outputLines)
				return {
					userRejected: false,
					result: `Command execution timed out after ${timeoutSeconds} seconds. ${result.length > 0 ? `\nOutput so far:\n${result}` : ""}`,
					completed: false,
					outputLines,
				}
			}
			throw error
		}
	} else {
		await process
	}

	// ---- Final result building ----
	if (backgroundTrackingResult) {
		cleanupFileLog(fileState)
		return backgroundTrackingResult
	}

	cleanupListeners()
	clearChunkTimer(chunkTimerRef)
	await setTimeoutPromise(50)
	cleanupFileLog(fileState)

	let result: string
	const resultOutputLines =
		fileState.isWritingToFile && fileState.largeOutputLogPath
			? buildFileSummary(fileState, terminalManager.processOutput.bind(terminalManager)).summaryLines
			: outputLines

	if (fileState.isWritingToFile && fileState.largeOutputLogPath) {
		result = buildFileSummary(fileState, terminalManager.processOutput.bind(terminalManager)).result
	} else {
		result = terminalManager.processOutput(outputLines)
	}

	const input: BuildResultInput = {
		userRejected: didCancelViaUi,
		result,
		completed: completionState.completed,
		outputLines: resultOutputLines as string[],
		logFilePath: fileState.largeOutputLogPath || undefined,
		exitCode: completionState.details?.exitCode,
		signal: completionState.details?.signal,
	}

	if (userFeedback) {
		await taskMessenger.upsertText(userFeedback.text || "", false, userFeedback.images, userFeedback.files)
		let fileContentString = ""
		if (userFeedback.files && userFeedback.files.length > 0) {
			fileContentString = await processFilesIntoText(userFeedback.files)
		}
		return buildResult({
			...input,
			userRejected: true,
			userFeedbackText: userFeedback.text,
			userFeedbackImages: userFeedback.images,
			userFeedbackFiles: userFeedback.files,
		})
	}

	return buildResult(input)
}

export function findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
	for (let i = array.length - 1; i >= 0; i--) {
		if (predicate(array[i])) return i
	}
	return -1
}
