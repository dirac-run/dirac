import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import type { FSWatcher } from "chokidar"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as cwdModule from "@/utils/path"
import { type FileContextStateStore, FileContextTracker } from "./FileContextTracker"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((complete) => { resolve = complete })
	return { promise, resolve }
}

describe("FileContextTracker watcher ownership", () => {
	afterEach(() => sinon.restore())

	function createTracker() {
		const watcher = Object.assign(new EventEmitter(), { close: sinon.stub().resolves() })
		const factory = sinon.stub().returns(watcher as unknown as FSWatcher)
		const tracker = new FileContextTracker({} as FileContextStateStore, "1700000000000", factory)
		return { tracker, watcher, factory }
	}

	it("disposes without joining pending setup and prevents late watcher creation", async () => {
		const gate = deferred<string>()
		const entered = deferred<void>()
		const cwd = sinon.stub(cwdModule, "getCwd").callsFake(() => {
			entered.resolve()
			return gate.promise
		})
		const { tracker, factory } = createTracker()
		const setup = tracker.setupFileWatcher("pending.ts")
		await entered.promise
		try {
			await tracker.dispose()
		} finally {
			gate.resolve("/workspace")
		}
		await setup
		await tracker.setupFileWatcher("late.ts")
		await tracker.trackFileContext("late.ts", "read_tool")
		assert.equal(factory.callCount, 0)
		assert.equal(cwd.callCount, 1)
	})

	it("closes only its watchers and ignores detached watcher events", async () => {
		sinon.stub(cwdModule, "getCwd").resolves("/workspace")
		const executions = [createTracker(), createTracker(), createTracker()]
		await Promise.all(executions.map(({ tracker }) => tracker.setupFileWatcher("shared.ts")))
		const tracking = executions.map(({ tracker }) => sinon.stub(tracker, "trackFileContext").resolves())
		try {
			await executions[1].tracker.dispose()
			for (const { watcher } of executions) watcher.emit("change")
			assert.deepEqual(tracking.map((track) => track.callCount), [1, 0, 1])
			assert.deepEqual(executions.map(({ watcher }) => watcher.close.callCount), [0, 1, 0])
		} finally {
			await Promise.all(executions.map(({ tracker }) => tracker.dispose()))
		}
	})

	it("does not create duplicate watchers when setups overlap", async () => {
		const gate = deferred<string>()
		sinon.stub(cwdModule, "getCwd").returns(gate.promise)
		const { tracker, factory, watcher } = createTracker()
		const setups = [tracker.setupFileWatcher("same.ts"), tracker.setupFileWatcher("same.ts")]
		gate.resolve("/workspace")
		await Promise.all(setups)
		assert.equal(factory.callCount, 1)
		await tracker.dispose()
		assert.equal(watcher.close.callCount, 1)
	})
})
