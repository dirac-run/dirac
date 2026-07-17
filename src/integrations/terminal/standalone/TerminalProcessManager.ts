/**
 * TerminalProcessManager - Manages terminal process lifecycle and background command tracking.
 *
 * Extracted from StandaloneTerminalManager to separate process spawning/management
 * from terminal registry and configuration concerns.
 *
 * Responsibilities:
 * - Spawning terminal processes (runCommand)
 * - Tracking process state (getUnretrievedOutput, isProcessHot)
 * - Background command tracking for "Proceed While Running" functionality:
 *   - Logs output to temp files for later retrieval
 *   - Tracks command status (running, completed, error, timed_out)
 *   - Implements 10-minute hard timeout to prevent zombie processes
 *   - Provides summary for environment details
 */

import { DiracTempManager } from "@services/temp"
import * as fs from "fs"
import { BACKGROUND_COMMAND_TIMEOUT_MS } from "../constants"
import type { BackgroundCommand, TerminalInfo, TerminalProcessResultPromise } from "../types"
import { StandaloneTerminalProcess } from "./StandaloneTerminalProcess"

/** Merge a process with a promise so the result is both awaitable and has event methods. */
function mergePromise(process: StandaloneTerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
	const nativePromisePrototype = (async () => { })().constructor.prototype
	const descriptors = ["then", "catch", "finally"].map((property) => [
		property,
		Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property),
	]) as [string, PropertyDescriptor][]

	for (const [property, descriptor] of descriptors) {
		if (descriptor) {
			const value = (descriptor.value as Function).bind(promise)
			Reflect.defineProperty(process, property, { ...descriptor, value })
		}
	}

	// Ensure terminate() is accessible on the merged promise — allows Task.cancelBackgroundCommand() to kill the process
	if (process.terminate && typeof process.terminate === "function") {
		Object.defineProperty(process, "terminate", {
			value: process.terminate.bind(process),
			writable: false,
			enumerable: false,
			configurable: false,
		})
	}

	return process as unknown as TerminalProcessResultPromise
}

export class TerminalProcessManager {
	/** Map of terminal ID to process */
	private processes: Map<number, StandaloneTerminalProcess> = new Map()

	/** Map of background command ID to command info */
	private backgroundCommands: Map<string, BackgroundCommand> = new Map()

	/** Map of background command ID to log file write stream */
	private logStreams: Map<string, fs.WriteStream> = new Map()
	private backgroundLogFinalizers: Map<string, (suffix?: string) => void> = new Map()

	/** Map of background command ID to timeout handle */
	private backgroundTimeouts: Map<string, NodeJS.Timeout> = new Map()

	// =========================================================================
	// Process Spawning
	// =========================================================================

	/** Spawn a command in the specified terminal, returning a merged promise/process object. */
	runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise {
		terminalInfo.busy = true
		terminalInfo.lastCommand = command

		const process = new StandaloneTerminalProcess()
		this.processes.set(terminalInfo.id, process)

		process.once("completed", () => {
			terminalInfo.busy = false
		})

		process.once("error", (_error: Error) => {
			terminalInfo.busy = false
		})

		// Create promise that resolves on continue or rejects on error
		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => resolve())
			process.once("error", (error: Error) => reject(error))
		})

		// Run the command immediately (no shell integration wait needed)
		process.run(terminalInfo.terminal, command)

		return mergePromise(process, promise)
	}

	// =========================================================================
	// Process State Queries
	// =========================================================================

	/** Get output that hasn't been retrieved yet from a terminal's process. */
	getUnretrievedOutput(terminalId: number): string {
		const process = this.processes.get(terminalId)
		return process ? process.getUnretrievedOutput() : ""
	}

	/** Check if a terminal's process is actively outputting. */
	isProcessHot(terminalId: number): boolean {
		const process = this.processes.get(terminalId)
		return process ? process.isHot : false
	}

	// =========================================================================
	// Process Cleanup
	// =========================================================================

	/** Remove a process from tracking (used when closing a terminal). */
	removeProcess(terminalId: number): void {
		this.processes.delete(terminalId)
	}

	/** Terminate all tracked processes. */
	terminateAll(): void {
		for (const [_terminalId, process] of this.processes) {
			if (process?.terminate) {
				process.terminate()
			}
		}
	}

	/** Clear all process tracking (does not terminate — call terminateAll first). */
	clearProcesses(): void {
		this.processes.clear()
	}

	trackBackgroundCommand(
		process: TerminalProcessResultPromise,
		command: string,
		existingOutput: string[] = [],
		existingLogFilePath?: string,
		existingOutputReady: Promise<void> = Promise.resolve(),
	): BackgroundCommand {
		const id = `background-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
		const logFilePath = existingLogFilePath ?? DiracTempManager.createTempFilePath("background")

		const backgroundCommand: BackgroundCommand = {
			id,
			command,
			startTime: Date.now(),
			status: "running",
			logFilePath,
			lineCount: existingOutput.length,
			process,
		}

		const logStream = fs.createWriteStream(logFilePath, { flags: "a" })
		this.logStreams.set(id, logStream)
		const pendingLines: string[] = []
		let backgroundLoggingReady = false
		let finalizationRequested = false
		let finalizationPerformed = false
		let finalizationSuffix = ""

		const onLine = (line: string) => {
			backgroundCommand.lineCount++
			if (backgroundLoggingReady) {
				logStream.write(`${line}\n`)
			} else {
				pendingLines.push(line)
			}
		}
		process.on("line", onLine)

		const performFinalization = () => {
			if (!backgroundLoggingReady || !finalizationRequested || finalizationPerformed) return
			finalizationPerformed = true
			process.off("line", onLine)
			if (finalizationSuffix) logStream.write(finalizationSuffix)
			logStream.end()
			this.logStreams.delete(id)
			this.backgroundLogFinalizers.delete(id)
		}
		const requestFinalization = (suffix = "") => {
			if (finalizationRequested) return
			finalizationRequested = true
			finalizationSuffix = suffix
			setTimeout(performFinalization, 50)
		}
		this.backgroundLogFinalizers.set(id, requestFinalization)

		const markLoggingReady = (handoffError?: unknown) => {
			backgroundLoggingReady = true
			if (handoffError) {
				backgroundCommand.status = "error"
				logStream.write(`\n[LOG_HANDOFF_ERROR] ${handoffError instanceof Error ? handoffError.message : String(handoffError)}\n`)
				requestFinalization()
			}
			for (const line of pendingLines) logStream.write(`${line}\n`)
			pendingLines.length = 0
			performFinalization()
		}

		let logReady = existingOutputReady
		if (!existingLogFilePath && existingOutput.length > 0) {
			logReady = logReady.then(
				() =>
					new Promise<void>((resolve, reject) => {
						logStream.write(`${existingOutput.join("\n")}\n`, (error) => (error ? reject(error) : resolve()))
					}),
			)
		}
		void logReady.then(() => markLoggingReady(), (error) => markLoggingReady(error))

		logStream.on("error", () => {
			backgroundCommand.status = "error"
			process.off("line", onLine)
			const timeout = this.backgroundTimeouts.get(id)
			if (timeout) clearTimeout(timeout)
			this.backgroundTimeouts.delete(id)
			this.logStreams.delete(id)
			this.backgroundLogFinalizers.delete(id)
		})

		const timeoutId = setTimeout(() => {
			if (backgroundCommand.status === "running") {
				backgroundCommand.status = "timed_out"
				requestFinalization("\n[TIMEOUT] Process killed after 10 minutes\n")
				if (process?.terminate) process.terminate()
			}
		}, BACKGROUND_COMMAND_TIMEOUT_MS)
		this.backgroundTimeouts.set(id, timeoutId)

		process.on("completed", (details) => {
			if (backgroundCommand.status !== "running") return
			const timeout = this.backgroundTimeouts.get(id)
			if (timeout) clearTimeout(timeout)
			this.backgroundTimeouts.delete(id)
			const exitCode = details?.exitCode
			const signal = details?.signal
			if (typeof exitCode === "number") backgroundCommand.exitCode = exitCode

			if ((typeof exitCode === "number" && exitCode !== 0) || signal) {
				backgroundCommand.status = "error"
				requestFinalization(
					[
						typeof exitCode === "number" && exitCode !== 0
							? `\n[EXIT_CODE] Process exited with code ${exitCode}\n`
							: "",
						signal ? `\n[SIGNAL] Process terminated by signal ${signal}\n` : "",
					].join(""),
				)
			} else {
				backgroundCommand.status = "completed"
				requestFinalization()
			}
		})

		process.on("error", (error: Error) => {
			if (backgroundCommand.status !== "running") return
			const timeout = this.backgroundTimeouts.get(id)
			if (timeout) clearTimeout(timeout)
			this.backgroundTimeouts.delete(id)
			backgroundCommand.status = "error"
			const exitCodeMatch = error.message.match(/exit code (\d+)/)
			if (exitCodeMatch) backgroundCommand.exitCode = Number.parseInt(exitCodeMatch[1], 10)
			requestFinalization()
		})

		this.backgroundCommands.set(id, backgroundCommand)
		return backgroundCommand
	}

	/** Get a specific background command by ID. */
	getBackgroundCommand(id: string): BackgroundCommand | undefined {
		return this.backgroundCommands.get(id)
	}

	/** Get all tracked background commands. */
	getAllBackgroundCommands(): BackgroundCommand[] {
		return Array.from(this.backgroundCommands.values())
	}

	/** Get only running background commands. */
	getRunningBackgroundCommands(): BackgroundCommand[] {
		return this.getAllBackgroundCommands().filter((c) => c.status === "running")
	}

	/** Check if there are any active background commands. */
	hasActiveBackgroundCommands(): boolean {
		return this.getRunningBackgroundCommands().length > 0
	}

	/** Cancel/terminate a specific background command. Returns true if cancelled, false if not found or already completed. */
	cancelBackgroundCommand(id: string): boolean {
		const command = this.backgroundCommands.get(id)
		if (!command || command.status !== "running") {
			return false
		}

		// Clear timeout
		const timeout = this.backgroundTimeouts.get(id)
		if (timeout) {
			clearTimeout(timeout)
			this.backgroundTimeouts.delete(id)
		}

		// Close the log after any foreground-output handoff has finished.
		this.backgroundLogFinalizers.get(id)?.("\n[CANCELLED] Command cancelled by user\n")
		this.backgroundLogFinalizers.delete(id)

		// Terminate process
		if (command.process?.terminate) {
			command.process.terminate()
		}

		command.status = "error"
		return true
	}

	/** Get a summary string for environment details showing running background commands. */
	getBackgroundCommandsSummary(): string {
		const running = this.getRunningBackgroundCommands()
		if (running.length === 0) {
			return ""
		}

		const lines = [`# Background Commands (${running.length} running)`]
		for (const c of running) {
			const duration = Math.round((Date.now() - c.startTime) / 1000 / 60)
			lines.push(`- ${c.command} (running ${duration}m, ${c.lineCount} lines, log: ${c.logFilePath})`)
		}
		return lines.join("\n")
	}

	/** Clean up all background command resources (timeouts, log streams, tracking maps). */
	disposeBackgroundCommands(): void {
		// Clear all timeouts
		for (const [_id, timeout] of this.backgroundTimeouts) {
			clearTimeout(timeout)
		}
		this.backgroundTimeouts.clear()

		// Request orderly closure after any pending output handoff is complete.
		for (const finalizeLog of this.backgroundLogFinalizers.values()) finalizeLog()
		this.backgroundLogFinalizers.clear()

		// Clear command tracking
		this.backgroundCommands.clear()
	}
}
