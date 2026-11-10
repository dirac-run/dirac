import assert from "node:assert/strict"
import * as childProcess from "child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import * as launch from "../HookLaunchConfig"
import { HookProcess } from "../HookProcess"
import { HookProcessRegistry } from "../HookProcessRegistry"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => { resolve = settle })
	return { promise, resolve }
}

async function script(body: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hook-ownership-"))
	const scriptPath = path.join(directory, "hook")
	await fs.writeFile(scriptPath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
	return { scriptPath, directory }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

	// These exercise POSIX detached groups, not native Windows Job Objects.
	; (process.platform === "win32" ? describe.skip : describe)("HookProcess process ownership", () => {
		afterEach(async () => {
			await HookProcessRegistry.terminateAll()
			sinon.restore()
		})

		it("keeps cancellation registered until graceful child cleanup has exited", async () => {
			const hook = await script(`
process.on('SIGTERM', () => setTimeout(() => {
  console.log('CLEANED'); process.exit(0);
}, 200));
console.log('READY'); setInterval(() => {}, 1000);
`)
			try {
				const owner = new AbortController()
				const proc = new HookProcess(hook.scriptPath, 5000, owner.signal)
				let ready = false
				let cleaned = false
				proc.on("line", (line) => { if (line === "READY") ready = true; if (line === "CLEANED") cleaned = true })
				let settled = false
				const running = proc.run("{}").finally(() => { settled = true })
				const rejection = assert.rejects(running, /cancelled/)
				await pWaitFor(() => ready, { interval: 5 })
				owner.abort()
				await wait(40)
				assert.equal(settled, false)
				assert.equal(proc.hasCompleted(), false)
				assert.equal(HookProcessRegistry.getActiveCount(), 1)
				await rejection
				assert.equal(cleaned, true)
				assert.equal(proc.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
			} finally {
				await fs.rm(hook.directory, { recursive: true, force: true })
			}
		})

		for (const trigger of ["abort", "normal exit"] as const) {
			it(`joins redirected-stdio descendants after leader ${trigger}`, async () => {
				const hook = await script("")
				const readyFile = path.join(hook.directory, "ready")
				const cleanedFile = path.join(hook.directory, "cleaned")
				const descendant = `
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleanedFile)}, 'done'); process.exit(0); }, 200));
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`
				await fs.writeFile(hook.scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}).unref();
const ready = setInterval(() => { if (!fs.existsSync(${JSON.stringify(readyFile)})) return; clearInterval(ready); console.log('READY'); ${trigger === "normal exit" ? "process.exit(0)" : "setInterval(() => {}, 1000)"}; }, 5);
`)
				try {
					const owner = new AbortController()
					const proc = new HookProcess(hook.scriptPath, 5000, owner.signal)
					let ready = false
					proc.on("line", (line) => { if (line === "READY") ready = true })
					let settled = false
					const running = proc.run("{}").finally(() => { settled = true })
					const rejection = trigger === "abort" ? assert.rejects(running, /cancelled/) : undefined
					await pWaitFor(() => ready, { interval: 5 })
					if (trigger === "abort") owner.abort()
					await wait(40)
					assert.equal(settled, false)
					assert.equal(proc.hasCompleted(), false)
					assert.equal(HookProcessRegistry.getActiveCount(), 1)
					if (rejection) await rejection
					else await running
					assert.equal(await fs.readFile(cleanedFile, "utf8"), "done")
					assert.equal(HookProcessRegistry.getActiveCount(), 0)
				} finally {
					await fs.rm(hook.directory, { recursive: true, force: true })
				}
			})
		}

		for (const stdio of ["ignore", "inherit"] as const) {
			it(`cleans up ${stdio}-stdio descendants on leader exit before the hook deadline`, async () => {
				const hook = await script(`
require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:${JSON.stringify(stdio)}}).unref();
process.exit(0);
`)
				try {
					const proc = new HookProcess(hook.scriptPath, 500)
					await proc.run("{}")
					assert.equal(proc.getExitCode(), 0)
					assert.equal(proc.hasCompleted(), true)
					assert.equal(HookProcessRegistry.getActiveCount(), 0)
				} finally {
					await fs.rm(hook.directory, { recursive: true, force: true })
				}
			})
		}

		for (const cancelDuringCleanup of [false, true]) {
			it(`joins inherited-pipe output and group cleanup after leader exit${cancelDuringCleanup ? " with cancellation" : ""}`, async () => {
				const hook = await script("")
				const readyFile = path.join(hook.directory, "ready")
				const descendant = `
const fs = require('node:fs');
process.on('SIGTERM', () => {
  console.log('STOPPING');
  setTimeout(() => { console.error('CLEANED'); process.exit(0); }, 200);
});
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`
				await fs.writeFile(hook.scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}).unref();
setInterval(() => { if (fs.existsSync(${JSON.stringify(readyFile)})) process.exit(0); }, 5);
`)
				try {
					const owner = new AbortController()
					const proc = new HookProcess(hook.scriptPath, 5000, owner.signal)
					let stopping = false
					proc.on("line", (line) => { if (line === "STOPPING") stopping = true })
					let settled = false
					const running = proc.run("{}").finally(() => { settled = true })
					const rejection = cancelDuringCleanup ? assert.rejects(running, /cancelled/) : undefined
					await pWaitFor(() => stopping, { interval: 5 })
					if (cancelDuringCleanup) owner.abort()
					await wait(40)
					assert.equal(settled, false)
					assert.equal(proc.hasCompleted(), false)
					assert.equal(HookProcessRegistry.getActiveCount(), 1)
					if (rejection) await rejection
					else await running
					assert.match(proc.getStderr(), /CLEANED/)
					assert.equal(proc.hasCompleted(), true)
					assert.equal(HookProcessRegistry.getActiveCount(), 0)
				} finally {
					await fs.rm(hook.directory, { recursive: true, force: true })
				}
			})
		}

		for (const trigger of ["abort", "timeout", "registry"] as const) {
			it(`${trigger} joins SIGKILL escalation for a child ignoring SIGTERM`, async () => {
				const hook = await script(`process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);`)
				try {
					const owner = new AbortController()
					const proc = new HookProcess(hook.scriptPath, trigger === "timeout" ? 500 : 10000, owner.signal)
					let ready = false
					proc.on("line", (line) => { if (line === "READY") ready = true })
					let settled = false
					const running = proc.run("{}").finally(() => { settled = true })
					const rejection = assert.rejects(running, trigger === "timeout" ? /timed out/ : /cancelled/)
					await pWaitFor(() => ready, { interval: 5 })
					let stopped: Promise<void> | undefined
					if (trigger === "abort") owner.abort()
					if (trigger === "registry") stopped = HookProcessRegistry.terminateAll()
					await wait(trigger === "timeout" ? 550 : 50)
					assert.equal(settled, false)
					assert.equal(proc.hasCompleted(), false)
					assert.equal(HookProcessRegistry.getActiveCount(), 1)
					await rejection
					await stopped
					assert.equal(proc.hasCompleted(), true)
					assert.equal(HookProcessRegistry.getActiveCount(), 0)
				} finally {
					await fs.rm(hook.directory, { recursive: true, force: true })
				}
			})
		}

		for (const trigger of ["abort", "terminate"] as const) {
			it(`${trigger} during launcher discovery retains ownership and prevents spawning`, async () => {
				const config = deferred<launch.HookLaunchConfig>()
				const discover = sinon.stub(launch, "getHookLaunchConfig").returns(config.promise)
				const spawn = sinon.spy(require("child_process") as typeof childProcess, "spawn")
				const owner = new AbortController()
				const proc = new HookProcess("not-launched", 5000, owner.signal)
				let settled = false
				const running = proc.run("{}").finally(() => { settled = true })
				const rejection = assert.rejects(running, /cancelled/)
				sinon.assert.calledOnce(discover)
				let stopped: Promise<void> | undefined
				if (trigger === "abort") owner.abort()
				else stopped = proc.terminate()
				await wait(10)
				assert.equal(settled, false)
				assert.equal(proc.hasCompleted(), false)
				assert.equal(HookProcessRegistry.getActiveCount(), 1)
				config.resolve({ command: process.execPath, args: ["-e", "process.exit(0)"], shell: false, detached: true })
				await rejection
				await stopped
				sinon.assert.notCalled(spawn)
				assert.equal(proc.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
			})
		}
	})
