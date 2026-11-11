/**
 * StandaloneTerminalManager - Main terminal manager for standalone environments.
 *
 * This class provides the same interface as VSCode's TerminalManager but works
 * in CLI and JetBrains environments by using subprocess management instead of
 * VSCode's terminal API.
 *
 * Process spawning and background command tracking are delegated to TerminalProcessManager.
 */

import { DEFAULT_TERMINAL_OUTPUT_LINE_LIMIT } from "../constants"
import type { PreparedSandboxLaunch } from "../sandbox"
import type {
	BackgroundCommand,
	ITerminalManager,
	TerminalInfo,
	TerminalProcessResultPromise,
	TerminalProfileChangeResult,
} from "../types"
import { StandaloneTerminalRegistry } from "./StandaloneTerminalRegistry"
import { TerminalProcessManager } from "./TerminalProcessManager"

// Re-export BackgroundCommand for backwards compatibility
export type { BackgroundCommand }

/**
 * Terminal manager for standalone (non-VSCode) environments.
 * Implements ITerminalManager for compatibility with the Task class.
 */
export class StandaloneTerminalManager implements ITerminalManager {
	/** Registry for tracking terminals */
	private registry: StandaloneTerminalRegistry = new StandaloneTerminalRegistry()

	/** Process manager for spawning commands and tracking background commands */
	private processManager: TerminalProcessManager = new TerminalProcessManager()

	/** Set of terminal IDs managed by this instance */
	private terminalIds: Set<number> = new Set()
	private reservations = new Set<number>()
	private disposed = false
	private disposal?: Promise<void>

	/** Timeout for shell integration (kept for interface compatibility, not used in standalone) */
	private shellIntegrationTimeout = 4000

	/** Whether terminal reuse is enabled */
	private terminalReuseEnabled = true

	/** Maximum output lines to keep */
	private terminalOutputLineLimit: number = DEFAULT_TERMINAL_OUTPUT_LINE_LIMIT

	/** Default terminal profile */
	private defaultTerminalProfile = "default"

	/** Disposables array (for VSCode compatibility) */
	disposables: any[] = []

	// --- Process Spawning (delegated to TerminalProcessManager) ---

	/** Run a command in the specified terminal. */
	runCommand(terminalInfo: TerminalInfo, command: string, sandbox?: PreparedSandboxLaunch): TerminalProcessResultPromise {
		if (this.disposed) throw new Error("Terminal manager is disposed")
		const process = this.processManager.runCommand(terminalInfo, command, sandbox)
		this.reservations.delete(terminalInfo.id)
		return process
	}

	/** Release an acquisition cancelled before a process was started. */
	releaseTerminalReservation(terminalInfo: TerminalInfo): void {
		if (this.reservations.delete(terminalInfo.id)) terminalInfo.busy = false
	}

	/** Reserve a terminal synchronously before returning it to a command execution. */
	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<TerminalInfo> {
		if (this.disposed) throw new Error("Terminal manager is disposed")
		const terminals = this.registry.getAllTerminals()
		const matchingTerminal = terminals.find((terminal) => !terminal.busy && terminal.terminal._cwd === cwd)
		const reusableTerminal = this.terminalReuseEnabled ? terminals.find((terminal) => !terminal.busy) : undefined
		const terminalInfo = matchingTerminal ?? reusableTerminal ?? this.registry.createTerminal({
			cwd,
			name: `Dirac Terminal ${this.registry.size + 1}`,
			env,
		})
		// Standalone commands spawn a fresh process; cwd is spawn data, never shell source.
		terminalInfo.terminal._cwd = cwd
		terminalInfo.terminal._env = env
		if (terminalInfo.terminal.shellIntegration?.cwd) {
			terminalInfo.terminal.shellIntegration.cwd.fsPath = cwd
		}
		terminalInfo.busy = true
		this.terminalIds.add(terminalInfo.id)
		this.reservations.add(terminalInfo.id)
		return terminalInfo
	}

	/** Get terminals filtered by busy state. */
	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		const allTerminalIds = Array.from(this.terminalIds)

		return allTerminalIds
			.map((id) => this.registry.getTerminal(id))
			.filter((t): t is TerminalInfo => t !== undefined && t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

	// --- Process State Queries (delegated to TerminalProcessManager) ---

	/** Get output that hasn't been retrieved yet from a terminal. */
	getUnretrievedOutput(terminalId: number): string {
		if (!this.terminalIds.has(terminalId)) {
			return ""
		}
		return this.processManager.getUnretrievedOutput(terminalId)
	}

	/** Check if a terminal's process is actively outputting. */
	isProcessHot(terminalId: number): boolean {
		return this.processManager.isProcessHot(terminalId)
	}

	// --- Output Processing ---

	/** Process output lines, truncating if over limit. */
	processOutput(outputLines: string[], overrideLimit?: number): string {
		const limit = overrideLimit !== undefined ? overrideLimit : this.terminalOutputLineLimit
		if (outputLines.length > limit) {
			const halfLimit = Math.floor(limit / 2)
			const start = outputLines.slice(0, halfLimit)
			const end = outputLines.slice(outputLines.length - halfLimit)
			return `${start.join("\n")}\n... (output truncated) ...\n${end.join("\n")}`.trim()
		}
		return outputLines.join("\n").trim()
	}

	// --- Cleanup ---

	/** Dispose of all terminals and clean up resources. */
	disposeAll(): Promise<void> {
		if (this.disposal) return this.disposal
		this.disposed = true
		this.disposal = (async () => {
			this.processManager.disposeBackgroundCommands()
			try {
				await this.processManager.terminateAll()
			} finally {
				this.terminalIds.clear()
				this.reservations.clear()
				this.processManager.clearProcesses()
				this.registry.clear()
			}
		})()
		return this.disposal
	}

	// --- Configuration Setters ---

	/** Set the timeout for waiting for shell integration. */
	setShellIntegrationTimeout(timeout: number): void {
		this.shellIntegrationTimeout = timeout
	}

	/** Enable or disable terminal reuse. */
	setTerminalReuseEnabled(enabled: boolean): void {
		this.terminalReuseEnabled = enabled
	}

	/** Set the maximum number of output lines to keep. */
	setTerminalOutputLineLimit(limit: number): void {
		this.terminalOutputLineLimit = limit
	}

	/** Set the default terminal profile. Returns info about closed and remaining busy terminals. */
	setDefaultTerminalProfile(profile: string): TerminalProfileChangeResult {
		const previousProfile = this.defaultTerminalProfile
		this.defaultTerminalProfile = profile

		if (previousProfile !== profile) {
			return this.handleTerminalProfileChange(profile)
		}

		return { closedCount: 0, busyTerminals: [] }
	}

	// --- Terminal Management ---

	/** Find a TerminalInfo by its terminal instance. */
	findTerminalInfoByTerminal(terminal: any): TerminalInfo | undefined {
		return this.registry.getAllTerminals().find((t) => t.terminal === terminal)
	}

	/** Check if a terminal's CWD matches its expected pending change. */
	isCwdMatchingExpected(terminalInfo: TerminalInfo): boolean {
		if (!terminalInfo.pendingCwdChange) {
			return false
		}
		const currentCwd = terminalInfo.terminal._cwd
		const targetCwd = terminalInfo.pendingCwdChange
		return currentCwd === targetCwd
	}

	/** Filter terminals based on a provided criteria function. */
	filterTerminals(filterFn: (terminal: TerminalInfo) => boolean): TerminalInfo[] {
		return this.registry.getAllTerminals().filter(filterFn)
	}

	/** Close terminals that match the provided criteria. Returns number of terminals closed. */
	closeTerminals(filterFn: (terminal: TerminalInfo) => boolean, force = false): number {
		const terminalsToClose = this.filterTerminals(filterFn)
		let closedCount = 0

		for (const terminalInfo of terminalsToClose) {
			if (terminalInfo.busy && !force) {
				continue
			}

			this.terminalIds.delete(terminalInfo.id)
			this.processManager.removeProcess(terminalInfo.id)
			terminalInfo.terminal.dispose()
			this.registry.removeTerminal(terminalInfo.id)
			closedCount++
		}

		return closedCount
	}

	/** Handle terminal management when the terminal profile changes. */
	handleTerminalProfileChange(newShellPath: string | undefined): TerminalProfileChangeResult {
		const closedCount = this.closeTerminals((terminal) => !terminal.busy && terminal.shellPath !== newShellPath, false)
		const busyTerminals = this.filterTerminals((terminal) => terminal.busy && terminal.shellPath !== newShellPath)
		return { closedCount, busyTerminals }
	}

	/** Force closure of all terminals (including busy ones). Returns number closed. */
	closeAllTerminals(): number {
		return this.closeTerminals(() => true, true)
	}

	// --- Background Command Tracking (delegated to TerminalProcessManager) ---

	/** Track a command running in the background. */
	trackBackgroundCommand(
		process: TerminalProcessResultPromise,
		command: string,
		existingOutput: string[] = [],
		existingLogFilePath?: string,
		existingOutputReady?: Promise<void>,
	): BackgroundCommand {
		return this.processManager.trackBackgroundCommand(
			process,
			command,
			existingOutput,
			existingLogFilePath,
			existingOutputReady,
		)
	}

	/** Get a specific background command by ID. */
	getBackgroundCommand(id: string): BackgroundCommand | undefined {
		return this.processManager.getBackgroundCommand(id)
	}

	/** Get all tracked background commands. */
	getAllBackgroundCommands(): BackgroundCommand[] {
		return this.processManager.getAllBackgroundCommands()
	}

	/** Get only running background commands. */
	getRunningBackgroundCommands(): BackgroundCommand[] {
		return this.processManager.getRunningBackgroundCommands()
	}

	/** Check if there are any active background commands. */
	hasActiveBackgroundCommands(): boolean {
		return this.processManager.hasActiveBackgroundCommands()
	}

	/** Cancel/terminate a specific background command. */
	cancelBackgroundCommand(id: string): Promise<boolean> {
		return this.processManager.cancelBackgroundCommand(id)
	}

	/** Get a summary string for environment details. */
	getBackgroundCommandsSummary(): string {
		return this.processManager.getBackgroundCommandsSummary()
	}

	/** Clean up all background command resources. */
	disposeBackgroundCommands(): void {
		this.processManager.disposeBackgroundCommands()
	}
}
