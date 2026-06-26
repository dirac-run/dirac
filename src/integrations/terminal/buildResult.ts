/**
 * buildResult - Pure-ish function for building orchestration results.
 *
 * Takes all needed state as parameters (no closure/shared mutable state).
 * This is Strategy 5: functional composition with direct params.
 */

import { formatResponse } from "@core/formatResponse"
import type { OrchestrationResult } from "./types"

export interface BuildResultInput {
	userRejected: boolean
	result: string
	completed: boolean
	outputLines: string[]
	logFilePath?: string
	exitCode?: number | null
	signal?: NodeJS.Signals | null
	userFeedbackText?: string
	userFeedbackImages?: string[]
	userFeedbackFiles?: string[]
}

export function buildResult(input: BuildResultInput): OrchestrationResult {
	if (input.userRejected && input.userFeedbackText) {
		return {
			userRejected: true,
			result: formatResponse.toolResult(
				`Command is still running in the user's terminal.${
					input.result.length > 0 ? `\nHere's the output so far:\n${input.result}` : ""
				}\n\nThe user provided the following feedback:\n<feedback>\n${input.userFeedbackText}\n</feedback>`,
				input.userFeedbackImages,
				input.userFeedbackFiles?.join("\n") || "",
			),
			completed: false,
			outputLines: input.outputLines,
			logFilePath: input.logFilePath,
			exitCode: input.exitCode,
			signal: input.signal,
		}
	}

	if (input.userRejected) {
		return {
			userRejected: true,
			result: formatResponse.toolResult(
				`Command cancelled. ${input.result.length > 0 ? `\nOutput captured before cancellation:\n${input.result}` : ""}`,
			),
			completed: false,
			outputLines: input.outputLines,
			logFilePath: input.logFilePath,
			exitCode: input.exitCode,
			signal: input.signal,
		}
	}

	if (input.completed) {
		const hasExitCode = typeof input.exitCode === "number"
		const logFileMsg = input.logFilePath ? `\nFull output saved to: ${input.logFilePath}` : ""
		const statusMessage = hasExitCode
			? input.exitCode === 0
				? "Command executed successfully (exit code 0)."
				: `Command failed with exit code ${input.exitCode}.`
			: input.signal
				? `Command terminated by signal ${input.signal}.`
				: "Command executed."

		return {
			userRejected: false,
			result: `${statusMessage}${input.result.length > 0 ? `\nOutput:\n${input.result}` : ""}${logFileMsg}`,
			completed: true,
			outputLines: input.outputLines,
			logFilePath: input.logFilePath,
			exitCode: input.exitCode,
			signal: input.signal,
		}
	}

	const logFileMsg = input.logFilePath ? `\nFull output saved to: ${input.logFilePath}` : ""
	return {
		userRejected: false,
		result: `Command is still running in the user's terminal.${
			input.result.length > 0 ? `\nHere's the output so far:\n${input.result}` : ""
		}${logFileMsg}\n\nYou will be updated on the terminal status and new output in the future.`,
		completed: false,
		outputLines: input.outputLines,
		logFilePath: input.logFilePath,
		exitCode: input.exitCode,
		signal: input.signal,
	}
}
