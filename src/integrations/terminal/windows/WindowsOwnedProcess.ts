import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { WINDOWS_JOB_SUPERVISOR_BOOTSTRAP } from "./WindowsJobSupervisorSource"

export interface WindowsOwnedProcessOptions {
	launcher: string
	executable: string
	args: readonly string[]
	cwd?: string
	input: string
	signal: AbortSignal
	onOutput: (stream: "stdout" | "stderr", text: string) => void
}

export interface WindowsOwnedProcessResult {
	exitCode: number
	cancelled: boolean
	failure?: string
}

/** The supervisor did not prove that its owned processes and output have settled. */
export class WindowsProcessOwnershipError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "WindowsProcessOwnershipError"
	}
}

/** Quote one argv element for CreateProcessW's conventional Windows argv parser, not a shell. */
export function quoteWindowsProcessArgument(argument: string): string {
	if (argument.includes("\0")) throw new Error("Windows process arguments cannot contain NUL")
	return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

const MAX_FRAME_BYTES = 64 * 1024
const MAX_DIAGNOSTIC_BYTES = 16 * 1024

function decodeFrameData(value: string): Buffer {
	const bytes = Buffer.from(value, "base64")
	if (bytes.toString("base64") !== value) throw new Error("Invalid supervisor frame encoding")
	return bytes
}

/** Parses only supervisor-owned stdout; actual child output is nested inside output frames. */
class WindowsSupervisorProtocol {
	private pending = ""
	private started = false
	private result?: WindowsOwnedProcessResult
	private failure?: string
	private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }

	constructor(private readonly output: WindowsOwnedProcessOptions["onOutput"]) { }

	append(chunk: Buffer): void {
		this.pending += chunk.toString("latin1")
		let newline: number
		while ((newline = this.pending.indexOf("\n")) !== -1) {
			if (newline > MAX_FRAME_BYTES) throw new Error("Supervisor frame exceeds its size limit")
			const line = this.pending.slice(0, newline).replace(/\r$/, "")
			this.pending = this.pending.slice(newline + 1)
			this.frame(line)
		}
		if (this.pending.length > MAX_FRAME_BYTES) throw new Error("Supervisor frame exceeds its size limit")
	}

	private frame(line: string): void {
		if (this.result) throw new Error("Supervisor emitted data after settlement")
		const [type, value, cancelled, ...extra] = line.split("\t")
		if (extra.length) throw new Error("Unexpected supervisor frame fields")
		if (type === "settled" && /^-?\d+$/.test(value ?? "") && (cancelled === "0" || cancelled === "1")) {
			const exitCode = Number(value)
			if (!Number.isSafeInteger(exitCode) || exitCode < -2147483648 || exitCode > 2147483647) throw new Error("Invalid process exit code")
			if (!this.started && this.failure === undefined && cancelled !== "1") throw new Error("Supervisor settled without starting or reporting failure")
			for (const stream of ["stdout", "stderr"] as const) {
				const trailing = this.decoders[stream].end()
				if (trailing) this.output(stream, trailing)
			}
			this.result = { exitCode, cancelled: cancelled === "1", ...(this.failure !== undefined ? { failure: this.failure } : {}) }
			return
		}
		if (value === undefined || cancelled !== undefined) throw new Error("Invalid supervisor frame shape")
		if (type === "started" && /^[1-9]\d*$/.test(value) && !this.started) {
			this.started = true
			return
		}
		if (type === "stdout" || type === "stderr") {
			if (!this.started) throw new Error("Supervisor emitted child output before ownership")
			const text = this.decoders[type].write(decodeFrameData(value))
			if (text) this.output(type, text)
			return
		}
		if (type === "failure" && this.failure === undefined) {
			this.failure = decodeFrameData(value).toString("utf8")
			return
		}
		if (type === "error") throw new Error(`Windows job cleanup failed: ${decodeFrameData(value).toString("utf8")}`)
		throw new Error(`Invalid supervisor frame type: ${type}`)
	}

	finish(): WindowsOwnedProcessResult {
		if (this.pending.length) throw new Error("Supervisor closed with an incomplete frame")
		if (!this.result) throw new Error("Supervisor closed without a settlement proof")
		return this.result
	}
}

/**
 * Runs a process under a Windows Job Object. EOF requests cancellation; it is not
 * settlement. The promise joins supervisor close and validates its terminal proof.
 * There is deliberately no taskkill or unowned fallback when native setup fails.
 */
export async function runWindowsOwnedProcess(options: WindowsOwnedProcessOptions): Promise<WindowsOwnedProcessResult> {
	options.signal.throwIfAborted()
	const commandLine = [options.executable, ...options.args].map(quoteWindowsProcessArgument).join(" ")
	if (commandLine.length >= 32767) throw new Error("Windows process command line exceeds 32766 characters")
	const directory = await mkdtemp(join(tmpdir(), "dirac-windows-job-"))
	let outcome: { result: WindowsOwnedProcessResult } | { error: unknown }
	try {
		const bootstrapPath = join(directory, "supervisor.ps1")
		await writeFile(bootstrapPath, WINDOWS_JOB_SUPERVISOR_BOOTSTRAP, { encoding: "utf8", mode: 0o600 })
		options.signal.throwIfAborted()
		outcome = { result: await runWindowsSupervisor(options, commandLine, bootstrapPath) }
	} catch (error) {
		outcome = { error }
	}
	try { await rm(directory, { recursive: true, force: true }) } catch (error) {
		const cause = "error" in outcome ? new AggregateError([outcome.error, error]) : error
		if ("error" in outcome && outcome.error instanceof WindowsProcessOwnershipError) {
			throw new WindowsProcessOwnershipError("Windows supervisor temporary-file cleanup also failed", { cause })
		}
		throw new Error("Windows supervisor temporary-file cleanup failed after process settlement", { cause })
	}
	if ("error" in outcome) throw outcome.error
	return outcome.result
}

async function runWindowsSupervisor(
	options: WindowsOwnedProcessOptions,
	commandLine: string,
	bootstrapPath: string,
): Promise<WindowsOwnedProcessResult> {
	const child = spawn(options.launcher, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bootstrapPath], {
		stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
	})
	const protocol = new WindowsSupervisorProtocol(options.onOutput)
	const failures: unknown[] = []
	let diagnostic = Buffer.alloc(0)
	let spawnFailure: Error | undefined
	const cancel = () => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end() }
	const fail = (error: unknown) => { failures.push(error); cancel() }
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("error", (error) => { spawnFailure = error; fail(error) })
		child.once("close", (code, signal) => resolve({ code, signal }))
	})
	child.stdin.on("error", fail)
	child.stdout.on("error", fail)
	child.stderr.on("error", fail)
	child.stdout.on("data", (chunk: Buffer) => {
		if (failures.length) return
		try { protocol.append(chunk) } catch (error) { fail(error) }
	})
	child.stderr.on("data", (chunk: Buffer) => {
		diagnostic = Buffer.concat([diagnostic, chunk]).subarray(-MAX_DIAGNOSTIC_BYTES)
	})
	// Queue the complete startup payload before arming cancellation. Closing
	// stdin afterward preserves queued writes and lets the supervisor see EOF.
	const startup = [options.executable, commandLine, options.cwd ?? "", options.input]
		.map((field) => Buffer.from(field, "utf8").toString("base64")).join("\n") + "\n"
	try { child.stdin.write(startup) } catch (error) { fail(error) }
	options.signal.addEventListener("abort", cancel, { once: true })
	if (options.signal.aborted) cancel()
	let exit: Awaited<typeof closed>
	try { exit = await closed } finally { options.signal.removeEventListener("abort", cancel) }
	if (!child.pid && spawnFailure) return { exitCode: -1, cancelled: false, failure: spawnFailure.message }
	if (exit.code !== 0 || exit.signal) failures.push(new Error(`Windows supervisor exited with code ${exit.code}, signal ${exit.signal}: ${diagnostic.toString("utf8")}`))
	if (failures.length) throw new WindowsProcessOwnershipError("Windows process settlement could not be confirmed", { cause: new AggregateError(failures) })
	try { return protocol.finish() } catch (error) {
		throw new WindowsProcessOwnershipError("Windows process settlement could not be confirmed", { cause: error })
	}
}
