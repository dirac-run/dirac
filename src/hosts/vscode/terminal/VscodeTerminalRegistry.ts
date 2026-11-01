import * as vscode from "vscode"
import { getDiracIconUri } from "@/hosts/vscode/iconUtils"

export interface TerminalInfo {
	terminal: vscode.Terminal
	busy: boolean
	lastCommand: string
	id: number
	/** Only Dirac-created terminals enter this registry; undefined means not yet claimed. */
	ownerId?: string
	/** Fallback output snapshots cannot establish that the shell is ready for reuse. */
	reuseDisabled?: boolean
	shellPath?: string
	lastActive: number
}

export class TerminalRegistry {
	private static terminals: TerminalInfo[] = []
	private static nextTerminalId = 1

	static createTerminal(
		cwd?: string | vscode.Uri,
		shellPath?: string,
		env?: { [key: string]: string | undefined },
		ownerId?: string,
	): TerminalInfo {
		const terminal = vscode.window.createTerminal({
			cwd,
			name: "Dirac",
			iconPath: getDiracIconUri(),
			env: { DIRAC_ACTIVE: "true", ...env },
			...(shellPath ? { shellPath } : {}),
		})
		const info: TerminalInfo = {
			terminal,
			busy: false,
			lastCommand: "",
			id: ++TerminalRegistry.nextTerminalId,
			ownerId,
			shellPath,
			lastActive: Date.now(),
		}
		TerminalRegistry.terminals.push(info)
		return info
	}

	/** Claim and reserve synchronously, before any CWD or shell-integration await. */
	static claimTerminal(id: number, ownerId: string): TerminalInfo | undefined {
		const info = this.getTerminal(id)
		if (!info || info.busy || info.reuseDisabled || (info.ownerId !== undefined && info.ownerId !== ownerId)) {
			return undefined
		}
		info.ownerId = ownerId
		info.busy = true
		return info
	}

	static getTerminal(id: number): TerminalInfo | undefined {
		const info = this.terminals.find((t) => t.id === id)
		if (info && info.terminal.exitStatus !== undefined) {
			this.removeTerminal(id)
			return undefined
		}
		return info
	}

	static updateTerminal(id: number, updates: Partial<TerminalInfo>): void {
		const terminal = this.getTerminal(id)
		if (terminal) Object.assign(terminal, updates)
	}

	static removeTerminal(id: number): void {
		this.terminals = this.terminals.filter((t) => t.id !== id)
	}

	static getAllTerminals(): TerminalInfo[] {
		this.terminals = this.terminals.filter((t) => t.terminal.exitStatus === undefined)
		return this.terminals
	}

	static getOwnedTerminals(ownerId: string): TerminalInfo[] {
		return this.getAllTerminals().filter((t) => t.ownerId === ownerId)
	}

	/** Request closure of this owner's terminal without waiting for a host acknowledgement. */
	static closeTerminal(info: TerminalInfo, ownerId: string): void {
		if (info.ownerId !== ownerId) throw new Error("Cannot close another terminal owner's terminal")
		this.removeTerminal(info.id)
		info.terminal.dispose()
	}
}
