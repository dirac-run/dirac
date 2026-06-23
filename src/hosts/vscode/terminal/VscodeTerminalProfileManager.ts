import { getShellForProfile } from "@utils/shell"
import { TerminalRegistry, type TerminalInfo as RegTerminalInfo } from "./VscodeTerminalRegistry"

export class TerminalProfileManager {
	private defaultTerminalProfile = "default"

	constructor() {}

	setDefaultTerminalProfile(profileId: string): {
		closedCount: number
		busyTerminals: RegTerminalInfo[]
	} {
		if (this.defaultTerminalProfile === profileId) {
			return { closedCount: 0, busyTerminals: [] }
		}

		this.defaultTerminalProfile = profileId
		const newShellPath = profileId !== "default" ? getShellForProfile(profileId) : undefined
		return this.handleProfileChange(newShellPath)
	}

	private handleProfileChange(newShellPath: string | undefined): {
		closedCount: number
		busyTerminals: RegTerminalInfo[]
	} {
		const closedCount = this.closeTerminals((terminal) => !terminal.busy && terminal.shellPath !== newShellPath, false)
		const busyTerminals = this.filterTerminals((terminal) => terminal.busy && terminal.shellPath !== newShellPath)

		return { closedCount, busyTerminals }
	}

	filterTerminals(filterFn: (terminal: RegTerminalInfo) => boolean): RegTerminalInfo[] {
		const terminals = TerminalRegistry.getAllTerminals()
		return terminals.filter(filterFn)
	}

	closeTerminals(filterFn: (terminal: RegTerminalInfo) => boolean, force = false): number {
		const terminalsToClose = this.filterTerminals(filterFn)
		let closedCount = 0

		for (const terminal of terminalsToClose) {
			if (terminal.busy && !force) {
				continue
			}

			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
			closedCount++
		}

		return closedCount
	}

	closeAllTerminals(): number {
		return this.closeTerminals(() => true, true)
	}

	updateLastActiveForShell(shellPath: string | undefined): void {
		const allTerminals = TerminalRegistry.getAllTerminals()
		allTerminals.forEach((terminal) => {
			if (terminal.shellPath !== shellPath) {
				TerminalRegistry.updateTerminal(terminal.id, { lastActive: Date.now() })
			}
		})
	}

	get defaultProfile(): string {
		return this.defaultTerminalProfile
	}
}
