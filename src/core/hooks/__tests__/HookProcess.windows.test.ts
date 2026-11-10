import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import pWaitFor from "p-wait-for"
import proxyquire from "proxyquire"
import sinon from "sinon"
import { HookCleanupError } from "../HookCleanupError"
import { HookProcessRegistry } from "../HookProcessRegistry"
import { withPlatform } from "./test-utils"
import type { runWindowsOwnedProcess } from "@/integrations/terminal/windows/WindowsOwnedProcess"

type Options = Parameters<typeof runWindowsOwnedProcess>[0]
type Result = Awaited<ReturnType<typeof runWindowsOwnedProcess>>

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((succeed, fail) => { resolve = succeed; reject = fail })
	return { promise, resolve, reject }
}

class MockWindowsProcessOwnershipError extends Error { }

function mockWindowsHook(run: (options: Options) => Promise<Result>, launch = async () => ({
	command: "C:\\PowerShell\\pwsh.exe", args: ["-File", "hook.ps1"], shell: false, detached: false,
})) {
	const adapter = sinon.spy(run)
	const spawn = sinon.spy()
	const { HookProcess } = proxyquire("../HookProcess", {
		child_process: { spawn },
		"@/integrations/terminal/windows/WindowsOwnedProcess": {
			runWindowsOwnedProcess: adapter,
			WindowsProcessOwnershipError: MockWindowsProcessOwnershipError,
			"@noCallThru": true,
		},
		"./HookLaunchConfig": { getHookLaunchConfig: launch },
	}) as typeof import("../HookProcess")
	return { HookProcess, adapter, spawn }
}

describe("HookProcess Windows owned-job integration", () => {
	afterEach(() => HookProcessRegistry.resetForTesting())

	it("routes launch config/input/output through the job owner and joins confirmed normal settlement", async () => {
		await withPlatform("win32", async () => {
			const settlement = deferred<Result>()
			const { HookProcess, adapter, spawn } = mockWindowsHook(() => settlement.promise)
			const hook = new HookProcess("hook.ps1", 5000, undefined, "C:\\workspace")
			const lines: string[] = []
			hook.on("line", (line) => lines.push(line))
			let settled = false
			const running = hook.run('{"prompt":"hello"}').then(() => { settled = true })
			await pWaitFor(() => adapter.calledOnce, { interval: 1 })
			const options = adapter.firstCall.args[0]
			assert.equal(options.launcher, "C:\\PowerShell\\pwsh.exe")
			assert.equal(options.executable, options.launcher)
			assert.deepEqual(options.args, ["-File", "hook.ps1"])
			assert.equal(options.cwd, "C:\\workspace")
			assert.equal(options.input, '{"prompt":"hello"}')
			options.onOutput("stdout", "héllo 🌍\n")
			options.onOutput("stderr", "warning\n")
			assert.equal(settled, false)
			assert.equal(hook.hasCompleted(), false)
			assert.equal(HookProcessRegistry.getActiveCount(), 1)
			settlement.resolve({ exitCode: 0, cancelled: false })
			await running
			assert.equal(hook.getExitCode(), 0)
			assert.equal(hook.getStdout(), "héllo 🌍\n")
			assert.equal(hook.getStderr(), "warning\n")
			assert.ok(lines.includes("héllo 🌍"))
			assert.equal(hook.hasCompleted(), true)
			assert.equal(HookProcessRegistry.getActiveCount(), 0)
			sinon.assert.notCalled(spawn)
		})
	})

	for (const trigger of ["abort", "terminate", "timeout", "registry"] as const) {
		it(`${trigger} signals startup owner but waits for job/streams settlement`, async () => {
			await withPlatform("win32", async () => {
				const settlement = deferred<Result>()
				const { HookProcess, adapter } = mockWindowsHook(() => settlement.promise)
				const owner = new AbortController()
				const hook = new HookProcess("hook.ps1", trigger === "timeout" ? 10 : 5000, owner.signal)
				let settled = false
				const running = hook.run("{}").finally(() => { settled = true })
				const rejection = assert.rejects(running, trigger === "timeout" ? /timed out/ : /cancelled/)
				await pWaitFor(() => adapter.calledOnce, { interval: 1 })
				const signal = adapter.firstCall.args[0].signal
				let stopped: Promise<void> | undefined
				if (trigger === "abort") owner.abort()
				if (trigger === "terminate") stopped = hook.terminate()
				if (trigger === "registry") stopped = HookProcessRegistry.terminateAll()
				await pWaitFor(() => signal.aborted, { interval: 1 })
				assert.equal(settled, false)
				assert.equal(hook.hasCompleted(), false)
				assert.equal(HookProcessRegistry.getActiveCount(), 1)
				settlement.resolve({ exitCode: 130, cancelled: true })
				await rejection
				await stopped
				assert.equal(hook.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
			})
		})
	}

	it("prevents supervisor creation after abort during launch discovery", async () => {
		await withPlatform("win32", async () => {
			const config = deferred<{ command: string; args: string[]; shell: boolean; detached: boolean }>()
			const { HookProcess, adapter, spawn } = mockWindowsHook(async () => ({ exitCode: 0, cancelled: false }), () => config.promise)
			const owner = new AbortController()
			const hook = new HookProcess("hook.ps1", 5000, owner.signal)
			const running = hook.run("{}")
			const rejection = assert.rejects(running, /cancelled/)
			owner.abort()
			assert.equal(HookProcessRegistry.getActiveCount(), 1)
			config.resolve({ command: "powershell", args: [], shell: false, detached: false })
			await rejection
			sinon.assert.notCalled(adapter)
			sinon.assert.notCalled(spawn)
			assert.equal(HookProcessRegistry.getActiveCount(), 0)
		})
	})

	it("preserves a confirmed nonzero hook exit without reporting ownership failure", async () => {
		await withPlatform("win32", async () => {
			const { HookProcess } = mockWindowsHook(async () => ({ exitCode: 7, cancelled: false }))
			const hook = new HookProcess("hook.ps1", 5000)
			await assert.rejects(hook.run("{}"), /Hook exited with code 7/)
			assert.equal(hook.getExitCode(), 7)
			assert.equal(hook.hasCompleted(), true)
			assert.equal(HookProcessRegistry.getActiveCount(), 0)
			await hook.terminate()
		})
	})

	it("unregisters confirmed startup failure while preserving its error", async () => {
		await withPlatform("win32", async () => {
			const { HookProcess } = mockWindowsHook(async () => ({ exitCode: -1, cancelled: false, failure: "CreateProcess failed" }))
			const hook = new HookProcess("hook.ps1", 5000)
			await assert.rejects(hook.run("{}"), /CreateProcess failed/)
			assert.equal(hook.hasCompleted(), true)
			assert.equal(HookProcessRegistry.getActiveCount(), 0)
		})
	})

	it("retains registry ownership and rejects teardown on missing trusted settlement, even after cancellation", async () => {
		await withPlatform("win32", async () => {
			const settlement = deferred<Result>()
			const { HookProcess, adapter } = mockWindowsHook(() => settlement.promise)
			const owner = new AbortController()
			const hook = new HookProcess("hook.ps1", 5000, owner.signal)
			const running = hook.run("{}")
			const uncertain = new MockWindowsProcessOwnershipError("supervisor crashed without terminal attestation")
			const rejection = assert.rejects(running, (error: unknown) => {
				assert.ok(error instanceof HookCleanupError)
				assert.deepEqual(error.errors, [uncertain])
				return true
			})
			await pWaitFor(() => adapter.calledOnce, { interval: 1 })
			owner.abort()
			settlement.reject(uncertain)
			await rejection
			assert.equal(hook.hasCompleted(), false)
			assert.equal(HookProcessRegistry.getActiveCount(), 1)
			await assert.rejects(hook.terminate(), HookCleanupError)
			await assert.rejects(HookProcessRegistry.terminateAll(), /Hook process cleanup failed/)
		})
	})
})

	; (process.platform === "win32" ? describe : describe.skip)("HookProcess real Windows job ownership", () => {
		let directory: string
		beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "windows-hook-job-")) })
		afterEach(async () => {
			await HookProcessRegistry.terminateAll()
			await fs.rm(directory, { recursive: true, force: true })
		})

		for (const cancel of [false, true]) {
			it(`joins a redirected-stdio descendant when the PowerShell leader ${cancel ? "is cancelled" : "exits normally"}`, async function () {
				this.timeout(30000)
				const { HookProcess } = await import("../HookProcess")
				const descendant = path.join(directory, "descendant.ps1")
				const ready = path.join(directory, "ready")
				const late = path.join(directory, "late")
				const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`
				await fs.writeFile(descendant, `[IO.File]::WriteAllText(${quoted(ready)}, 'ready')\nStart-Sleep -Seconds 2\n[IO.File]::WriteAllText(${quoted(late)}, 'still alive')\n`)
				const script = path.join(directory, "hook.ps1")
				await fs.writeFile(script, `$info = New-Object Diagnostics.ProcessStartInfo\n$info.FileName = (Get-Process -Id $PID).Path\n$info.Arguments = '-NoProfile -NonInteractive -File "${descendant.replace(/"/g, '\\"')}"'\n$info.UseShellExecute = $false\n$info.CreateNoWindow = $true\n$info.RedirectStandardOutput = $true\n$info.RedirectStandardError = $true\n$child = [Diagnostics.Process]::Start($info)\nwhile (!(Test-Path ${quoted(ready)})) { Start-Sleep -Milliseconds 10 }\nWrite-Output 'READY'\n${cancel ? "Start-Sleep -Seconds 20" : "exit 0"}\n`)
				const owner = new AbortController()
				const hook = new HookProcess(script, 20000, owner.signal)
				let started = false
				hook.on("line", (line) => { if (line === "READY") started = true })
				const running = hook.run("{}")
				const rejection = cancel ? assert.rejects(running, /cancelled/) : undefined
				await pWaitFor(() => started, { interval: 5, timeout: 20000 })
				if (cancel) owner.abort()
				if (rejection) await rejection
				else await running
				assert.equal(hook.hasCompleted(), true)
				assert.equal(HookProcessRegistry.getActiveCount(), 0)
				await new Promise<void>((resolve) => setTimeout(resolve, 2200))
				await assert.rejects(fs.stat(late), { code: "ENOENT" })
			})
		}
	})
