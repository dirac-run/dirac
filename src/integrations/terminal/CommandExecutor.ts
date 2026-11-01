/**
 * CommandExecutor - Unified command execution for all terminal modes.
 *
 * This class handles command execution for both VSCode terminal mode and
 * standalone/CLI mode. It uses the shared CommandOrchestrator for the
 * common orchestration logic (buffering, user interaction, result formatting).
 *
 * The differentiation between modes happens at the TerminalManager level:
 * - VscodeTerminalManager → VscodeTerminalProcess (shell integration)
 * - StandaloneTerminalManager → StandaloneTerminalProcess (child_process)
 *
 * IMPORTANT: Background execution mode uses StandaloneTerminalManager to run
 * commands in hidden terminals without cluttering the visible terminal.
 */

import { findLastIndex } from "@shared/array"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import { StandaloneTerminalManager } from "./standalone/StandaloneTerminalManager"
import type {
	CommandExecutionMetadata,
	CommandExecutionOptions,
	CommandExecutionResult,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalProcessResultPromise,
} from "./types"

function waitForTerminalProcessCompletion(process: TerminalProcessResultPromise): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false
		const settle = () => {
			if (settled) return
			settled = true
			resolve()
		}
		process.once("completed", settle)
		process.once("error", settle)
	})
}

interface CommandExecution {
	cancelled: boolean
	process?: TerminalProcessResultPromise
}


export class CommandExecutor {
	private cwd: string
	private taskId: string
	private ulid: string
	private terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	private terminalManager: ITerminalManager
	private standaloneManager: StandaloneTerminalManager
	private callbacks: CommandExecutorCallbacks

	// Track the currently executing foreground process for cancellation
	private currentProcess: TerminalProcessResultPromise | null = null

	private executions = new Set<CommandExecution>()
	private disposed = false
	private disposal?: Promise<void>
	private cancellation?: Promise<boolean>

	// Track shell integration warnings to determine when to show background terminal suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(config: CommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.cwd = config.cwd
		this.taskId = config.taskId
		this.ulid = config.ulid
		this.terminalExecutionMode = config.terminalExecutionMode
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks

		// When in backgroundExec mode, the terminalManager is already a StandaloneTerminalManager
		// created by Task. We should reuse it so that Task.getEnvironmentDetails() can see
		// the terminals and processes we create (for isHot logic, busy terminals, etc.)
		if (config.terminalExecutionMode === "backgroundExec" && config.terminalManager instanceof StandaloneTerminalManager) {
			// Reuse the same instance that Task is using
			this.standaloneManager = config.terminalManager
			Logger.info(`[CommandExecutor] Reusing Task's StandaloneTerminalManager for backgroundExec mode`)
		} else {
			// Create a standalone manager for background execution support.
			this.standaloneManager = new StandaloneTerminalManager()
			Logger.info(`[CommandExecutor] Created new StandaloneTerminalManager`)

			// Copy settings from the provided terminalManager to ensure consistency
			if ("shellIntegrationTimeout" in config.terminalManager) {
				const tm = config.terminalManager as any
				this.standaloneManager.setShellIntegrationTimeout(tm.shellIntegrationTimeout || 4000)
				this.standaloneManager.setTerminalReuseEnabled(tm.terminalReuseEnabled ?? true)
				this.standaloneManager.setTerminalOutputLineLimit(tm.terminalOutputLineLimit || 500)
			}
		}
	}

	execute(command: string, timeoutSeconds: number | undefined, options?: CommandExecutionOptions): Promise<CommandExecutionResult> {
		if (this.disposed) return Promise.reject(new Error("Command executor is disposed"))
		if (this.cancellation) return Promise.reject(new Error("Command cancellation is in progress"))
		const execution: CommandExecution = { cancelled: false }
		this.executions.add(execution)
		return this.executeCommand(execution, command, timeoutSeconds, options).finally(() => {
			this.executions.delete(execution)
		})
	}

	private async executeCommand(
		execution: CommandExecution,
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<CommandExecutionResult> {
		const workspaceCdPrefix = `cd ${this.cwd} && `
		if (command.startsWith(workspaceCdPrefix)) {
			command = command.substring(workspaceCdPrefix.length)
		}

		const useStandalone = options?.useBackgroundExecution || this.terminalExecutionMode === "backgroundExec"
		const manager: ITerminalManager = useStandalone ? this.standaloneManager : this.terminalManager

		const env = await this.callbacks.getEnvironmentVariables(this.cwd)
		if (execution.cancelled) return [true, "Command was cancelled before terminal acquisition."]
		Logger.info(`Executing command in ${useStandalone ? "standalone" : "VSCode"} terminal: ${command}`)

		const terminalInfo = await manager.getOrCreateTerminal(this.cwd, env)
		if (execution.cancelled) {
			manager.releaseTerminalReservation?.(terminalInfo)
			return [true, "Command was cancelled before startup."]
		}
		terminalInfo.terminal.show()
		const process = manager.runCommand(terminalInfo, command)

		execution.process = process
		this.currentProcess = process
		const clearCurrentProcess = () => {
			if (this.currentProcess === process) this.currentProcess = null
		}
		process.once("completed", clearCurrentProcess)
		process.once("error", clearCurrentProcess)

		const result = await orchestrateCommandExecution(process, manager, this.callbacks, {
			command,
			timeoutSeconds,
			suppressUserInteraction: options?.suppressUserInteraction,
			onProceedWhileRunning: useStandalone
				? (existingOutput: string[], existingLogFilePath?: string, existingOutputReady?: Promise<void>) => {
					const backgroundCmd = this.standaloneManager.trackBackgroundCommand(
						process,
						command,
						existingOutput,
						existingLogFilePath,
						existingOutputReady,
					)
					return {
						logFilePath: backgroundCmd.logFilePath,
						outputReady: existingOutputReady,
						completion: waitForTerminalProcessCompletion(process),
					}
				}
				: undefined,
			showShellIntegrationSuggestion: this.shouldShowBackgroundTerminalSuggestion(),
			terminalType: useStandalone ? "standalone" : "vscode",
		})

		const metadata: CommandExecutionMetadata = {
			completed: result.completed,
			exitCode: result.exitCode,
			signal: result.signal,
			logFilePath: result.logFilePath,
			backgroundCompletion: result.backgroundCompletion,
		}

		if (execution.cancelled) {
			const outputSoFar =
				result.outputLines.length > 0
					? `\nOutput captured before cancellation:\n${manager.processOutput(result.outputLines)}`
					: ""
			return [true, `Command was cancelled by the user.${outputSoFar}`, metadata]
		}

		return [result.userRejected, result.result, metadata]
	}

	/**
	 * Cancel all running commands (both foreground and background).
	 *
	 * This method cancels:
	 * 1. All detached background commands (those that were "proceeded while running")
	 * 2. The current foreground process (if one is actively running)
	 *
	 * @returns true if any commands were cancelled, false otherwise
	 */
	cancelBackgroundCommand(): Promise<boolean> {
		if (this.cancellation) return this.cancellation
		const cancellation = this.cancelCommands()
		this.cancellation = cancellation
		void cancellation.finally(() => { if (this.cancellation === cancellation) this.cancellation = undefined }).catch(() => { })
		return cancellation
	}

	private async cancelCommands(notifyUser = true): Promise<boolean> {
		const executions = [...this.executions]
		for (const execution of executions) execution.cancelled = true
		const processes = new Set(executions.flatMap((execution) => execution.process ? [execution.process] : []))
		if (this.currentProcess) processes.add(this.currentProcess)
		const runningCommands = this.standaloneManager.getRunningBackgroundCommands()
		const cancelled = executions.length > 0 || processes.size > 0 || runningCommands.length > 0
		const results = await Promise.allSettled([
			...runningCommands.map((command) => this.standaloneManager.cancelBackgroundCommand(command.id)),
			...Array.from(processes, (process) => Promise.resolve().then(() => process.terminate?.())),
		])
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Command cancellation failed")
		if (this.currentProcess && processes.has(this.currentProcess)) this.currentProcess = null

		if (cancelled) this.callbacks.updateBackgroundCommandState(false)
		if (cancelled && notifyUser) {
			// Find the last command_output message and update it
			const messages = this.callbacks.getDiracMessages()
			const lastCommandOutputIndex = findLastIndex(
				messages,
				(m) => m.content.type === "card" && m.content.card.header === "Command Output",
			)
			if (lastCommandOutputIndex !== -1) {
				const msg = messages[lastCommandOutputIndex]
				if (msg.content.type === "card") {
					const existingText = msg.content.card.body || ""
					const cancellationNotice = "\n\nCommand(s) cancelled by user."
					await this.callbacks.updateDiracMessage(lastCommandOutputIndex, {
						content: {
							...msg.content,
							card: {
								...msg.content.card,
								body: existingText + cancellationNotice,
								status: (await import("@shared/ExtensionMessage")).CardStatus.CANCELLED,
							},
						},
					})
				}
			}
		}

		return cancelled
	}

	/** Stop commands and dispose the owned hidden pool; the task owns the primary manager. */
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.disposed = true
		this.disposal = (async () => {
			const results = await Promise.allSettled([
				this.cancellation ?? this.cancelCommands(false),
				...(this.standaloneManager !== this.terminalManager ? [this.standaloneManager.disposeAll()] : []),
			])
			const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Command executor cleanup failed")
		})()
		return this.disposal
	}

	/**
	 * Check if there are any active background commands.
	 * Delegates to StandaloneTerminalManager.
	 */
	hasActiveBackgroundCommand(): boolean {
		return this.standaloneManager.hasActiveBackgroundCommands()
	}

	/**
	 * Get a summary of background commands for environment details.
	 * Delegates to StandaloneTerminalManager which tracks multiple commands.
	 */
	getBackgroundCommandSummary(): string | undefined {
		const summary = this.standaloneManager.getBackgroundCommandsSummary()
		return summary || undefined
	}

	/**
	 * Determines whether to show the background terminal suggestion.
	 * Shows suggestion if there have been 3+ shell integration warnings in the last hour,
	 * and we haven't shown the suggestion in the last hour.
	 *
	 * @returns true if the suggestion should be shown, false otherwise
	 */
	private shouldShowBackgroundTerminalSuggestion(): boolean {
		const oneHourAgo = Date.now() - 60 * 60 * 1000

		// Clean old timestamps (older than 1 hour)
		this.shellIntegrationWarningTracker.timestamps = this.shellIntegrationWarningTracker.timestamps.filter(
			(ts) => ts > oneHourAgo,
		)

		// Add current warning
		this.shellIntegrationWarningTracker.timestamps.push(Date.now())

		// Check if we've shown suggestion recently (within last hour)
		if (
			this.shellIntegrationWarningTracker.lastSuggestionShown &&
			Date.now() - this.shellIntegrationWarningTracker.lastSuggestionShown < 60 * 60 * 1000
		) {
			return false
		}

		// Show suggestion if 3+ warnings in last hour
		if (this.shellIntegrationWarningTracker.timestamps.length >= 3) {
			this.shellIntegrationWarningTracker.lastSuggestionShown = Date.now()
			return true
		}

		return false
	}
}
