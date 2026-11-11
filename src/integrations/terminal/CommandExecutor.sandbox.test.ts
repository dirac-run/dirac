import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { CommandExecutor } from "./CommandExecutor"
import * as native from "./sandbox/nativeSandbox"
import { NativeSandboxError, type PreparedSandboxLaunch } from "./sandbox"
import { StandaloneTerminalManager } from "./standalone/StandaloneTerminalManager"
import type { CommandExecutorCallbacks } from "./types"

const options = { sandbox: { profile: "default" as const }, suppressUserInteraction: true }
function executor() {
	const manager = new StandaloneTerminalManager()
	const callbacks: CommandExecutorCallbacks = {
		taskMessenger: {} as CommandExecutorCallbacks["taskMessenger"], updateBackgroundCommandState() { },
		updateDiracMessage: async () => { }, getDiracMessages: () => [], addToUserMessageContent() { },
		getEnvironmentVariables: async () => ({ DIRAC_SANDBOX_TEST: "literal ; $(not-a-command)" }),
	}
	return { manager, command: new CommandExecutor({ cwd: process.cwd(), taskId: "sandbox-test", ulid: "sandbox-test", terminalExecutionMode: "vscodeTerminal", terminalManager: manager }, callbacks) }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

describe("CommandExecutor native sandbox integration", () => {
	afterEach(() => sinon.restore())

	it("leaves the ordinary launch and selected manager untouched without opt-in", async () => {
		const prepare = sinon.stub(native, "prepareNativeSandbox").rejects(new Error("must not prepare"))
		const { manager, command } = executor()
		const run = sinon.spy(manager, "runCommand")
		try {
			const result = await command.execute("echo ordinary", undefined, { suppressUserInteraction: true })
			assert.match(String(result[1]), /ordinary/)
			assert.equal(run.firstCall.args.length, 2)
			sinon.assert.notCalled(prepare)
		} finally { await command.dispose(); await manager.disposeAll() }
	})

	it("prepares structured shell data, then authorizes and launches freshly outside the VSCode manager", async () => {
		const { manager, command } = executor()
		const selected = sinon.spy(manager, "runCommand")
		let authorized = false
		const prepare = sinon.stub(native, "prepareNativeSandbox").callsFake(async (request) => ({
			backend: "bubblewrap", policy: request.policy,
			spawn: () => { assert.equal(authorized, true); return spawn(request.executable, [...request.args], { cwd: request.cwd, env: request.env, detached: true, stdio: ["ignore", "pipe", "pipe"] }) },
			terminate: async () => { },
			dispose() { },
		}))
		try {
			const result = await command.execute("printf '%s\\n' \"$DIRAC_SANDBOX_TEST\"; echo stderr >&2; exit 7", undefined, { ...options, assertAuthorized: () => { authorized = true } })
			assert.equal(result[2]?.exitCode, 7)
			assert.match(String(result[1]), /literal ; \$\(not-a-command\)/)
			assert.match(String(result[1]), /stderr/)
			assert.equal(prepare.firstCall.args[0].args[0], "-c")
			assert.equal(prepare.firstCall.args[0].cwd, process.cwd())
			sinon.assert.notCalled(selected)
		} finally { await command.dispose(); await manager.disposeAll() }
	})

	for (const reason of ["cancelled", "revoked"] as const) {
		it(`does not launch when ${reason} during asynchronous native preparation`, async () => {
			const entered = deferred<void>(), prepared = deferred<PreparedSandboxLaunch>()
			const launch = sinon.stub()
			sinon.stub(native, "prepareNativeSandbox").callsFake(() => { entered.resolve(); return prepared.promise })
			const { manager, command } = executor()
			let authorized = true
			const execution = command.execute("never runs", undefined, { ...options, assertAuthorized: () => { if (!authorized) throw new Error("revoked") } })
			await entered.promise
			if (reason === "cancelled") await command.cancelBackgroundCommand()
			else authorized = false
			const dispose = sinon.spy()
			prepared.resolve({ backend: "bubblewrap", policy: { id: "default" }, spawn: launch, terminate: async () => { }, dispose })
			try {
				if (reason === "cancelled") assert.equal((await execution)[0], true)
				else await assert.rejects(execution, /revoked/)
				sinon.assert.notCalled(launch)
				sinon.assert.calledOnce(dispose)
			} finally { await command.dispose(); await manager.disposeAll() }
		})
	}

	for (const stage of ["before-launch", "execution-uncertain"] as const) {
		it(`preserves ${stage} failure without retry or unrestricted fallback`, async () => {
			const error = new NativeSandboxError("native failure", stage === "before-launch" ? "missing-helper" : "launch-failed", stage)
			const prepare = sinon.stub(native, "prepareNativeSandbox")
			if (stage === "before-launch") prepare.rejects(error)
			else prepare.resolves({ backend: "bubblewrap", policy: { id: "default" }, spawn: () => { throw error }, terminate: async () => { }, dispose() { } })
			const { manager, command } = executor()
			const ordinary = sinon.spy(manager, "runCommand")
			try {
				await assert.rejects(command.execute("must not retry", undefined, options), (actual) => actual === error)
				sinon.assert.calledOnce(prepare)
				sinon.assert.notCalled(ordinary)
			} finally { await command.dispose(); await manager.disposeAll() }
		})
	}

	it("uses the original normal path once for authorized prelaunch fallback and exposes effective background status", async () => {
		sinon.stub(native, "prepareNativeSandbox").rejects(new NativeSandboxError("helper unavailable", "missing-helper", "before-launch", true))
		const { manager, command } = executor()
		const hidden = (command as unknown as { standaloneManager: StandaloneTerminalManager }).standaloneManager
		const run = sinon.spy(hidden, "runCommand")
		const { captureSandboxExecution } = await import("@shared/SandboxExecution")
		const { DEFAULT_SANDBOX_SETTINGS } = await import("@shared/SandboxSettings")
		const requested = captureSandboxExecution({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true, allowUnsandboxedFallback: true }, true)
		try {
			const result = await command.execute("sleep 0.1; echo fallback-ok", 0.01, { ...options, useBackgroundExecution: true, sandbox: { profile: "default", allowUnsandboxedFallback: true }, sandboxContext: requested })
			assert.equal(result[2]?.sandbox?.effective, "unsandboxed-fallback")
			assert.equal(result[2]?.sandbox?.requested, requested)
			assert.match(result[2]!.sandbox!.reason!, /helper unavailable/)
			sinon.assert.calledOnce(run)
			assert.equal(run.firstCall.args.length, 2)
			await result[2]?.backgroundCompletion
		} finally { await command.dispose(); await manager.disposeAll() }
	})

	for (const failure of ["disallowed", "invalid-policy", "uncertain", "program"] as const) {
		it(`never downgrades ${failure} failure`, async () => {
			const error = new NativeSandboxError(failure, failure === "invalid-policy" ? "invalid-policy" : "launch-failed", failure === "uncertain" ? "execution-uncertain" : "before-launch", failure !== "invalid-policy")
			const prepare = sinon.stub(native, "prepareNativeSandbox")
			if (failure === "program") prepare.resolves({ backend: "bubblewrap", policy: { id: "default" }, spawn: () => { throw error }, terminate: async () => { }, dispose() { } })
			else prepare.rejects(error)
			const { manager, command } = executor()
			const run = sinon.spy(manager, "runCommand")
			try {
				await assert.rejects(command.execute("must not downgrade", undefined, { ...options, sandbox: { profile: "default", allowUnsandboxedFallback: failure !== "disallowed" } }), (actual) => actual === error)
				sinon.assert.notCalled(run)
			} finally { await command.dispose(); await manager.disposeAll() }
		})
	}

	for (const reason of ["cancel", "settings"] as const) {
		it(`rechecks ${reason} after fallback reacquires the normal terminal`, async () => {
			sinon.stub(native, "prepareNativeSandbox").rejects(new NativeSandboxError("unavailable", "setup-failed", "before-launch", true))
			const { manager, command } = executor()
			const entered = deferred<void>(), acquisition = deferred<import("./types").TerminalInfo>()
			const acquire = manager.getOrCreateTerminal.bind(manager)
			sinon.stub(manager, "getOrCreateTerminal").callsFake(() => { entered.resolve(); return acquisition.promise })
			const run = sinon.spy(manager, "runCommand")
			let valid = true
			const result = command.execute("never launches", undefined, { ...options, sandbox: { profile: "default", allowUnsandboxedFallback: true }, assertAuthorized: () => { if (!valid) throw new Error("settings changed") } })
			await entered.promise
			if (reason === "cancel") await command.cancelBackgroundCommand()
			else valid = false
			acquisition.resolve(await acquire(process.cwd()))
			try {
				if (reason === "cancel") assert.equal((await result)[0], true)
				else await assert.rejects(result, /settings changed/)
				sinon.assert.notCalled(run)
			} finally { await command.dispose(); await manager.disposeAll() }
		})
	}

	it("passes custom policy and trusted roots to preparation without remerging the filtered environment", async () => {
		const { captureSandboxExecution } = await import("@shared/SandboxExecution")
		const { DEFAULT_SANDBOX_SETTINGS, validateCustomSandboxProfile } = await import("@shared/SandboxSettings")
		const profile = validateCustomSandboxProfile({
			id: "custom", name: "Workspace", description: "", kind: "custom", revision: 3,
			filesystem: { base: "selected", workspace: "read-only", readable: [], writable: [], blocked: [], caches: [] },
			temporaryDirectory: "/tmp/private", network: "deny", environment: { passthrough: [], overrides: {} },
		})
		const requested = captureSandboxExecution({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true, mainAgentProfileId: profile.id, profiles: [profile] }, false)
		const context = { workspaceRoots: ["/workspace", "/second"], protectedPaths: ["/actual-config", "/external-storage"] }
		const dispose = sinon.spy()
		const prepare = sinon.stub(native, "prepareNativeSandbox").callsFake(async (request) => ({
			backend: "bubblewrap", policy: request.policy, dispose, terminate: async () => { },
			spawn: () => spawn(process.execPath, ["-e", "console.log(process.env.DIRAC_SANDBOX_TEST || 'filtered')"], { env: {}, stdio: ["ignore", "pipe", "pipe"] }),
		}))
		const { manager, command } = executor()
		try {
			const result = await command.execute("ignored by test launcher", undefined, { ...options, sandboxContext: requested, sandbox: { profile: "default", context } })
			assert.deepEqual(prepare.firstCall.args[0].policy, requested.profile)
			assert.deepEqual(prepare.firstCall.args[0].context, context)
			assert.match(String(result[1]), /filtered/)
			sinon.assert.calledOnce(dispose)
		} finally { await command.dispose(); await manager.disposeAll() }
	})

	it("reports incomplete hard-timeout cleanup without an unhandled rejection or a stopped claim", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const manager = new StandaloneTerminalManager()
		const { StandaloneTerminalProcess } = await import("./standalone/StandaloneTerminalProcess")
		const { BACKGROUND_COMMAND_TIMEOUT_MS } = await import("./constants")
		const process = new StandaloneTerminalProcess()
		const terminate = sinon.stub(process, "terminate").rejects(new Error("descendants may remain"))
		const tracked = manager.trackBackgroundCommand(process as unknown as import("./types").TerminalProcessResultPromise, "timeout test")
		try {
			await clock.tickAsync(BACKGROUND_COMMAND_TIMEOUT_MS + 100)
			clock.restore()
			await delay(100)
			const log = await readFile(tracked.logFilePath, "utf8")
			sinon.assert.calledOnce(terminate)
			assert.equal(tracked.status, "error")
			assert.match(log, /CLEANUP_ERROR.*cleanup incomplete: descendants may remain/)
			assert.doesNotMatch(log, /Process (killed|stopped)/)
		} finally { clock.restore(); await manager.disposeAll() }
	})

	it("retains actual native output, completion, background logs and cancellation ownership", async function () {
		this.timeout(15000)
		if (process.platform !== "linux" || !(await native.probeNativeSandbox()).available) this.skip()
		const { manager, command } = executor()
		try {
			const result = await command.execute("echo native-out; echo native-err >&2; exit 7", undefined, options)
			assert.match(String(result[1]), /native-out/)
			assert.match(String(result[1]), /native-err/)
			assert.equal(result[2]?.exitCode, 7)
			const background = await command.execute("sleep 0.2; echo native-late", 0.05, options)
			assert.equal(background[2]?.completed, false)
			await background[2]?.backgroundCompletion
			await delay(100)
			assert.match(await readFile(background[2]!.logFilePath!, "utf8"), /native-late/)
			const running = await command.execute("sleep 30", 0.05, options)
			assert.equal(command.hasActiveBackgroundCommand(), true)
			assert.equal(await command.cancelBackgroundCommand(), true)
			await running[2]?.backgroundCompletion
			assert.equal(command.hasActiveBackgroundCommand(), false)
		} finally { await command.dispose(); await manager.disposeAll() }
	})
})
