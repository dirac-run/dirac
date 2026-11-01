import { arePathsEqual } from "@utils/path"
import { getShellForProfile } from "@utils/shell"
import * as vscode from "vscode"
import { setTimeout as delay } from "node:timers/promises"
import { getPythonEnvironmentVariables } from "../python"
import type { TerminalProcessResultPromise } from "./VscodeTerminalProcess"
import { type TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

export interface TerminalPoolOptions {
	terminalReuseEnabled: boolean
	defaultTerminalProfile: string
}

export class TerminalLifecycleManager {
	private readonly cancellation = new AbortController()

	constructor(
		private options: TerminalPoolOptions,
		private readonly ownerId: string,
		private readonly runCwdCommand: (terminal: TerminalInfo, command: string) => TerminalProcessResultPromise,
	) { }

	setTerminalReuseEnabled(enabled: boolean): void {
		this.options.terminalReuseEnabled = enabled
	}


	stop(): void {
		this.cancellation.abort()
	}

	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<TerminalInfo> {
		const { signal } = this.cancellation
		signal.throwIfAborted()
		if (!env) env = await getPythonEnvironmentVariables(vscode.Uri.file(cwd))
		signal.throwIfAborted()

		const shellPath = this.options.defaultTerminalProfile !== "default"
			? getShellForProfile(this.options.defaultTerminalProfile) : undefined
		const available = TerminalRegistry.getAllTerminals().filter((t) =>
			!t.busy && !t.reuseDisabled && t.shellPath === shellPath && (t.ownerId === undefined || t.ownerId === this.ownerId),
		)
		const matching = available.find((t) => {
			const terminalCwd = t.terminal.shellIntegration?.cwd?.fsPath
			return terminalCwd && arePathsEqual(vscode.Uri.file(cwd).fsPath, terminalCwd)
		})
		const candidate = matching ?? (this.options.terminalReuseEnabled ? available[0] : undefined)
		if (candidate) {
			const claimed = TerminalRegistry.claimTerminal(candidate.id, this.ownerId)
			if (claimed) {
				if (matching) return claimed
				// Keep ownership/reservation if the CWD command fails; cleanup still owns it.
				await this.reuseTerminalWithCwd(claimed, cwd)
				signal.throwIfAborted()
				if (!claimed.reuseDisabled) return claimed
				// Retain cleanup ownership, but use a fresh shell for the requested command.
				claimed.busy = false
			}
		}
		const terminal = TerminalRegistry.createTerminal(cwd, shellPath, env, this.ownerId)
		TerminalRegistry.claimTerminal(terminal.id, this.ownerId)
		return terminal
	}

	private async reuseTerminalWithCwd(terminal: TerminalInfo, cwd: string): Promise<void> {
		await this.runCwdCommand(terminal, `cd "${cwd}"`)
		this.cancellation.signal.throwIfAborted()
		if (terminal.reuseDisabled) return
		// Preserve the existing best-effort CWD observation; optional metadata is not a command gate.
		for (let attempt = 0; attempt < 10; attempt++) {
			const currentCwd = terminal.terminal.shellIntegration?.cwd?.fsPath
			if (currentCwd && arePathsEqual(currentCwd, vscode.Uri.file(cwd).fsPath)) return
			await delay(100, undefined, { signal: this.cancellation.signal })
		}
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return TerminalRegistry.getOwnedTerminals(this.ownerId)
			.filter((t) => t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

}
