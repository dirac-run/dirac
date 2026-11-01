import { randomUUID } from "node:crypto"
import { getShellForProfile } from "@utils/shell"
import {
	TerminalInfo as ITerminalInfo,
	ITerminalManager,
	TerminalProcessResultPromise as ITerminalProcessResultPromise,
	TerminalProfileChangeResult,
} from "@/integrations/terminal/types"
import { CommandExecutor } from "./VscodeCommandExecutor"
import { TerminalLifecycleManager } from "./VscodeTerminalLifecycleManager"
import { VscodeTerminalProcess, type TerminalProcessResultPromise } from "./VscodeTerminalProcess"
import { TerminalProfileManager } from "./VscodeTerminalProfileManager"
import { TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

export class VscodeTerminalManager implements ITerminalManager {
	private readonly ownerId = randomUUID()
	private processes = new Map<number, VscodeTerminalProcess>()
	private terminalOutputLineLimit = 500
	private stopped = false
	private lifecycleManager: TerminalLifecycleManager
	private commandExecutor = new CommandExecutor({ shellIntegrationTimeout: 4000 })
	private profileManager = new TerminalProfileManager(this.ownerId, (terminal) => this.closeTerminal(terminal))

	constructor() {
		this.lifecycleManager = new TerminalLifecycleManager(
			{ terminalReuseEnabled: true, defaultTerminalProfile: "default" },
			this.ownerId,
			(info, command) => this.startCommand(info, command, false),
		)
	}

	runCommand(terminalInfo: ITerminalInfo, command: string): ITerminalProcessResultPromise {
		return this.startCommand(terminalInfo as unknown as TerminalInfo, command, true)
	}

	private startCommand(info: TerminalInfo, command: string, releaseReservation: boolean): TerminalProcessResultPromise {
		if (this.stopped) throw new Error("Terminal manager is disposed")
		if (info.ownerId !== this.ownerId || TerminalRegistry.getTerminal(info.id) !== info) {
			throw new Error("Terminal is not owned by this manager")
		}
		const previous = this.processes.get(info.id)
		if (previous && !previous.hasCompleted) throw new Error("Terminal already has a running command")
		info.lastCommand = command
		info.busy = true
		const process = new VscodeTerminalProcess(() => {
			info.reuseDisabled = true
			TerminalRegistry.removeTerminal(info.id)
		})
		this.processes.set(info.id, process)
		process.once("no_shell_integration", () => { info.reuseDisabled = true })
		return this.commandExecutor.runCommand(info.id, info.terminal, command, process, () => {
			if (releaseReservation) info.busy = false
		})
	}

	async getOrCreateTerminal(cwd: string, env?: { [key: string]: string | undefined }): Promise<ITerminalInfo> {
		if (this.stopped) throw new Error("Terminal manager is disposed")
		const terminal = await this.lifecycleManager.getOrCreateTerminal(cwd, env)
		if (this.stopped) throw new Error("Terminal manager is disposed")
		return terminal as unknown as ITerminalInfo
	}

	releaseTerminalReservation(terminalInfo: ITerminalInfo): void {
		const info = terminalInfo as TerminalInfo
		if (info.ownerId !== this.ownerId) throw new Error("Terminal is not owned by this manager")
		if (TerminalRegistry.getTerminal(info.id) !== info) return
		info.busy = false
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return this.lifecycleManager.getTerminals(busy)
	}

	getUnretrievedOutput(terminalId: number): string {
		return this.processes.get(terminalId)?.getUnretrievedOutput() ?? ""
	}

	isProcessHot(terminalId: number): boolean {
		return this.processes.get(terminalId)?.isHot ?? false
	}

	disposeAll(): void {
		if (this.stopped) return
		this.stopped = true
		this.lifecycleManager.stop()
		this.closeAllTerminals()
		this.processes.clear()
	}

	private closeTerminal(info: TerminalInfo): void {
		this.processes.get(info.id)?.stop()
		TerminalRegistry.closeTerminal(info, this.ownerId)
		this.processes.delete(info.id)
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.commandExecutor.setShellIntegrationTimeout(timeout)
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
		return this.profileManager.closeTerminals(filterFn, force)
	}

	handleTerminalProfileChange(newShellPath: string | undefined): TerminalProfileChangeResult {
		const closedCount = this.closeTerminals((t) => !t.busy && t.shellPath !== newShellPath)
		const busyTerminals = this.profileManager.filterTerminals((t) => t.busy && t.shellPath !== newShellPath)
		return { closedCount, busyTerminals }
	}

	closeAllTerminals(): number {
		return this.profileManager.closeAllTerminals()
	}
}
