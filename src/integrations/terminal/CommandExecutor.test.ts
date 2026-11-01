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
