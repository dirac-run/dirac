import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import type * as vscode from "vscode"
import type { VscodeTerminalManager } from "../VscodeTerminalManager"
import { CommandExecutor as TaskCommandExecutor } from "@/integrations/terminal/CommandExecutor"
import type { CommandExecutorCallbacks } from "@/integrations/terminal/types"

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => { resolve = r })
	return { promise, resolve }
}

/** Real modules, with only VS Code/telemetry/environment and time boundaries mocked. */
function fixture() {
	const closeListeners = new Set<(terminal: vscode.Terminal) => void>()
	const terminals: any[] = []
	const close = (terminal: any) => {
		terminal.exitStatus = { code: 0 }
		for (const listener of [...closeListeners]) listener(terminal)
	}
	const host = {
		Uri: { file: (fsPath: string) => ({ fsPath }) },
		window: {
			onDidCloseTerminal: (listener: (terminal: vscode.Terminal) => void) => {
				closeListeners.add(listener)
				return { dispose: () => closeListeners.delete(listener) }
			},
			createTerminal: (options: any) => {
				const terminal = {
					options,
					exitStatus: undefined,
					shellIntegration: undefined as any,
					sendText: sinon.spy(),
					show: sinon.spy(),
					dispose: sinon.spy(),
				}
				terminals.push(terminal)
				return terminal
			},
		},
	}
	const load = (path: string, dependencies: Record<string, unknown> = {}) => proxyquire.noCallThru().load(path, {
		vscode: host,
		"@utils/shell": { getShellForProfile: (profile: string) => `/bin/${profile}` },
		"@utils/path": { arePathsEqual: (a: string, b: string) => a === b },
		"@/shared/services/Logger": { Logger: { log() { }, warn() { }, error() { } } },
		...dependencies,
	})
	// timers/promises uses native timer internals; adapt the boundary to Sinon-controlled timers.
	const timers = {
		setTimeout: (ms: number, value: unknown, options?: { signal: AbortSignal }) => new Promise((resolve, reject) => {
			const signal = options?.signal
			if (signal?.aborted) { reject(signal.reason); return }
			const abort = () => { clearTimeout(timer); reject(signal?.reason) }
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", abort)
				resolve(value)
			}, ms)
			signal?.addEventListener("abort", abort, { once: true })
		}),
	}
	const capture = sinon.stub().resolves("fallback snapshot")
	const processModule = load("../VscodeTerminalProcess", {
		"node:timers/promises": timers,
		"@services/telemetry": {
			TerminalOutputFailureReason: { TIMEOUT: "timeout", NO_SHELL_INTEGRATION: "none" },
			telemetryService: { captureTerminalOutputFailure() { }, captureTerminalExecution() { } },
		},
		"@/hosts/vscode/terminal/ansiUtils": { stripAnsi: (data: string) => data },
		"@/hosts/vscode/terminal/get-latest-output": { getLatestTerminalOutput: capture },
	})
	const registryModule = load("../VscodeTerminalRegistry", {
		"@/hosts/vscode/iconUtils": { getDiracIconUri: () => undefined },
	})
	const pythonEnvironment = sinon.stub().resolves({})
	const lifecycleModule = load("../VscodeTerminalLifecycleManager", {
		"node:timers/promises": timers,
		"../python": { getPythonEnvironmentVariables: pythonEnvironment },
		"./VscodeTerminalRegistry": registryModule,
	})
	const profileModule = load("../VscodeTerminalProfileManager", { "./VscodeTerminalRegistry": registryModule })
	const executorModule = load("../VscodeCommandExecutor", {
		"node:timers/promises": timers,
		"./VscodeTerminalProcess": processModule,
	})
	const managerModule = load("../VscodeTerminalManager", {
		"./VscodeTerminalRegistry": registryModule,
		"./VscodeTerminalLifecycleManager": lifecycleModule,
		"./VscodeTerminalProfileManager": profileModule,
		"./VscodeCommandExecutor": executorModule,
		"./VscodeTerminalProcess": processModule,
	})
	const managers: VscodeTerminalManager[] = []
	const manager = () => {
		const result = new managerModule.VscodeTerminalManager() as VscodeTerminalManager
		managers.push(result)
		return result
	}
	const registry = registryModule.TerminalRegistry as typeof import("../VscodeTerminalRegistry").TerminalRegistry
	return { manager, registry, close, terminals, managers, capture, pythonEnvironment, closeListeners, host, processModule }
}

function integration(terminal: any, cwd: string, output = "command output\n") {
	terminal.shellIntegration = {
		cwd: { fsPath: cwd },
		executeCommand: sinon.stub().callsFake(() => ({ read: async function* () { yield output } })),
	}
	return terminal.shellIntegration
}

// This suite does not claim real extension-host verification.
describe("VS Code terminal ownership and cleanup (mocked host)", () => {
	let f: ReturnType<typeof fixture>
	let clock: sinon.SinonFakeTimers

	beforeEach(() => {
		clock = sinon.useFakeTimers()
		f = fixture()
	})

	afterEach(async () => {
		const disposals = f.managers.map((manager) => manager.disposeAll())
		for (const terminal of f.terminals) f.close(terminal)
		await Promise.all(disposals)
		clock.restore()
		sinon.restore()
	})

	it("claims before concurrent CWD waits: root and two siblings never double-claim", async () => {
		const root = f.manager()
		const a = f.manager()
		const b = f.manager()
		const unowned = f.registry.createTerminal("/old")
		const cd = deferred()
		integration(unowned.terminal, "/old").executeCommand.callsFake(() => ({
			read: async function* () {
				await cd.promise
					; (unowned.terminal.shellIntegration as any).cwd.fsPath = "/new"
				yield "changed directory\n"
			},
		}))
		const rootPending = root.getOrCreateTerminal("/new", {})
		const [ta, tb] = await Promise.all([a.getOrCreateTerminal("/new", {}), b.getOrCreateTerminal("/new", {})])
		assert.notEqual(ta.id, tb.id)
		assert.notEqual(ta.id, unowned.id)
		assert.notEqual(tb.id, unowned.id)
		assert.equal(unowned.busy, true)
		assert.equal(root.getTerminals(true)[0].id, unowned.id)
		cd.resolve()
		const tr = await rootPending
		assert.equal(tr.id, unowned.id)
		assert.equal(new Set(f.registry.getAllTerminals().map((t) => t.ownerId)).size, 3)
	})

	it("reserves matching-CWD terminals even for concurrent acquisition by the same manager", async () => {
		const manager = f.manager()
		const available = f.registry.createTerminal("/same")
		integration(available.terminal, "/same")
		const [a, b] = await Promise.all([manager.getOrCreateTerminal("/same", {}), manager.getOrCreateTerminal("/same", {})])
		assert.notEqual(a.id, b.id)
	})

	it("scopes query, profile, close-all and disposal to the owning manager, never a user terminal", async () => {
		const [root, a, b] = [f.manager(), f.manager(), f.manager()]
		const [tr, ta, tb] = await Promise.all([root, a, b].map((m) => m.getOrCreateTerminal("/same", {})))
		for (const info of [tr, ta, tb]) info.busy = false
		const userTerminal = f.host.window.createTerminal({ name: "User" })
		assert.deepEqual(root.getTerminals(false).map((t) => t.id), [tr.id])
		assert.deepEqual(a.filterTerminals(() => true).map((t) => t.id), [ta.id])
		assert.equal(root.setDefaultTerminalProfile("bash").closedCount, 1)
		assert.equal((tr.terminal.dispose as sinon.SinonSpy).callCount, 1)
		assert.equal((ta.terminal.dispose as sinon.SinonSpy).callCount, 0)
		assert.equal((tb.terminal.dispose as sinon.SinonSpy).callCount, 0)
		assert.equal(a.closeAllTerminals(), 1)
		const disposal = b.disposeAll()
		assert.equal(userTerminal.dispose.callCount, 0)
		f.close(tb.terminal)
		await disposal
		assert.equal(f.registry.getTerminal(ta.id), undefined)
	})

	it("tracks and returns the exact emitting process synchronously, including output/hot state", async () => {
		const manager = f.manager()
		const terminal = await manager.getOrCreateTerminal("/same", {})
		const finish = deferred()
		integration(terminal.terminal, "/same").executeCommand.callsFake(() => ({
			read: async function* () { yield "building output\n"; await finish.promise; yield "done\n" },
		}))
		const process = manager.runCommand(terminal, "build")
		assert.equal((manager as any).processes.get(terminal.id), process)
		assert.equal(typeof process.on, "function")
		assert.equal(typeof process.then, "function")
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		await clock.tickAsync(0)
		assert.ok(lines.includes("building output"))
		assert.equal(manager.isProcessHot(terminal.id), true)
		process.continue()
		await process
		assert.equal(terminal.busy, true)
		const completed = new Promise<void>((resolve) => process.once("completed", () => resolve()))
		finish.resolve()
		await completed
		assert.equal(terminal.busy, false)
		assert.ok(manager.getUnretrievedOutput(terminal.id).includes("done"))
	})

	it("rejects cross-owner runs and preserves siblings during forced busy close", async () => {
		const a = f.manager()
		const b = f.manager()
		const ta = await a.getOrCreateTerminal("/a", {})
		const tb = await b.getOrCreateTerminal("/b", {})
		assert.throws(() => b.runCommand(ta, "bad"), /not owned/)
		const process = a.runCommand(ta, "delayed")
		assert.equal(a.closeTerminals(() => true), 0)
		assert.equal(a.closeTerminals(() => true, true), 1)
		await clock.tickAsync(5000)
		assert.equal((ta.terminal.sendText as sinon.SinonSpy).callCount, 0)
		assert.equal((tb.terminal.dispose as sinon.SinonSpy).callCount, 0)
		f.close(ta.terminal)
		await process
	})

	it("retires a terminated shell before the host acknowledges closure", async () => {
		const manager = f.manager()
		const sibling = f.manager()
		const terminal = await manager.getOrCreateTerminal("/same", {})
		const siblingTerminal = await sibling.getOrCreateTerminal("/same", {})
		integration(terminal.terminal, "/same")
		const process = manager.runCommand(terminal, "cancel before startup")
		await process.terminate!()
		await process
		assert.equal(f.registry.getTerminal(terminal.id), undefined)
		assert.equal((terminal.terminal as unknown as vscode.Terminal).exitStatus, undefined)
		const next = await manager.getOrCreateTerminal("/same", {})
		assert.notEqual(next.id, terminal.id)
		assert.equal((terminal.terminal.dispose as sinon.SinonSpy).callCount, 1)
		assert.equal((siblingTerminal.terminal.dispose as sinon.SinonSpy).callCount, 0)
		assert.equal(f.closeListeners.size, 0)
	})

	for (const failure of ["startup", "stream"] as const) {
		it(`finalizes local state and rejects on ${failure} failure`, async () => {
			const manager = f.manager()
			const terminal = await manager.getOrCreateTerminal("/same", {})
			const shell = integration(terminal.terminal, "/same")
			const error = new Error(`${failure} failed`)
			if (failure === "startup") shell.executeCommand.throws(error)
			else shell.executeCommand.returns({ read: async function* () { yield "building output\n"; throw error } })
			const process = manager.runCommand(terminal, "fails")
			const rejected = assert.rejects(process, (caught) => caught === error)
			await clock.tickAsync(0)
			await rejected
			assert.equal(terminal.busy, false)
			assert.equal(process.isHot, false)
			assert.equal(f.closeListeners.size, 0)
			assert.equal(f.registry.getTerminal(terminal.id), undefined)
			assert.equal((terminal.terminal.dispose as sinon.SinonSpy).callCount, 1)
			assert.equal(clock.countTimers(), 0)
			const next = await manager.getOrCreateTerminal("/same", {})
			integration(next.terminal, "/same")
			await manager.runCommand(next, "works")
		})
	}

	it("releases an abandoned acquisition reservation without affecting sibling ownership", async () => {
		const manager = f.manager()
		const sibling = f.manager()
		const terminal = await manager.getOrCreateTerminal("/same", {})
		const other = await sibling.getOrCreateTerminal("/same", {})
		integration(terminal.terminal, "/same")
		assert.equal(terminal.busy, true)
		assert.throws(() => sibling.releaseTerminalReservation(terminal), /not owned/)
		manager.releaseTerminalReservation(terminal)
		assert.equal(terminal.busy, false)
		assert.equal(other.busy, true)
		assert.equal((await manager.getOrCreateTerminal("/same", {})).id, terminal.id)
	})

	it("returns a real reserved terminal to reuse when command cancellation wins acquisition", async () => {
		const manager = f.manager()
		const terminal = await manager.getOrCreateTerminal("/same", {})
		integration(terminal.terminal, "/same")
		const acquisition = deferred<typeof terminal>()
		const entered = deferred()
		const getOrCreate = sinon.stub(manager, "getOrCreateTerminal").callsFake(() => {
			entered.resolve()
			return acquisition.promise
		})
		const executor = new TaskCommandExecutor({
			cwd: "/same", taskId: "task", ulid: "ulid", terminalExecutionMode: "vscodeTerminal", terminalManager: manager,
		}, {
			taskMessenger: {}, updateBackgroundCommandState() { }, updateDiracMessage: async () => { },
			getDiracMessages: () => [], addToUserMessageContent() { }, getEnvironmentVariables: async () => ({}),
		} as unknown as CommandExecutorCallbacks)
		const execution = executor.execute("never starts", undefined)
		await entered.promise
		await executor.cancelBackgroundCommand()
		acquisition.resolve(terminal)
		assert.equal((await execution)[0], true)
		assert.equal(terminal.busy, false)
		assert.equal((terminal.terminal.show as sinon.SinonSpy).callCount, 0)
		getOrCreate.restore()
		assert.equal((await manager.getOrCreateTerminal("/same", {})).id, terminal.id)
		await executor.dispose()
	})

	it("rejects acquisition delayed in Python environment resolution after disposal", async () => {
		const manager = f.manager()
		const environment = deferred<Record<string, string>>()
		f.pythonEnvironment.returns(environment.promise)
		const acquisition = manager.getOrCreateTerminal("/late")
		await manager.disposeAll()
		environment.resolve({})
		await assert.rejects(acquisition, /abort/i)
		assert.equal(f.terminals.length, 0)
	})

	it("cancels CWD acquisition without waiting for host closure or a stalled runner", async () => {
		const manager = f.manager()
		const terminal = f.registry.createTerminal("/old")
		const stream = deferred()
		integration(terminal.terminal, "/old").executeCommand.callsFake(() => ({
			read: async function* () { await stream.promise; yield "late output\n" },
		}))
		const acquisition = manager.getOrCreateTerminal("/new", {})
		const rejected = assert.rejects(acquisition, /abort/i)
		await clock.tickAsync(0)
		const process = (manager as any).processes.get(terminal.id)
		const lines = sinon.spy()
		process.on("line", lines)
		manager.disposeAll()
		await rejected
		assert.equal(process.hasCompleted, true)
		stream.resolve()
		await clock.tickAsync(0)
		assert.equal(lines.callCount, 0)
	})

	it("cancels fallback delay without late clipboard work or output", async () => {
		const manager = f.manager()
		const terminal = await manager.getOrCreateTerminal("/same", {})
		manager.setShellIntegrationTimeout(0)
		const process = manager.runCommand(terminal, "server")
		await clock.tickAsync(1)
		assert.equal((terminal.terminal.sendText as sinon.SinonSpy).callCount, 1)
		const disposal = manager.disposeAll()
		await clock.tickAsync(5000)
		assert.equal(f.capture.callCount, 0)
		f.close(terminal.terminal)
		await disposal
		await process
	})

	it("keeps fallback terminals owned for cleanup but excludes them from reuse", async () => {
		const manager = f.manager()
		manager.setShellIntegrationTimeout(0)
		const terminal = await manager.getOrCreateTerminal("/same", {})
		const process = manager.runCommand(terminal, "server")
		await clock.tickAsync(3000)
		await process
		assert.equal(terminal.busy, false)
		assert.equal(f.registry.getTerminal(terminal.id)?.reuseDisabled, true)
		// Even later shell integration cannot establish completion of the fallback command.
		integration(terminal.terminal, "/same")
		const next = await manager.getOrCreateTerminal("/same", {})
		assert.notEqual(next.id, terminal.id)
		assert.ok(manager.getTerminals(false).some((info) => info.id === terminal.id))
		manager.disposeAll()
		sinon.assert.calledOnce(terminal.terminal.dispose as sinon.SinonSpy)
		sinon.assert.calledOnce(next.terminal.dispose as sinon.SinonSpy)
	})

	it("uses a fresh terminal when an internal CWD command falls back", async () => {
		const manager = f.manager()
		manager.setShellIntegrationTimeout(0)
		const candidate = f.registry.createTerminal("/old")
		const acquisition = manager.getOrCreateTerminal("/new", {})
		await clock.tickAsync(3000)
		const terminal = await acquisition
		assert.notEqual(terminal.id, candidate.id)
		assert.equal(candidate.reuseDisabled, true)
		assert.equal(candidate.busy, false)
		assert.equal((terminal.terminal as any).options.cwd, "/new")
		const process = manager.runCommand(terminal, "requested command")
		await clock.tickAsync(3000)
		await process
		sinon.assert.calledOnceWithExactly(candidate.terminal.sendText as sinon.SinonSpy, 'cd "/new"', true)
		sinon.assert.calledOnceWithExactly(terminal.terminal.sendText as sinon.SinonSpy, "requested command", true)
		manager.disposeAll()
		sinon.assert.calledOnce(candidate.terminal.dispose as sinon.SinonSpy)
	})

	it("bounds output", async () => {
		const manager = f.manager()
		manager.setTerminalReuseEnabled(false)
		manager.setTerminalOutputLineLimit(4)
		assert.equal(manager.processOutput(["0", "1", "2", "3", "4", "5"]), "0\n1\n... (output truncated) ...\n4\n5")
		assert.equal(manager.processOutput(["a", "b"]), "a\nb")
	})
})
