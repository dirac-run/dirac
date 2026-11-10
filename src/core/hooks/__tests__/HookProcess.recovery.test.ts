import assert from "node:assert/strict"
import * as childProcess from "child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import { HookCleanupError } from "../HookCleanupError"
import { HookProcess } from "../HookProcess"
import { HookProcessRegistry } from "../HookProcessRegistry"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

	; (process.platform === "win32" ? describe.skip : describe)("HookProcess bounded POSIX cleanup and recovery", function () {
		this.timeout(15000)
		let directory: string
		let escapedPid: number | undefined

		beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "hook-recovery-")) })
		afterEach(async () => {
			sinon.restore()
			if (escapedPid) {
				try { process.kill(-escapedPid, "SIGKILL") } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
				}
				escapedPid = undefined
			}
			await HookProcessRegistry.terminateAll()
			await fs.rm(directory, { recursive: true, force: true })
		})

		async function script(body: string): Promise<string> {
			const scriptPath = path.join(directory, "hook")
			// Absolute interpreter avoids depending on the deliberately restricted PATH.
			await fs.writeFile(scriptPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
			return scriptPath
		}

		for (const trigger of ["abort", "timeout", "registry", "leader-exit"] as const) {
			it(`${trigger} reports escaped-pipe uncertainty promptly and can reverify later`, async () => {
				const scriptPath = await script(`
const descendant = "setInterval(() => console.log('LATE'), 30)";
const child = require('child_process').spawn(process.execPath, ['-e', descendant], {detached:true, stdio:'inherit'});
console.log('ESCAPED:' + child.pid); child.unref(); ${trigger === "leader-exit" ? "process.exit(0)" : "setInterval(() => {}, 1000)"};
`)
				const owner = new AbortController()
				const proc = new HookProcess(scriptPath, trigger === "timeout" ? 300 : 10000, owner.signal)
				const completed = sinon.spy()
				let publications = 0
				proc.on("completed", completed)
				proc.on("line", (line: string) => {
					publications++
					if (line.startsWith("ESCAPED:")) escapedPid = Number(line.slice(8))
				})
				const running = proc.run("{}")
				const rejected = assert.rejects(running, HookCleanupError)
				await pWaitFor(() => escapedPid !== undefined, { interval: 5, timeout: 2000 })
				const start = Date.now()
				let shutdown: Promise<void> | undefined
				if (trigger === "abort") owner.abort()
				if (trigger === "registry") shutdown = assert.rejects(HookProcessRegistry.terminateAll(), AggregateError)
				await rejected
				await shutdown
				assert.ok(Date.now() - start < 5000, "cleanup failure must be observable without waiting for escaped descendant exit")
				assert.equal(proc.hasCompleted(), false)
				assert.equal(HookProcessRegistry.getActiveCount(), 1)
				sinon.assert.notCalled(completed)
				process.kill(escapedPid!, 0) // No false claim that the escaped process was killed.
				const publishedAtFailure = publications
				await wait(100)
				assert.equal(publications, publishedAtFailure, "failed execution must not keep publishing late output")
				process.kill(-escapedPid!, "SIGKILL")
				escapedPid = undefined
				await Promise.all([proc.terminate(), HookProcessRegistry.terminateAll()])
				assert.equal(proc.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
				await proc.terminate() // Old rejected execution must not poison future cleanup.
			})
		}

		it("cancels with a PATH containing no ps and bounds process-table scans", async () => {
			const scriptPath = await script("process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)")
			const owner = new AbortController()
			const proc = new HookProcess(scriptPath, 10000, owner.signal)
			const inspect = sinon.spy(require("child_process") as typeof childProcess, "execFile")
			let ready = false
			proc.on("line", (line) => { if (line === "READY") ready = true })
			const previousPath = process.env.PATH
			try {
				process.env.PATH = directory
				const running = proc.run("{}")
				const rejected = assert.rejects(running, /cancelled/)
				await pWaitFor(() => ready, { interval: 5, timeout: 2000 })
				owner.abort()
				await rejected
				assert.equal(proc.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
				assert.ok(inspect.callCount > 0 && inspect.callCount <= 12, `unbounded scanning: ${inspect.callCount}`)
				for (const call of inspect.getCalls()) assert.equal(call.args[0], "/bin/ps")
			} finally {
				if (previousPath === undefined) delete process.env.PATH
				else process.env.PATH = previousPath
			}
		})

		it("retries verification after missing process inspector instead of replaying cached failure", async () => {
			const scriptPath = await script("process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)")
			const owner = new AbortController()
			const proc = new HookProcess(scriptPath, 10000, owner.signal)
			let ready = false
			proc.on("line", (line) => { if (line === "READY") ready = true })
			const running = proc.run("{}")
			const rejected = assert.rejects(running, HookCleanupError)
			await pWaitFor(() => ready, { interval: 5, timeout: 2000 })
			const missing = Object.assign(new Error("ps unavailable"), { code: "ENOENT" })
			const inspect = sinon.stub(require("child_process") as typeof childProcess, "execFile").callsFake((...args: any[]) => {
				const callback = args.at(-1)
				queueMicrotask(() => callback(missing, "", ""))
				return {} as childProcess.ChildProcess
			})
			owner.abort()
			await rejected
			assert.equal(proc.hasCompleted(), false)
			assert.equal(HookProcessRegistry.getActiveCount(), 1)
			inspect.restore()
			const signals = sinon.spy(process, "kill")
			await Promise.all([proc.terminate(), proc.terminate()])
			assert.ok(signals.getCalls().every((call) => call.args[1] === 0), "retry must never signal a potentially reused PGID")
			assert.equal(proc.hasCompleted(), true)
			assert.equal(HookProcessRegistry.getActiveCount(), 0)
			await HookProcessRegistry.terminateAll()
			await proc.terminate()
		})
	})
