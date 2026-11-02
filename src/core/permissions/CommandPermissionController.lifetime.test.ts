import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { FSWatcher } from "chokidar"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CommandPermissionController } from "./CommandPermissionController"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => { resolve = complete })
	return { promise, resolve }
}

describe("CommandPermissionController watcher ownership", () => {
	afterEach(() => sinon.restore())

	function createController() {
		const watchers: Array<EventEmitter & { close: sinon.SinonStub }> = []
		const factory = sinon.stub().callsFake(() => {
			const watcher = Object.assign(new EventEmitter(), { close: sinon.stub().resolves() })
			watchers.push(watcher)
			return watcher as unknown as FSWatcher
		})
		const controller = new CommandPermissionController(factory)
		const load = sinon.stub(controller as unknown as { loadConfig(): Promise<void> }, "loadConfig").resolves()
		return { controller, watchers, factory, load }
	}

	it("revises authority after file reload and persisted rule changes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-permission-revision-"))
		const watcher = Object.assign(new EventEmitter(), { close: sinon.stub().resolves() })
		const controller = new CommandPermissionController(() => watcher as unknown as FSWatcher)
		try {
			assert.equal(controller.revision, 0)
			await controller.initialize(directory)
			const initialized = controller.revision
			assert.ok(initialized > 0)
			await controller.saveConfig({ rules: [{ tool: "execute_command", pattern: "echo hi", action: "deny" }] })
			assert.ok(controller.revision > initialized)
			assert.equal(controller.validateTool("execute_command", "echo hi").allowed, false)
			const saved = controller.revision
			await (controller as unknown as { loadConfig(): Promise<void> }).loadConfig()
			assert.ok(controller.revision > saved)
		} finally {
			await controller.dispose()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("does not join config loading or create a watcher after disposal", async () => {
		const { controller, factory, load } = createController()
		const gate = deferred()
		load.returns(gate.promise)
		const initialization = controller.initialize("/workspace")
		try {
			await controller.dispose()
		} finally {
			gate.resolve()
		}
		await initialization
		await controller.initialize("/workspace")
		assert.equal(load.callCount, 1)
		assert.equal(factory.callCount, 0)
	})

	it("does not recreate a watcher when disposal interrupts previous closure", async () => {
		const { controller, watchers, factory } = createController()
		await controller.initialize("/workspace")
		const entered = deferred()
		const gate = deferred()
		watchers[0].close.callsFake(() => {
			entered.resolve()
			return gate.promise
		})
		const initialization = controller.initialize("/workspace")
		await entered.promise
		const disposal = controller.dispose()
		gate.resolve()
		await Promise.all([initialization, disposal])
		assert.equal(factory.callCount, 1)
		assert.equal(watchers[0].close.callCount, 1)
	})

	it("does not join a reload or stop sibling controller watchers", async () => {
		const executions = [createController(), createController(), createController()]
		await Promise.all(executions.map(({ controller }) => controller.initialize("/workspace")))
		for (const { load } of executions) load.resetHistory()
		const gate = deferred()
		executions[1].load.returns(gate.promise)
		executions[1].watchers[0].emit("all", "change")
		try {
			await executions[1].controller.dispose()
			for (const { watchers } of executions) watchers[0].emit("all", "change")
			assert.deepEqual(executions.map(({ load }) => load.callCount), [1, 1, 1])
			assert.deepEqual(executions.map(({ watchers }) => watchers[0].close.callCount), [0, 1, 0])
		} finally {
			gate.resolve()
			await Promise.all(executions.map(({ controller }) => controller.dispose()))
		}
	})
})
