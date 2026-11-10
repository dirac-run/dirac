import { ChildProcess, execFile, spawn } from "child_process"
import { EventEmitter } from "events"
import { runWindowsOwnedProcess, WindowsProcessOwnershipError } from "@/integrations/terminal/windows/WindowsOwnedProcess"
import type { HookLaunchConfig } from "./HookLaunchConfig"
import { HookCleanupError } from "./HookCleanupError"
import { getHookLaunchConfig, resetHookLaunchConfigCacheForTesting } from "./HookLaunchConfig"
import { HookOutputParser } from "./HookOutputParser"
import { HookProcessRegistry } from "./HookProcessRegistry"

export { getHookLaunchConfig, resetHookLaunchConfigCacheForTesting }

/** Runs a hook and retains ownership until its process, streams and termination settle. */
export class HookProcess extends EventEmitter {
	private childProcess: ChildProcess | null = null
	private exitCode: number | null = null
	private isCompleted = false
	private timeoutHandle: NodeJS.Timeout | null = null
	private readonly outputParser: HookOutputParser
	private execution?: Promise<void>
	private settlement?: Promise<void>
	private closed?: Promise<void>
	private executionSettled = false
	private cleanupFinished?: () => void
	private retryingCleanup?: Promise<void>
	private processGroupTerminated = false
	private processGroupTerminationAttempted = false
	private stopping?: Promise<void>
	private stopError?: unknown
	private cancellation?: Error
	private readonly stopController = new AbortController()
	private didEmitEmptyLine = false

	constructor(
		private readonly scriptPath: string,
		private readonly timeoutMs: number = 30000,
		private readonly abortSignal?: AbortSignal,
		private readonly cwd?: string,
	) {
		super()
		this.outputParser = new HookOutputParser(this.emit.bind(this))
	}

	run(inputJson: string): Promise<void> {
		if (this.execution) throw new Error("Hook process has already been started")
		this.execution = this.execute(inputJson)
		// Termination joins cleanup without consuming the caller's execution error.
		this.settlement = this.execution.then(() => { }, (error: unknown) => {
			if (error instanceof HookCleanupError) throw error
		})
		// A registry shutdown may join later; keep early failure observed meanwhile.
		void this.settlement.catch(() => { })
		return this.execution
	}

	private async execute(inputJson: string): Promise<void> {
		HookProcessRegistry.register(this)
		const abort = () => this.requestStop(new Error("Hook execution cancelled by user"))
		this.abortSignal?.addEventListener("abort", abort, { once: true })
		try {
			if (this.abortSignal?.aborted) abort()
			if (this.cancellation) throw this.cancellation
			const launchConfig = await getHookLaunchConfig(this.scriptPath)
			// Launcher discovery can await PowerShell resolution. Cancellation owns that
			// startup interval too, and must never launch a process after it was stopped.
			if (this.cancellation) throw this.cancellation
			if (process.platform === "win32") {
				await this.executeWindowsOwnedProcess(launchConfig, inputJson)
				return
			}
			const child = spawn(launchConfig.command, launchConfig.args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: launchConfig.shell,
				detached: launchConfig.detached,
				cwd: this.cwd,
				windowsHide: true,
			})
			this.childProcess = child
			const cleanupFinished = new Promise<void>((resolve) => { this.cleanupFinished = resolve })
			let processError: Error | undefined
			let exitSignal: NodeJS.Signals | null = null
			this.closed = new Promise<void>((resolve) => {
				child.once("error", (error) => { processError = error })
				// Unlike exit, close also joins inherited stdout/stderr pipes.
				child.once("close", (code, signal) => {
					this.exitCode = code
					exitSignal = signal
					resolve()
				})
			})
			// Descendants can inherit pipes and keep close pending after the leader exits.
			// Start teardown on exit, then join both streams and process-group settlement.
			child.once("exit", () => this.startProcessTreeCleanup())
			child.stdout?.on("data", (data: Buffer) => this.publishOutput(data.toString(), "stdout"))
			child.stderr?.on("data", (data: Buffer) => this.publishOutput(data.toString(), "stderr"))
			child.stdin?.on("error", (error: Error) => this.requestStop(error))
			this.startExecutionTimeout()
			try {
				child.stdin?.end(inputJson)
			} catch (error) {
				this.requestStop(new Error(`Failed to write input to hook: ${error}`))
			}
			// Escaped descendants may retain pipes after the owned group has exited.
			// Cleanup has its own deadline and must be able to report uncertainty.
			await Promise.race([this.closed, cleanupFinished])
			// Spawn failures may emit close without exit; cleanup still owns any PID.
			this.startProcessTreeCleanup()
			await this.stopping
			if (this.stopError) throw new HookCleanupError([this.stopError], "Hook process-tree termination could not be confirmed")
			this.outputParser.emitRemainingBuffer()
			this.emit("completed", this.exitCode, exitSignal)
			if (this.cancellation) throw this.cancellation
			if (processError) throw processError
			if (this.exitCode !== 0) throw new Error(`Hook exited with code ${this.exitCode}${exitSignal ? `, signal ${exitSignal}` : ""}`)
		} finally {
			if (this.timeoutHandle) clearTimeout(this.timeoutHandle)
			this.timeoutHandle = null
			this.abortSignal?.removeEventListener("abort", abort)
			this.executionSettled = true
			this.isCompleted = !this.stopError
			if (this.isCompleted) HookProcessRegistry.unregister(this)
		}
	}

	private publishOutput(text: string, stream: "stdout" | "stderr"): void {
		// On uncertain cleanup keep draining the pipes, but never publish into an
		// operation whose execution/publication barrier has already rejected.
		if (this.executionSettled) return
		this.outputParser.parseOutput(text, stream)
		if (!this.didEmitEmptyLine && text) {
			this.emit("line", "", stream)
			this.didEmitEmptyLine = true
		}
	}

	private startExecutionTimeout(): void {
		this.timeoutHandle = setTimeout(() => this.requestStop(new Error(
			`Hook execution timed out after ${this.timeoutMs}ms. The hook script at '${this.scriptPath}' took too long to complete.`,
		)), this.timeoutMs)
	}

	private async executeWindowsOwnedProcess(launchConfig: HookLaunchConfig, inputJson: string): Promise<void> {
		this.startExecutionTimeout()
		let result: Awaited<ReturnType<typeof runWindowsOwnedProcess>>
		try {
			result = await runWindowsOwnedProcess({
				launcher: launchConfig.command,
				executable: launchConfig.command,
				args: launchConfig.args,
				cwd: this.cwd,
				input: inputJson,
				signal: this.stopController.signal,
				onOutput: (stream, text) => this.publishOutput(text, stream),
			})
		} catch (error) {
			if (error instanceof WindowsProcessOwnershipError) {
				this.stopError = error
				throw new HookCleanupError([error], "Windows hook job settlement could not be confirmed")
			}
			throw error
		}
		this.exitCode = result.exitCode
		this.outputParser.emitRemainingBuffer()
		this.emit("completed", result.exitCode, null)
		if (result.failure) throw new Error(result.failure)
		if (this.cancellation) throw this.cancellation
		if (result.cancelled) throw new Error("Hook execution cancelled by user")
		if (result.exitCode !== 0) throw new Error(`Hook exited with code ${result.exitCode}`)
	}

	private requestStop(reason: Error): void {
		if (this.isCompleted) return
		this.cancellation ??= reason
		this.stopController.abort(reason)
		this.startProcessTreeCleanup()
	}

	private startProcessTreeCleanup(): void {
		const pid = this.childProcess?.pid
		if (!pid || this.stopping) return
		this.stopping = this.stopProcessTree(pid)
			.catch((error: unknown) => { this.stopError = error })
			.finally(() => this.cleanupFinished?.())
	}

	private signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
		try {
			process.kill(-pid, signal)
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
			throw error
		}
	}

	private async waitForProcessGroupExit(pid: number, deadline: number): Promise<boolean> {
		while (this.signalProcessGroup(pid, 0)) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) return false
			// /bin/ps is available on supported Linux/macOS hosts independently of
			// the user's PATH. Bound each inspection and scan at most four times/sec,
			// not once per 20ms tick. Missing/broken ps is uncertainty, not success.
			const members = await new Promise<string>((resolve, reject) => {
				execFile("/bin/ps", ["-A", "-o", "pgid=,stat="], { timeout: Math.min(remaining, 1000) }, (error, stdout) => {
					if (error) reject(error)
					else resolve(stdout)
				})
			})
			// Zombies are dead; only their parent can reap them.
			const running = members.split("\n").some((line) => {
				const [group, state] = line.trim().split(/\s+/)
				return Number(group) === pid && !state.startsWith("Z")
			})
			if (!running) return true
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))))
		}
		return true
	}

	private async waitForPipeClosure(): Promise<void> {
		let timer: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				this.closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Hook pipes did not close; a descendant may have escaped the process group")), 2000)
				}),
			])
		} finally {
			clearTimeout(timer)
		}
	}

	private async stopProcessTree(pid: number): Promise<void> {
		// Retrying is verification-only. After the initial bounded termination
		// attempt, numeric PGIDs may have been reused; never signal them again.
		if (!this.processGroupTerminationAttempted) {
			this.processGroupTerminationAttempted = true
			if (this.signalProcessGroup(pid, "SIGTERM")) {
				try {
					this.processGroupTerminated = await this.waitForProcessGroupExit(pid, Date.now() + 2000)
				} finally {
					// Escalate only while unconfirmed, never after observing the group dead.
					if (!this.processGroupTerminated) this.signalProcessGroup(pid, "SIGKILL")
				}
			}
		}
		if (!this.processGroupTerminated) {
			if (!await this.waitForProcessGroupExit(pid, Date.now() + 2000)) {
				throw new Error("Hook process-group termination could not be confirmed")
			}
			this.processGroupTerminated = true
		}
		await this.waitForPipeClosure()
	}

	private async retryProcessTreeCleanup(pid: number): Promise<void> {
		try {
			await this.stopProcessTree(pid)
			this.stopError = undefined
			this.isCompleted = true
			HookProcessRegistry.unregister(this)
		} catch (error) {
			this.stopError = error
			throw new HookCleanupError([error], "Hook process-tree termination could not be confirmed")
		} finally {
			this.retryingCleanup = undefined
		}
	}

	getUnretrievedOutput(): string {
		return this.outputParser.getUnretrievedOutput()
	}

	getStdout(): string {
		return this.outputParser.getStdout()
	}

	getStderr(): string {
		return this.outputParser.getStderr()
	}

	getExitCode(): number | null {
		return this.exitCode
	}

	hasCompleted(): boolean {
		return this.isCompleted
	}

	/** Stop startup or the running process tree, then join the execution cleanup. */
	async terminate(): Promise<void> {
		if (this.isCompleted) return
		// Only POSIX cleanup can be reverified here. A missing Windows supervisor
		// proof remains fatal: do not replace native ownership with PID guessing.
		if (this.executionSettled && this.stopError && this.childProcess?.pid) {
			this.retryingCleanup ??= this.retryProcessTreeCleanup(this.childProcess.pid)
			await this.retryingCleanup
			return
		}
		this.requestStop(new Error("Hook execution cancelled by user"))
		await this.settlement
	}
}
