import * as vscode from "vscode"
import { setTimeout as delay } from "node:timers/promises"
import { Logger } from "@/shared/services/Logger"
import { mergePromise, VscodeTerminalProcess, type TerminalProcessResultPromise } from "./VscodeTerminalProcess"

export interface CommandExecutorOptions {
	shellIntegrationTimeout: number
}

export class CommandExecutor {
	constructor(private options: CommandExecutorOptions) { }

	runCommand(
		terminalId: number,
		terminal: vscode.Terminal,
		command: string,
		process: VscodeTerminalProcess,
		onCompleted?: () => void,
	): TerminalProcessResultPromise {
		process.bindTerminal(terminal)
		process.once("completed", () => onCompleted?.())
		process.once("error", () => onCompleted?.())
		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", resolve)
			process.once("error", reject)
		})
		const result = mergePromise(process, promise)
		// Defer execution, not the process object: callers can attach listeners synchronously.
		void Promise.resolve().then(async () => {
			if (!terminal.shellIntegration) await this.waitForShellIntegration(process, terminal)
			if (process.abortSignal.aborted) return
			process.waitForShellIntegration = false
			await process.run(terminal, command)
		}).catch((error) => {
			if (process.abortSignal.aborted) return
			Logger.error(`Error in terminal ${terminalId}:`, error)
			process.fail(error instanceof Error ? error : new Error(String(error)))
		})
		return result
	}

	private async waitForShellIntegration(process: VscodeTerminalProcess, terminal: vscode.Terminal): Promise<void> {
		const deadline = Date.now() + this.options.shellIntegrationTimeout
		while (!terminal.shellIntegration && Date.now() < deadline) {
			await delay(Math.min(100, deadline - Date.now()), undefined, { signal: process.abortSignal })
		}
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.options.shellIntegrationTimeout = timeout
	}
}
