import assert from "node:assert/strict"
import { HookProcessRegistry } from "../HookProcessRegistry"

describe("Hook process cleanup failures", () => {
	afterEach(() => HookProcessRegistry.resetForTesting())

	it("joins every registry cleanup before surfacing one failure", async () => {
		let release!: () => void
		const slow = new Promise<void>((resolve) => { release = resolve })
		HookProcessRegistry.register({ terminate: async () => { throw new Error("failed cleanup") } } as any)
		HookProcessRegistry.register({ terminate: () => slow } as any)
		let settled = false
		const shutdown = HookProcessRegistry.terminateAll().finally(() => { settled = true })
		const rejection = assert.rejects(shutdown, /Hook process cleanup failed/)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(settled, false)
		release()
		await rejection
	})
})
