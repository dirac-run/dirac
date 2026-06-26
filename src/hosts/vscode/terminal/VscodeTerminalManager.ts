import { getShellForProfile } from "@utils/shell"
import {
	TerminalInfo as ITerminalInfo,
	ITerminalManager,
	TerminalProcessResultPromise as ITerminalProcessResultPromise,
	TerminalProfileChangeResult,
} from "@/integrations/terminal/types"
import { Logger } from "@/shared/services/Logger"
import { CommandExecutor } from "./VscodeCommandExecutor"
import { ShellIntegrationManager } from "./VscodeShellIntegrationManager"
import { TerminalLifecycleManager } from "./VscodeTerminalLifecycleManager"
import { VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalProfileManager } from "./VscodeTerminalProfileManager"
import { TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

export class VscodeTerminalManager implements ITerminalManager {
	private terminalIds: Set<number> = new Set()
	private processes: Map<number, VscodeTerminalProcess> = new Map()
	private terminalOutputLineLimit = 500

	private shellIntegrationManager = new ShellIntegrationManager()
	private lifecycleManager: TerminalLifecycleManager
	private commandExecutor: CommandExecutor
	private profileManager = new TerminalProfileManager()

	constructor() {
		this.lifecycleManager = new TerminalLifecycleManager({
			terminalReuseEnabled: true,
			defaultTerminalProfile: "default",
		})
		this.commandExecutor = new CommandExecutor({ shellIntegrationTimeout: 4000 })

		this.shellIntegrationManager.setupListeners()
	}

	runCommand(terminalInfo: ITerminalInfo, command: string): ITerminalProcessResultPromise {
		const info = terminalInfo as unknown as TerminalInfo
		info.lastCommand = command // record the actual command being run
		Logger.log(`[TerminalManager] Running command on terminal ${info.id}: "${command}"`)
		Logger.log(`[TerminalManager] Terminal ${info.id} busy state before: ${info.busy}`)

		info.busy = true
		const process = new VscodeTerminalProcess()
		this.processes.set(info.id, process)

		const result = this.commandExecutor.runCommand(
			info.id,
			info.terminal,
			command,
			() => {
				Logger.log(`[TerminalManager] Terminal ${info.id} completed, setting busy to false`)
				info.busy = false
			},
			() => {
				TerminalRegistry.removeTerminal(info.id)
				this.terminalIds.delete(info.id)
				this.processes.delete(info.id)
			},
		)

		return result as unknown as ITerminalProcessResultPromise
	}

	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<ITerminalInfo> {
		const terminal = await this.lifecycleManager.getOrCreateTerminal(cwd, env)
		this.terminalIds.add(terminal.id)
		return terminal as unknown as ITerminalInfo
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return this.lifecycleManager.getTerminals(busy)
	}

	getUnretrievedOutput(terminalId: number): string {
		if (!this.terminalIds.has(terminalId)) {
			return ""
		}
		const process = this.processes.get(terminalId)
		return process ? process.getUnretrievedOutput() : ""
	}

	isProcessHot(terminalId: number): boolean {
		const process = this.processes.get(terminalId)
		return process ? process.isHot : false
	}

	disposeAll(): void {
		this.terminalIds.clear()
		this.processes.clear()
		this.shellIntegrationManager.dispose()
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.commandExecutor.setShellIntegrationTimeout(timeout)
		this.lifecycleManager.setShellIntegrationTimeout(timeout)
	}

	setTerminalReuseEnabled(enabled: boolean): void {
		this.lifecycleManager.setTerminalReuseEnabled(enabled)
	}

	setTerminalOutputLineLimit(limit: number): void {
		this.terminalOutputLineLimit = limit
	}

	public processOutput(outputLines: string[], overrideLimit?: number): string {
		const limit = overrideLimit !== undefined ? overrideLimit : this.terminalOutputLineLimit
		if (outputLines.length > limit) {
			const halfLimit = Math.floor(limit / 2)
			const start = outputLines.slice(0, halfLimit)
			const end = outputLines.slice(outputLines.length - halfLimit)
			return `${start.join("\n")}\n... (output truncated) ...\n${end.join("\n")}`.trim()
		}
		return outputLines.join("\n").trim()
	}

	setDefaultTerminalProfile(profileId: string): TerminalProfileChangeResult {
		const result = this.profileManager.setDefaultTerminalProfile(profileId)
		this.profileManager.updateLastActiveForShell(profileId !== "default" ? getShellForProfile(profileId) : undefined)
		return result
	}

	filterTerminals(filterFn: (terminal: TerminalInfo) => boolean): TerminalInfo[] {
		return this.profileManager.filterTerminals(filterFn)
	}

	closeTerminals(filterFn: (terminal: TerminalInfo) => boolean, force = false): number {
		// Identify which terminals will be closed before delegating
		const toClose = this.profileManager.filterTerminals(filterFn).filter((t) => force || !t.busy)
		const closedIds = new Set(toClose.map((t) => t.id))
		const count = this.profileManager.closeTerminals(filterFn, force)
		// Only clear processes for terminals that were actually closed
		for (const id of closedIds) {
			this.terminalIds.delete(id)
			this.processes.delete(id)
		}
		return count
	}

	handleTerminalProfileChange(newShellPath: string | undefined): TerminalProfileChangeResult {
		// Close non-busy terminals with different shell path
		const closedCount = this.closeTerminals((t) => !t.busy && t.shellPath !== newShellPath, false)
		const busyTerminals = this.profileManager.filterTerminals((t) => t.busy && t.shellPath !== newShellPath)
		return { closedCount, busyTerminals }
	}

	closeAllTerminals(): number {
		return this.profileManager.closeAllTerminals()
	}
}
