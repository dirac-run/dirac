import { arePathsEqual } from "@utils/path"
import { getPythonEnvironmentVariables } from "@utils/python"
import { getShellForProfile } from "@utils/shell"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { type TerminalInfo as RegTerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

export interface TerminalPoolOptions {
	terminalReuseEnabled: boolean
	defaultTerminalProfile: string
}

export class TerminalLifecycleManager {
	private shellIntegrationTimeout = 4000

	constructor(private options: TerminalPoolOptions) {}

	setTerminalReuseEnabled(enabled: boolean): void {
		this.options.terminalReuseEnabled = enabled
	}

	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<RegTerminalInfo> {
		if (!env) {
			env = await getPythonEnvironmentVariables(vscode.Uri.file(cwd))
		}

		const expectedShellPath =
			this.options.defaultTerminalProfile !== "default"
				? getShellForProfile(this.options.defaultTerminalProfile)
				: undefined

		const allTerminals = TerminalRegistry.getAllTerminals()
		Logger.log(`[TerminalLifecycleManager] Looking for terminal in cwd: ${cwd}`)
		Logger.log(`[TerminalLifecycleManager] Available terminals: ${allTerminals.length}`)

		const matchingTerminal = this.findMatchingTerminal(allTerminals, expectedShellPath, cwd)
		if (matchingTerminal) {
			Logger.log(`[TerminalLifecycleManager] Found matching terminal ${matchingTerminal.id} in correct cwd`)
			return matchingTerminal as unknown as RegTerminalInfo
		}

		if (this.options.terminalReuseEnabled) {
			const availableTerminal = this.findAvailableTerminal(allTerminals, expectedShellPath)
			if (availableTerminal) {
				return await this.reuseTerminalWithCwd(availableTerminal, cwd)
			}
		}

		const newTerminalInfo = TerminalRegistry.createTerminal(cwd, expectedShellPath, env)
		return newTerminalInfo as unknown as RegTerminalInfo
	}

	private findMatchingTerminal(
		terminals: RegTerminalInfo[],
		expectedShellPath: string | undefined,
		cwd: string,
	): RegTerminalInfo | undefined {
		return terminals.find((t) => {
			if (t.busy) {
				Logger.log(`[TerminalLifecycleManager] Terminal ${t.id} is busy, skipping`)
				return false
			}
			if (t.shellPath !== expectedShellPath) {
				return false
			}
			const terminalCwd = t.terminal.shellIntegration?.cwd
			if (!terminalCwd) {
				Logger.log(`[TerminalLifecycleManager] Terminal ${t.id} has no cwd, skipping`)
				return false
			}
			const matches = arePathsEqual(vscode.Uri.file(cwd).fsPath, terminalCwd.fsPath)
			Logger.log(`[TerminalLifecycleManager] Terminal ${t.id} cwd: ${terminalCwd.fsPath}, matches: ${matches}`)
			return matches
		})
	}

	private findAvailableTerminal(
		terminals: RegTerminalInfo[],
		expectedShellPath: string | undefined,
	): RegTerminalInfo | undefined {
		return terminals.find((t) => !t.busy && t.shellPath === expectedShellPath)
	}

	private async reuseTerminalWithCwd(terminal: RegTerminalInfo, cwd: string): Promise<RegTerminalInfo> {
		const cwdPromise = new Promise<void>((resolve, reject) => {
			terminal.pendingCwdChange = cwd
			terminal.cwdResolved = { resolve, reject }
		})

		await this.cdToDirectory(terminal, cwd)
		await new Promise((resolve) => setTimeout(resolve, 100))

		if (this.isCwdMatchingExpected(terminal, cwd)) {
			if (terminal.cwdResolved) {
				terminal.cwdResolved.resolve()
			}
			terminal.pendingCwdChange = undefined
			terminal.cwdResolved = undefined
		} else {
			try {
				await Promise.race([
					cwdPromise,
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error(`CWD timeout: Failed to update to ${cwd}`)), 1000),
					),
				])
			} catch (_err) {
				terminal.pendingCwdChange = undefined
				terminal.cwdResolved = undefined
			}
		}

		return terminal as unknown as RegTerminalInfo
	}

	private async cdToDirectory(terminal: RegTerminalInfo, cwd: string): Promise<void> {
		const TerminalProcess = (await import("./VscodeTerminalProcess")).VscodeTerminalProcess
		const mergePromise = (await import("./VscodeTerminalProcess")).mergePromise

		const process = new TerminalProcess()
		process.waitForShellIntegration = false
		process.run(terminal.terminal, `cd "${cwd}"`)

		await new Promise<void>((resolve) => {
			process.once("completed", () => resolve())
			process.once("error", () => resolve())
		})
	}

	private isCwdMatchingExpected(terminal: RegTerminalInfo, cwd: string): boolean {
		const currentCwd = terminal.terminal.shellIntegration?.cwd?.fsPath
		if (!currentCwd || !terminal.pendingCwdChange) {
			return false
		}
		return arePathsEqual(currentCwd, vscode.Uri.file(cwd).fsPath)
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		const terminals = TerminalRegistry.getAllTerminals()
		return terminals
			.filter((t): t is RegTerminalInfo => t !== undefined && t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

	setShellIntegrationTimeout(_timeout: number): void {
		// Delegates to ShellIntegrationManager
	}
}
