import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { Logger } from "@/shared/services/Logger"
import { mergePromise, VscodeTerminalProcess, type TerminalProcessResultPromise } from "./VscodeTerminalProcess"

export interface CommandExecutorOptions {
	shellIntegrationTimeout: number
}

export class CommandExecutor {
	constructor(private options: CommandExecutorOptions) {}

	async runCommand(
		terminalId: number,
		terminal: vscode.Terminal,
		command: string,
		onCompleted?: () => void,
		onNoShellIntegration?: () => void,
	): Promise<TerminalProcessResultPromise> {
		const process = new VscodeTerminalProcess()

		process.once("completed", () => {
			Logger.log(`[CommandExecutor] Terminal ${terminalId} completed`)
			onCompleted?.()
		})

		process.once("no_shell_integration", () => {
			Logger.log(`[CommandExecutor] no_shell_integration for terminal ${terminalId}`)
			onNoShellIntegration?.()
		})

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => resolve())
			process.once("error", (error) => {
				Logger.error(`Error in terminal ${terminalId}:`, error)
				reject(error)
			})
		})

		if (terminal.shellIntegration) {
			process.waitForShellIntegration = false
			process.run(terminal, command)
		} else {
			await this.waitForAndRunCommand(terminalId, terminal, process, command)
		}

		return mergePromise(process, promise)
	}

	private async waitForAndRunCommand(
		terminalId: number,
		terminal: vscode.Terminal,
		process: VscodeTerminalProcess,
		command: string,
	): Promise<void> {
		Logger.log(
			`[CommandExecutor] Waiting for shell integration for terminal ${terminalId} with timeout ${this.options.shellIntegrationTimeout}ms`,
		)

		try {
			await pWaitFor(() => terminal.shellIntegration !== undefined, {
				timeout: this.options.shellIntegrationTimeout,
			})
			Logger.log(`[CommandExecutor] Shell integration activated for terminal ${terminalId}`)
		} catch (err) {
			Logger.warn(`[CommandExecutor] Shell integration timed out or failed for terminal ${terminalId}: ${err.message}`)
		} finally {
			Logger.log(`[CommandExecutor] Proceeding with command execution for terminal ${terminalId}`)
			process.waitForShellIntegration = false
			process.run(terminal, command)
		}
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.options.shellIntegrationTimeout = timeout
	}
}
