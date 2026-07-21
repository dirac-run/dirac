import { afterEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { SymbolIndexRuntime } from "../SymbolIndexRuntime"

describe("SymbolIndexRuntime", () => {
	let runtime: SymbolIndexRuntime | null = null
	let clock: sinon.SinonFakeTimers | null = null

	afterEach(async () => {
		await runtime?.dispose()
		clock?.restore()
		runtime = null
		clock = null
		sinon.restore()
	})

	it("batches supported watcher mutations into one callback", async () => {
		clock = sinon.useFakeTimers()
		const applyWatcherEvents = sinon.stub().resolves()
		runtime = createRuntime({ applyWatcherEvents })

		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "upsert")
		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "upsert")
		;(runtime as any).queueFileEvent("/workspace/src/b.ts", "remove")
		await clock.tickAsync(1_000)

		sinon.assert.calledOnce(applyWatcherEvents)
		applyWatcherEvents.firstCall.args[0].should.deepEqual([
			{ absolutePath: "/workspace/src/a.ts", kind: "upsert" },
			{ absolutePath: "/workspace/src/b.ts", kind: "remove" },
		])
	})

	it("requests reconciliation when pending watcher events overflow", () => {
		clock = sinon.useFakeTimers()
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })

		for (let index = 0; index <= 500; index++) {
			;(runtime as any).queueFileEvent(`/workspace/src/${index}.ts`, "upsert")
		}

		sinon.assert.calledOnceWithExactly(requestReconciliation, "watcher event overflow")
	})

	it("requests reconciliation when the filesystem watcher reports an error", () => {
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })

		;(runtime as any).watcher.emit("error", new Error("injected watcher failure"))

		requestReconciliation.calledOnce.should.be.true()
		requestReconciliation.firstCall.args[0].should.match(/watcher error/)
	})

	it("treats nested ignore and Git control changes as reconciliation requests", () => {
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })
		;(runtime as any).gitDirectory = "/workspace/.git"

		;(runtime as any).queueFileEvent("/workspace/src/.gitignore", "upsert")
		;(runtime as any).queueFileEvent("/workspace/.git/index", "upsert")

		requestReconciliation.callCount.should.equal(2)
	})

	it("watches the supplied source directories and Git control directories", async () => {
		runtime = createRuntime()
		const watcher = (runtime as any).watcher
		const add = sinon.stub(watcher, "add").returns(watcher)

		await runtime.refreshWatchedDirectories(new Set(["src", "src/ignored-only"]), "/workspace/.git")

		const added = new Set(add.firstCall.args[0] as string[])
		added.should.deepEqual(
			new Set(["/workspace", "/workspace/src", "/workspace/src/ignored-only", "/workspace/.git", "/workspace/.git/info"]),
		)
	})

	it("drains events queued while a watcher batch is active without overlapping callbacks", async () => {
		clock = sinon.useFakeTimers()
		let releaseFirst!: () => void
		const firstBatchBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const applyWatcherEvents = sinon.stub()
		applyWatcherEvents.onFirstCall().returns(firstBatchBlocked)
		applyWatcherEvents.onSecondCall().resolves()
		runtime = createRuntime({ applyWatcherEvents })

		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "upsert")
		await clock.tickAsync(1_000)
		;(runtime as any).queueFileEvent("/workspace/src/b.ts", "upsert")
		await clock.tickAsync(1_000)
		applyWatcherEvents.callCount.should.equal(1)

		releaseFirst()
		await (runtime as any).activeFlush
		applyWatcherEvents.callCount.should.equal(2)
		applyWatcherEvents.secondCall.args[0].should.deepEqual([{ absolutePath: "/workspace/src/b.ts", kind: "upsert" }])
	})

	it("logs rejected reconciliation requests instead of leaking unhandled rejections", async () => {
		const requestReconciliation = sinon.stub().rejects(new Error("injected reconciliation failure"))
		const error = sinon.stub(Logger, "error")
		runtime = createRuntime({ requestReconciliation })

		;(runtime as any).requestFullReconciliation("test failure")
		await new Promise((resolve) => setImmediate(resolve))

		error.calledOnce.should.be.true()
		error.firstCall.args[0].should.match(/test failure/)
	})

	it("runs a non-blocking jittered repair timer and disposes it", async () => {
		clock = sinon.useFakeTimers()
		sinon.stub(Math, "random").returns(0.5)
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })
		;(runtime as any).reconciliationTimer.hasRef().should.be.false()

		await clock.tickAsync(5 * 60_000)
		sinon.assert.calledOnceWithExactly(requestReconciliation, "periodic repair")
		await runtime.dispose()
		runtime = null
		await clock.tickAsync(10 * 60_000)
		requestReconciliation.callCount.should.equal(1)
	})

	function createRuntime(overrides: Partial<ConstructorParameters<typeof SymbolIndexRuntime>[1]> = {}): SymbolIndexRuntime {
		return new SymbolIndexRuntime("/workspace", {
			admitsPath: () => true,
			applyWatcherEvents: async () => {},
			requestReconciliation: async () => {},
			...overrides,
		})
	}
})
