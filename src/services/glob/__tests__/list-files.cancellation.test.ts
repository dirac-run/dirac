import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as traversal from "@utils/workspaceTraversal"
import { listFiles } from "../list-files"

describe("listFiles cancellation ownership", () => {
	afterEach(() => sinon.restore())

	it("rejects pre-aborted reads before filesystem work", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled")
		controller.abort(reason)
		const stat = sinon.spy(fs, "stat")
		await assert.rejects(listFiles("/workspace", true, 200, controller.signal), (error) => error === reason)
		sinon.assert.notCalled(stat)
	})

	it("forwards cancellation into traversal and waits for iterator cleanup", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled")
		sinon.stub(fs, "stat").resolves({ isDirectory: () => true } as any)
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => { markStarted = resolve })
		let releaseCleanup!: () => void
		const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve })
		let cleanupFinished = false
		sinon.stub(traversal, "walkWorkspace").callsFake(async function* (_root, options) {
			const signal = options!.signal!
			markStarted()
			try {
				await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
			} finally {
				await cleanup
				cleanupFinished = true
			}
		})
		let settled = false
		const rejection = assert.rejects(listFiles("/workspace", true, 200, controller.signal), (error) => error === reason)
			.then(() => { settled = true })
		await started
		controller.abort(reason)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(settled, false)
		releaseCleanup()
		await rejection
		assert.equal(cleanupFinished, true)
	})
})
