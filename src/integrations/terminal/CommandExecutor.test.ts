import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "mocha"
import * as sinon from "sinon"
import { CommandExecutor } from "./CommandExecutor"
import type { CommandExecutorCallbacks, ITerminalManager } from "./types"

describe("CommandExecutor cancellation", () => {
	it("waits for foreground process termination before reporting cancellation", async () => {
		const clock = sinon.useFakeTimers()
		try {
			let finishTermination!: () => void
			const termination = new Promise<void>((resolve) => {
				finishTermination = resolve
			})
			const terminate = sinon.stub().returns(termination)
			const executor = new CommandExecutor(
				{
					cwd: "/tmp",
					taskId: "task",
					ulid: "ulid",
					terminalExecutionMode: "vscodeTerminal",
					terminalManager: {} as ITerminalManager,
				},
				createCallbacks(),
			)
				; (executor as any).currentProcess = { terminate }

			let cancellationSettled = false
			const cancellation = executor.cancelBackgroundCommand().then((result) => {
				cancellationSettled = true
				return result
			})

			await clock.tickAsync(300)
			assert.equal(cancellationSettled, false)

			finishTermination()
			await clock.tickAsync(300)

			assert.equal(await cancellation, true)
			assert.equal(terminate.callCount, 1)
		} finally {
			clock.restore()
		}
	})
})

describe("CommandExecutor ownership", () => {
	function createExecutor(manager: ITerminalManager, callbacks = createCallbacks()) {
		return new CommandExecutor({ cwd: process.cwd(), taskId: "task", ulid: "ulid", terminalExecutionMode: "vscodeTerminal", terminalManager: manager }, callbacks)
	}

	it("disposes without waiting for environment acquisition and prevents late command startup", async () => {
		let release!: (env: undefined) => void
		const callbacks = createCallbacks()
		callbacks.getEnvironmentVariables = () => new Promise((resolve) => { release = resolve })
		callbacks.getDiracMessages = sinon.stub().returns([])
		const getOrCreateTerminal = sinon.stub()
		const executor = createExecutor({ getOrCreateTerminal } as unknown as ITerminalManager, callbacks)
		const execution = executor.execute("echo never", undefined)
		const disposal = executor.dispose()
		assert.equal(executor.dispose(), disposal)
		await disposal
		release(undefined)
		assert.equal((await execution)[0], true)
		assert.equal(getOrCreateTerminal.callCount, 0)
		assert.equal((callbacks.getDiracMessages as sinon.SinonStub).callCount, 0)
		await assert.rejects(executor.execute("echo late", undefined), /disposed/)
	})

	it("cancels pending terminal acquisition and remains reusable", async () => {
		let release!: (terminal: any) => void
		let entered!: () => void
		const acquired = new Promise<void>((resolve) => { entered = resolve })
		const terminal = { busy: true, terminal: { show: sinon.stub() } }
		const runCommand = sinon.stub()
		const releaseTerminalReservation = sinon.spy((reservation: typeof terminal) => { reservation.busy = false })
		const getOrCreateTerminal = () => { entered(); return new Promise<any>((resolve) => { release = resolve }) }
		const executor = createExecutor({ getOrCreateTerminal, runCommand, releaseTerminalReservation } as unknown as ITerminalManager)
		const execution = executor.execute("echo never", undefined)
		await acquired
		const cancellation = executor.cancelBackgroundCommand()
		assert.equal(executor.cancelBackgroundCommand(), cancellation)
		assert.equal(await cancellation, true)
		release(terminal)
		assert.equal((await execution)[0], true)
		assert.equal(terminal.busy, false)
		sinon.assert.calledOnceWithExactly(releaseTerminalReservation, terminal)
		assert.equal(runCommand.callCount, 0)
		assert.equal(terminal.terminal.show.callCount, 0)
		const next = executor.execute("echo next", undefined)
		await Promise.resolve()
		const secondCancellation = executor.cancelBackgroundCommand()
		release(terminal)
		assert.equal((await next)[0], true)
		assert.equal(await secondCancellation, true)
		await executor.dispose()
	})

	for (const failure of ["show", "run"] as const) {
		it(`releases a terminal reservation when ${failure} throws before startup`, async () => {
			const error = new Error("startup failed")
			const terminal = { busy: true, terminal: { show: () => { if (failure === "show") throw error } } }
			const releaseTerminalReservation = sinon.spy((reservation: typeof terminal) => { reservation.busy = false })
			const manager = {
				getOrCreateTerminal: async () => terminal,
				runCommand: () => { throw error },
				releaseTerminalReservation,
			} as unknown as ITerminalManager
			const executor = createExecutor(manager)
			await assert.rejects(executor.execute("never starts", undefined), error)
			sinon.assert.calledOnceWithExactly(releaseTerminalReservation, terminal)
			assert.equal(terminal.busy, false)
			await executor.dispose()
		})
	}

	for (const restriction of ["denied", "configuration changed", "aborted"]) {
		it(`rechecks authority after deferred terminal acquisition when ${restriction}`, async () => {
			let acquired!: () => void
			const acquisition = new Promise<void>((resolve) => { acquired = resolve })
			const terminal = { busy: true, terminal: { show() { } } }
			let release!: (value: typeof terminal) => void
			const reservation = new Promise<typeof terminal>((resolve) => { release = resolve })
			let authorized = true
			const assertAuthorized = sinon.spy(() => { if (!authorized) throw new Error(restriction) })
			const runCommand = sinon.stub()
			const releaseTerminalReservation = sinon.spy((value: typeof terminal) => { value.busy = false })
			const executor = createExecutor({
				getOrCreateTerminal: () => { acquired(); return reservation },
				runCommand,
				releaseTerminalReservation,
			} as unknown as ITerminalManager)
			const execution = executor.execute("must not spawn", undefined, { cwd: "/approved", assertAuthorized })
			await acquisition
			sinon.assert.notCalled(assertAuthorized)
			authorized = false
			release(terminal)
			await assert.rejects(execution, new RegExp(restriction))
			sinon.assert.calledOnce(assertAuthorized)
			sinon.assert.notCalled(runCommand)
			sinon.assert.calledOnceWithExactly(releaseTerminalReservation, terminal)
			assert.equal(terminal.busy, false)
			await executor.dispose()
		})
	}

	it("does not let older completion clear the newer foreground process", async () => {
		const processes: any[] = []
		const manager = {
			getOrCreateTerminal: async () => ({ terminal: { show() { } } }),
			processOutput: (lines: string[]) => lines.join("\n"),
			runCommand: () => {
				const emitter = new EventEmitter()
				let finish!: () => void
				const promise = new Promise<void>((resolve) => { finish = resolve })
				const command = Object.assign(emitter, {
					then: promise.then.bind(promise), catch: promise.catch.bind(promise), finally: promise.finally.bind(promise),
					terminate: async () => { emitter.emit("completed", { exitCode: 0 }); finish() },
				})
				processes.push(command)
				return command
			},
		} as unknown as ITerminalManager
		const executor = createExecutor(manager)
		const first = executor.execute("first", undefined, { suppressUserInteraction: true })
		const second = executor.execute("second", undefined, { suppressUserInteraction: true })
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(processes.length, 2)
		await processes[0].terminate()
		assert.equal((executor as any).currentProcess, processes[1])
		await processes[1].terminate()
		await Promise.all([first, second])
		await executor.dispose()
	})

	it("disposes its hidden standalone pool even when foreground termination fails, not the borrowed manager", async () => {
		const primaryDispose = sinon.stub().resolves()
		const executor = createExecutor({ disposeAll: primaryDispose } as unknown as ITerminalManager)
		const hiddenDispose = sinon.stub((executor as any).standaloneManager, "disposeAll").resolves()
			; (executor as any).currentProcess = { terminate: async () => { throw new Error("cannot terminate") } }
		await assert.rejects(executor.dispose(), /cleanup failed/)
		assert.equal(hiddenDispose.callCount, 1)
		assert.equal(primaryDispose.callCount, 0)
	})


	it("terminates a real hidden foreground process under VSCode mode", async function () {
		if (process.platform === "win32") this.skip()
		this.timeout(10000)
		const callbacks = createCallbacks()
		callbacks.getDiracMessages = sinon.stub().returns([])
		const executor = createExecutor({} as ITerminalManager, callbacks)
		const hidden = (executor as any).standaloneManager
		const run = hidden.runCommand.bind(hidden)
		let ready!: () => void
		let pid = 0
		const readiness = new Promise<void>((resolve) => { ready = resolve })
		hidden.runCommand = (...args: unknown[]) => {
			const command = run(...args)
			command.on("line", (line: string) => { if (/^\d+$/.test(line)) { pid = Number(line); ready() } })
			return command
		}
		const execution = executor.execute(`exec '${process.execPath}' -e 'console.log(process.pid); setInterval(()=>{},1000)'`, undefined, { useBackgroundExecution: true, suppressUserInteraction: true })
		try {
			await readiness
			assert.ok(pid > 0)
			await executor.dispose()
			await execution
			assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH")
			assert.equal((callbacks.getDiracMessages as sinon.SinonStub).callCount, 0)
		} finally {
			await executor.dispose()
		}
	})
})

describe("CommandExecutor working directory", () => {
	it("uses each frozen cwd for concurrent standalone executions and preserves the task default", async function () {
		if (process.platform === "win32") this.skip()
		this.timeout(10000)
		const fs = await import("node:fs/promises")
		const os = await import("node:os")
		const path = await import("node:path")
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-cwd-"))
		const first = path.join(base, 'first " $(not-a-command)')
		const second = path.join(base, "second workspace")
		await Promise.all([fs.mkdir(first), fs.mkdir(second)])
		const callbacks = createCallbacks()
		const environment = sinon.stub().resolves(undefined)
		callbacks.getEnvironmentVariables = environment
		const executor = new CommandExecutor({ cwd: base, taskId: "task", ulid: "ulid", terminalExecutionMode: "vscodeTerminal", terminalManager: {} as ITerminalManager }, callbacks)
		const command = `"${process.execPath}" -e 'console.log(process.cwd())'`
		const options = { useBackgroundExecution: true, suppressUserInteraction: true }
		try {
			// Seed a reusable terminal, then acquire different directories concurrently.
			await executor.execute(command, undefined, options)
			const results = await Promise.all([first, second].map((cwd) => executor.execute(command, undefined, { ...options, cwd })))
			assert.ok(String(results[0][1]).includes(first))
			assert.ok(String(results[1][1]).includes(second))
			assert.equal(results[0][2]?.exitCode, 0)
			assert.equal(results[1][2]?.exitCode, 0)
			assert.ok(String((await executor.execute(command, undefined, options))[1]).includes(base))
			assert.deepEqual(environment.getCalls().map((call) => call.args[0]), [base, first, second, base])
		} finally {
			await executor.dispose()
			await fs.rm(base, { recursive: true, force: true })
		}
	})
})

function createCallbacks(): CommandExecutorCallbacks {
	return {
		taskMessenger: {} as any,
		updateBackgroundCommandState: () => { },
		updateDiracMessage: async () => { },
		getDiracMessages: () => [],
		addToUserMessageContent: () => { },
		getEnvironmentVariables: async () => undefined,
	}
}
