import type { AgentSideConnection, TerminalHandle } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AcpTerminalManager } from "./AcpTerminalManager.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => { resolve = res })
	return { promise, resolve }
}

function terminalHandle(id = "terminal-1") {
	return {
		id,
		currentOutput: vi.fn().mockResolvedValue({ output: "", truncated: false }),
		waitForExit: vi.fn(() => new Promise<never>(() => { })),
		kill: vi.fn().mockResolvedValue({}),
		release: vi.fn().mockResolvedValue({}),
	}
}

function setup(createTerminal = vi.fn().mockResolvedValue(terminalHandle())) {
	return new AcpTerminalManager(
		{ createTerminal } as unknown as AgentSideConnection,
		{ terminal: true },
		() => "session-1",
	)
}

async function start(manager: AcpTerminalManager) {
	const info = await manager.getOrCreateTerminal("/workspace")
	const process = manager.runCommand(info, "sleep 60")
	await vi.advanceTimersByTimeAsync(0)
	return { info, process }
}

describe("AcpTerminalManager local cancellation", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
	})

	it("stops locally without awaiting stalled kill or release acknowledgements", async () => {
		const handle = terminalHandle()
		handle.kill.mockReturnValue(new Promise(() => { }))
		handle.release.mockReturnValue(new Promise(() => { }))
		const manager = setup(vi.fn().mockResolvedValue(handle))
		const { info, process } = await start(manager)
		await process.terminate!()
		await process
		expect(info.busy).toBe(false)
		manager.disposeAll()
		expect(handle.kill).toHaveBeenCalledOnce()
		expect(handle.release).toHaveBeenCalledOnce()
	})

	it("disposes immediately and releases a late host acquisition without publishing it", async () => {
		const creation = deferred<TerminalHandle>()
		const handle = terminalHandle()
		const manager = setup(vi.fn().mockReturnValue(creation.promise))
		const { process } = await start(manager)
		manager.disposeAll()
		await process
		creation.resolve(handle as unknown as TerminalHandle)
		await vi.advanceTimersByTimeAsync(0)
		expect(handle.kill).toHaveBeenCalledOnce()
		expect(handle.release).toHaveBeenCalledOnce()
		expect(handle.currentOutput).not.toHaveBeenCalled()
		expect(manager.getActiveTerminalCount()).toBe(0)
		await expect(manager.getOrCreateTerminal("/workspace")).rejects.toThrow("disposed")
	})

	for (const staleFirst of [true, false]) {
		it(`does not publish a cancelled acquisition over its reused slot (stale first: ${staleFirst})`, async () => {
			const first = deferred<TerminalHandle>()
			const second = deferred<TerminalHandle>()
			const oldHandle = terminalHandle("old")
			const newHandle = terminalHandle("new")
			const manager = setup(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))
			const a = await start(manager)
			await a.process.terminate!()
			await a.process
			const b = await start(manager)
			expect(b.info).toBe(a.info)
			const finishOld = async () => {
				first.resolve(oldHandle as unknown as TerminalHandle)
				await vi.advanceTimersByTimeAsync(0)
			}
			const finishNew = async () => {
				second.resolve(newHandle as unknown as TerminalHandle)
				await vi.advanceTimersByTimeAsync(0)
			}
			if (staleFirst) { await finishOld(); await finishNew() }
			else { await finishNew(); await finishOld() }
			expect(oldHandle.kill).toHaveBeenCalledOnce()
			expect(oldHandle.release).toHaveBeenCalledOnce()
			expect(oldHandle.currentOutput).not.toHaveBeenCalled()
			expect(b.info.busy).toBe(true)
			expect((await manager.getOutput("new")).success).toBe(true)
			expect(newHandle.release).not.toHaveBeenCalled()
			manager.disposeAll()
			await b.process
			expect(newHandle.kill).toHaveBeenCalledOnce()
			expect(newHandle.release).toHaveBeenCalledOnce()
		})
	}

	for (const cancelled of [true, false]) {
		it(`releases an installed handle on reuse without awaiting the host (cancelled: ${cancelled})`, async () => {
			const oldHandle = terminalHandle("old")
			const newHandle = terminalHandle("new")
			oldHandle.release.mockReturnValue(new Promise(() => { }))
			const manager = setup(vi.fn().mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(newHandle))
			const a = await start(manager)
			if (cancelled) await a.process.terminate!()
			else {
				oldHandle.currentOutput.mockResolvedValue({ output: "", truncated: false, exitStatus: { exitCode: 0 } })
				await vi.advanceTimersByTimeAsync(100)
			}
			await a.process
			const b = await start(manager)
			expect(b.info).toBe(a.info)
			expect(oldHandle.release).toHaveBeenCalledOnce()
			expect((await manager.getOutput("new")).success).toBe(true)
			manager.disposeAll()
			await b.process
			expect(oldHandle.release).toHaveBeenCalledOnce()
			expect(newHandle.release).toHaveBeenCalledOnce()
		})
	}

	it("does not apply an older handle's release acknowledgement to its replacement", async () => {
		const oldHandle = terminalHandle("old")
		const newHandle = terminalHandle("new")
		const released = deferred<{}>()
		oldHandle.release.mockReturnValue(released.promise)
		const manager = setup(vi.fn().mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(newHandle))
		const a = await start(manager)
		await a.process.terminate!()
		const oldRelease = manager.release("old")
		const b = await start(manager)
		released.resolve({})
		await oldRelease
		expect(manager.getTerminal("new")?.released).toBe(false)
		expect((await manager.getOutput("new")).success).toBe(true)
		expect(oldHandle.release).toHaveBeenCalledOnce()
		manager.disposeAll()
		await b.process
		expect(newHandle.release).toHaveBeenCalledOnce()
	})

	it("ignores output and exit replies arriving after termination", async () => {
		const output = deferred<{ output: string; truncated: boolean }>()
		const exit = deferred<{ exitCode: number }>()
		const handle = terminalHandle()
		handle.currentOutput.mockReturnValue(output.promise)
		handle.waitForExit.mockImplementation(() => exit.promise as Promise<never>)
		const manager = setup(vi.fn().mockResolvedValue(handle))
		const { process } = await start(manager)
		const line = vi.fn()
		process.on("line", line)
		await vi.advanceTimersByTimeAsync(100)
		await process.terminate!()
		output.resolve({ output: "late output\n", truncated: false })
		exit.resolve({ exitCode: 0 })
		await vi.advanceTimersByTimeAsync(1000)
		expect(line).not.toHaveBeenCalled()
		expect(process.isHot).toBe(false)
		manager.disposeAll()
	})
})
