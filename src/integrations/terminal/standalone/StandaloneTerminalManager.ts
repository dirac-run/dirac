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
	runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise {
		return this.processManager.runCommand(terminalInfo, command)
	}

	// --- Terminal Lifecycle ---

	/** Get or create a terminal for the specified working directory. */
	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<TerminalInfo> {
		const terminals = this.registry.getAllTerminals()

		// Find available terminal with matching CWD
		const matchingTerminal = terminals.find((t) => {
			if (t.busy) {
				return false
			}
			return t.terminal._cwd === cwd
		})

		if (matchingTerminal) {
			this.terminalIds.add(matchingTerminal.id)
			return matchingTerminal
		}

		// Find any available terminal if reuse is enabled
		if (this.terminalReuseEnabled) {
			const availableTerminal = terminals.find((t) => !t.busy)
			if (availableTerminal) {
				await this.runCommand(availableTerminal, `cd "${cwd}"`)
				availableTerminal.terminal._cwd = cwd
				availableTerminal.terminal._env = env
				if (availableTerminal.terminal.shellIntegration?.cwd) {
					availableTerminal.terminal.shellIntegration.cwd.fsPath = cwd
				}
				this.terminalIds.add(availableTerminal.id)
				return availableTerminal
			}
		}

		// Create new terminal
		const newTerminalInfo = this.registry.createTerminal({
			cwd: cwd,
			name: `Dirac Terminal ${this.registry.size + 1}`,
			env: env,
		})
		this.terminalIds.add(newTerminalInfo.id)
		return newTerminalInfo
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
	disposeAll(): void {
		// Dispose background commands first
		this.processManager.disposeBackgroundCommands()

		// Terminate all processes
		this.processManager.terminateAll()

		// Clear all tracking
		this.terminalIds.clear()
		this.processManager.clearProcesses()

		// Dispose all terminals
		for (const terminalInfo of this.registry.getAllTerminals()) {
			terminalInfo.terminal.dispose()
		}

		this.registry.clear()
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
		const closedCount = this.closeTerminals(
			(terminal) => !terminal.busy && terminal.shellPath !== newShellPath,
			false,
		)
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
	): BackgroundCommand {
		return this.processManager.trackBackgroundCommand(process, command, existingOutput)
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
	cancelBackgroundCommand(id: string): boolean {
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
