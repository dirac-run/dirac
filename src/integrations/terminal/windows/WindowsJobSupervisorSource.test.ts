import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { describe, it } from "mocha"
import { WINDOWS_JOB_SUPERVISOR_BOOTSTRAP, WINDOWS_JOB_SUPERVISOR_SOURCE } from "./WindowsJobSupervisorSource"
import { quoteWindowsProcessArgument } from "./WindowsOwnedProcess"

describe("Windows job supervisor bootstrap", () => {
	it("embeds the exact C# source without putting startup values into PowerShell", () => {
		const encoded = WINDOWS_JOB_SUPERVISOR_BOOTSTRAP.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
		assert.ok(encoded)
		assert.equal(Buffer.from(encoded, "base64").toString("utf8"), WINDOWS_JOB_SUPERVISOR_SOURCE)
		assert.match(WINDOWS_JOB_SUPERVISOR_BOOTSTRAP, /\$ErrorActionPreference = 'Stop'/)
		assert.match(WINDOWS_JOB_SUPERVISOR_BOOTSTRAP, /Add-Type -TypeDefinition \$source/)
		assert.doesNotMatch(WINDOWS_JOB_SUPERVISOR_BOOTSTRAP, /Invoke-Expression|Start-Process|taskkill/i)
	})

	it("requires atomic job assignment and an explicit child-only inheritance list", () => {
		assert.match(WINDOWS_JOB_SUPERVISOR_SOURCE, /JOB_LIST = new IntPtr\(0x0002000D\)/)
		assert.match(WINDOWS_JOB_SUPERVISOR_SOURCE, /HANDLE_LIST = new IntPtr\(0x00020002\)/)
		assert.match(WINDOWS_JOB_SUPERVISOR_SOURCE, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
		assert.doesNotMatch(WINDOWS_JOB_SUPERVISOR_SOURCE, /AssignProcessToJobObject|BREAKAWAY/)
		const created = WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf("Check(CreateProcessW(")
		const started = WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf('Frame("started\\t"')
		const pump = WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf("workers.Output.Start()")
		const resumed = WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf("if (ResumeThread(")
		assert.ok(created < started && started < pump && pump < resumed)
		assert.ok(WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf("WaitForEmptyJob(job);") < WINDOWS_JOB_SUPERVISOR_SOURCE.indexOf("Join(workers.Output);"))
		assert.match(WINDOWS_JOB_SUPERVISOR_SOURCE, /CreateProcessW\(ResolveExecutable\(executable, cwd\)/)
	})
})

interface NativeRun {
	child: ChildProcessWithoutNullStreams
	frames: string[][]
	output: { stdout: Buffer[]; stderr: Buffer[] }
	closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	waitForOutput: (text: string) => Promise<void>
	cleanup: () => Promise<void>
}

async function launchSupervisor(launcher: string, script: string, input = "", executable = process.execPath): Promise<NativeRun> {
	const directory = await mkdtemp(join(tmpdir(), "dirac-job-test-"))
	const bootstrap = join(directory, "supervisor.ps1")
	await writeFile(bootstrap, WINDOWS_JOB_SUPERVISOR_BOOTSTRAP)
	const child = spawn(launcher, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bootstrap], {
		stdio: "pipe", windowsHide: true,
		env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
	})
	const frames: string[][] = []
	const output: NativeRun["output"] = { stdout: [], stderr: [] }
	let pending = ""
	let diagnostics = ""
	let spawnError: Error | undefined
	const listeners = new Set<() => void>()
	child.stdout.on("data", (chunk: Buffer) => {
		pending += chunk.toString("ascii")
		let newline: number
		while ((newline = pending.indexOf("\n")) >= 0) {
			const frame = pending.slice(0, newline).replace(/\r$/, "").split("\t")
			pending = pending.slice(newline + 1)
			frames.push(frame)
			if (frame[0] === "stdout" || frame[0] === "stderr") output[frame[0]].push(Buffer.from(frame[1], "base64"))
		}
		for (const listener of listeners) listener()
	})
	child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8") })
	child.on("error", (error) => { spawnError = error })
	// A killed supervisor can close its input while the test is sending cancellation.
	child.stdin.on("error", () => { })
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("close", (code, signal) => {
			for (const listener of listeners) listener()
			if (spawnError) reject(spawnError)
			else if (pending) reject(new Error(`Incomplete supervisor frame: ${pending}; ${diagnostics}`))
			else resolve({ code, signal })
		})
	})
	const commandLine = [executable, "-e", script].map(quoteWindowsProcessArgument).join(" ")
	child.stdin.write([executable, commandLine, directory, input].map((value) => Buffer.from(value, "utf8").toString("base64")).join("\n") + "\n")
	return {
		child, frames, output, closed,
		waitForOutput: (text) => new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing output ${text}; ${JSON.stringify(frames)}; ${diagnostics}`)) }, 20000)
			const check = () => {
				if (!Buffer.concat(output.stdout).toString("utf8").includes(text)) return
				clearTimeout(timer)
				listeners.delete(check)
				resolve()
			}
			listeners.add(check)
			check()
		}),
		cleanup: async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill()
			await closed
			await rm(directory, { recursive: true, force: true })
		},
	}
}

function assertClean(run: NativeRun, exitCode: number, cancelled = false): void {
	assert.equal(run.frames.filter(([type]) => type === "settled").length, 1)
	assert.deepEqual(run.frames.at(-1), ["settled", String(exitCode), cancelled ? "1" : "0"])
	assert.equal(run.frames.some(([type]) => type === "error"), false, JSON.stringify(run.frames))
}

function assertDead(pid: number): void {
	assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", `Process ${pid} survived ownership settlement`)
}

const windowsLaunchers = process.platform === "win32" ? [
	join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
].filter(existsSync) : []

	// These tests execute the real Win32 supervisor, not mocks. Linux/macOS intentionally skip them.
	; (process.platform === "win32" ? describe : describe.skip)("Windows native Job Object ownership", function () {
		this.timeout(60000)

		it("has an installed PowerShell host", () => { assert.ok(windowsLaunchers.length > 0) })

		for (const launcher of windowsLaunchers) {
			describe(launcher, () => {
				it("isolates binary child output from trusted protocol frames", async () => {
					const run = await launchSupervisor(launcher, `process.stdout.write(Buffer.from([0,255,128,10]));process.stderr.write('settled\\t0\\t0\\n');`)
					try {
						assert.equal((await run.closed).code, 0)
						assert.equal(run.frames[0]?.[0], "started")
						assert.deepEqual(Buffer.concat(run.output.stdout), Buffer.from([0, 255, 128, 10]))
						assert.equal(Buffer.concat(run.output.stderr).toString(), "settled\t0\t0\n")
						assertClean(run, 0)
					} finally { await run.cleanup() }
				})

				it("drains large output concurrently with large stdin", async () => {
					const input = "λ".repeat(256 * 1024)
					const run = await launchSupervisor(launcher, `process.stdout.write(Buffer.alloc(512*1024,120));let bytes=0;process.stdin.on('data',b=>bytes+=b.length);process.stdin.on('end',()=>process.stderr.write(String(bytes)));`, input)
					try {
						assert.equal((await run.closed).code, 0)
						assert.equal(Buffer.concat(run.output.stdout).length, 512 * 1024)
						assert.equal(Buffer.concat(run.output.stderr).toString(), String(Buffer.byteLength(input)))
						assertClean(run, 0)
					} finally { await run.cleanup() }
				})

				for (const end of ["leader-exit", "cancel", "eof", "supervisor-death"] as const) {
					it(`kills redirected-stdio descendants on ${end}`, async () => {
						const directory = await mkdtemp(join(tmpdir(), "dirac-job-marker-"))
						const marker = join(directory, "survived")
						const descendant = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'survived'),2500);setInterval(()=>{},1000);process.send('ready');`
						const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});c.once('message',()=>{process.stdout.write('ready:'+process.pid+':'+c.pid+'\\n',()=>{${end === "leader-exit" ? "process.exit(0)" : "setInterval(()=>{},1000)"}})});`
						const run = await launchSupervisor(launcher, script)
						try {
							await run.waitForOutput("ready:")
							const pids = Buffer.concat(run.output.stdout).toString().match(/ready:(\d+):(\d+)/)!.slice(1).map(Number)
							if (end === "cancel") run.child.stdin.write("cancel\n")
							if (end === "eof") run.child.stdin.end()
							if (end === "supervisor-death") run.child.kill()
							const closed = await run.closed
							if (end !== "supervisor-death") {
								assert.equal(closed.code, 0)
								assertClean(run, end === "leader-exit" ? 0 : -1, end !== "leader-exit")
							} else assert.equal(run.frames.some(([type]) => type === "settled"), false)
							// Kill-on-close teardown is asynchronous when the host is forcibly terminated.
							await new Promise((resolve) => setTimeout(resolve, 3000))
							for (const pid of pids) assertDead(pid)
							assert.equal(existsSync(marker), false)
						} finally {
							await run.cleanup()
							await rm(directory, { recursive: true, force: true })
						}
					})
				}

				it("resolves a bare executable through native PATH search", async () => {
					const run = await launchSupervisor(launcher, "process.stdout.write('path-resolved')", "", basename(process.execPath))
					try {
						assert.equal((await run.closed).code, 0)
						assert.equal(Buffer.concat(run.output.stdout).toString(), "path-resolved")
						assertClean(run, 0)
					} finally { await run.cleanup() }
				})

				it("reports failed creation only after proving ownership settled", async () => {
					const run = await launchSupervisor(launcher, "", "", join(tmpdir(), "dirac-does-not-exist.exe"))
					try {
						assert.equal((await run.closed).code, 0)
						assert.equal(run.frames[0]?.[0], "failure")
						assert.match(Buffer.from(run.frames[0][1], "base64").toString(), /CreateProcessW/)
						assertClean(run, -1)
					} finally { await run.cleanup() }
				})
			})
		}
	})
