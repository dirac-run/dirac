import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import type { FSWatcher } from "chokidar"
import { describe, it } from "mocha"
import sinon from "sinon"
import { IgnoreFileWatcher } from "./IgnoreFileWatcher"

function createWatcher() {
	const close = sinon.stub<[], Promise<void>>().resolves()
	const watcher = Object.assign(new EventEmitter(), { close })
	const factory = sinon.stub().returns(watcher as unknown as FSWatcher)
	const resource = new IgnoreFileWatcher("/workspace", factory)
	return { resource, watcher, close, factory }
}

describe("IgnoreFileWatcher ownership", () => {
	it("does not join reloads or stop sibling watchers on disposal", async () => {
		const executions = [createWatcher(), createWatcher(), createWatcher()]
		let release!: () => void
		const reload = new Promise<void>((resolve) => { release = resolve })
		const reloads = [sinon.stub().resolves(), sinon.stub().returns(reload), sinon.stub().resolves()]
		await Promise.all(executions.map(({ resource }, index) => resource.start(reloads[index])))
		try {
			const { resource, watcher, factory } = executions[1]
			watcher.emit("change")
			await resource.dispose()
			for (const { watcher } of executions) watcher.emit("change")
			assert.deepEqual(reloads.map((callback) => callback.callCount), [1, 1, 1])
			assert.deepEqual(executions.map(({ close }) => close.callCount), [0, 1, 0])
			await resource.start(reloads[1])
			assert.equal(factory.callCount, 1)
		} finally {
			release()
			await Promise.all(executions.map(({ resource }) => resource.dispose()))
		}
	})

	it("does not recreate a watcher when disposal interrupts startup", async () => {
		const { resource, factory } = createWatcher()
		const startup = resource.start(() => undefined)
		await resource.dispose()
		await startup
		assert.equal(factory.callCount, 0)
	})

	it("does not leak a second watcher when starts overlap", async () => {
		const { resource, factory, close } = createWatcher()
		await Promise.all([resource.start(() => undefined), resource.start(() => undefined)])
		assert.equal(factory.callCount, 1)
		await resource.dispose()
		assert.equal(close.callCount, 1)
	})
})
