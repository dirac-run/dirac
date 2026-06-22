import { arePathsEqual } from "@utils/path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

// Minimal shape for the shell-integration event (not in stable vscode API typings)
interface TerminalShellExecutionStartEvent {
	execution?: { read(): void }
}

// Extension-internal fields stashed on Terminal for CWD resolution coordination
interface DiracTerminalExt {
	_diracPendingCwd?: string
	_diracCwdResolver?: () => void
}

type TerminalWithDirac = vscode.Terminal & DiracTerminalExt

export class ShellIntegrationManager {
	private disposables: vscode.Disposable[] = []
	private shellIntegrationTimeout = 4000

	constructor() {}

	setupListeners(): void {
		try {
			// onDidStartTerminalShellExecution is proposed API; cast to access it safely
			const windowWithProposed = vscode.window as unknown as {
				onDidStartTerminalShellExecution?(
					listener: (e: TerminalShellExecutionStartEvent) => void,
				): vscode.Disposable | undefined
			}
			const disposable = windowWithProposed.onDidStartTerminalShellExecution?.((e) => {
				e?.execution?.read()
			})
			if (disposable) {
				this.disposables.push(disposable)
			}
		} catch (_error) {
			// Shell integration not available on this VS Code version
		}

		try {
			const stateChangeDisposable = vscode.window.onDidChangeTerminalState((terminal) => {
				const ext = terminal as TerminalWithDirac
				const pendingCwd = ext._diracPendingCwd
				if (!pendingCwd) {
					return
				}
				const currentCwd = terminal.shellIntegration?.cwd?.fsPath
				if (!currentCwd || !arePathsEqual(currentCwd, vscode.Uri.file(pendingCwd).fsPath)) {
					return
				}
				ext._diracPendingCwd = undefined
				const resolver = ext._diracCwdResolver
				if (resolver) {
					ext._diracCwdResolver = undefined
					resolver()
				}
			})
			this.disposables.push(stateChangeDisposable)
		} catch (error) {
			Logger.error("ShellIntegrationManager: error setting up onDidChangeTerminalState", error)
		}
	}

	waitForShellIntegration(terminal: vscode.Terminal, timeout?: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const ms = timeout ?? this.shellIntegrationTimeout
			const start = Date.now()

			const checkInterval = setInterval(() => {
				if (terminal.shellIntegration !== undefined) {
					clearInterval(checkInterval)
					resolve()
				} else if (Date.now() - start >= ms) {
					clearInterval(checkInterval)
					reject(new Error("Shell integration timeout"))
				}
			}, 100)
		})
	}

	setCwd(terminal: vscode.Terminal, cwd: string): void {
		;(terminal as TerminalWithDirac)._diracPendingCwd = cwd
	}

	waitForCwdResolve(terminal: vscode.Terminal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`CWD timeout: Failed to update to terminal`))
			}, 1000)

			const checkInterval = setInterval(() => {
				const ext = terminal as TerminalWithDirac
				const currentCwd = terminal.shellIntegration?.cwd?.fsPath
				if (
					currentCwd &&
					ext._diracPendingCwd &&
					arePathsEqual(currentCwd, vscode.Uri.file(ext._diracPendingCwd).fsPath)
				) {
					clearInterval(checkInterval)
					clearTimeout(timeout)
					ext._diracPendingCwd = undefined
					resolve()
				}
			}, 100)
		})
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.shellIntegrationTimeout = timeout
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []
	}
}
