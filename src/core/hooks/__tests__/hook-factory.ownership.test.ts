import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import pWaitFor from "p-wait-for"
import { setDistinctId } from "@/services/logging/distinctId"
import { HookFactory } from "../hook-factory"
import { HookProcess } from "../HookProcess"
import { HookCleanupError } from "../HookCleanupError"
import { HookExecutionError } from "../HookError"
import { createHookTestEnv, type HookTestEnv, stubHookDirs, writeHookScriptForPlatform } from "./test-utils"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => { resolve = settle })
	return { promise, resolve }
}

describe("Hook runner cleanup ownership", () => {
	let env: HookTestEnv
	beforeEach(async () => {
		setDistinctId("test-id")
		env = await createHookTestEnv()
	})
	afterEach(async () => env.cleanup())

	for (const rejects of [false, true]) {
		it(`joins delayed output publication ${rejects ? "rejection" : "success"} before completing`, async () => {
			const hookPath = path.join(env.tempDir, ".diracrules", "hooks", "PreToolUse")
			await writeHookScriptForPlatform(hookPath, `#!/usr/bin/env node\nconsole.log(JSON.stringify({cancel:false}));`)
			const publication = deferred()
			let publishing = false
			let published = 0
			const runner = await new HookFactory().createWithStreaming("PreToolUse", async () => {
				publishing = true
				await publication.promise
				if (rejects) throw new Error("publication failed")
				published++
			})
			let settled = false
			const running = runner.run({ taskId: "test-task", preToolUse: { toolName: "test", parameters: {} } })
				.finally(() => { settled = true })
			const rejection = rejects ? assert.rejects(running, /Hook output publication or snapshot cleanup failed/) : undefined
			await pWaitFor(() => publishing, { interval: 5 })
			await new Promise<void>((resolve) => setTimeout(resolve, 30))
			assert.equal(settled, false)
			publication.resolve()
			if (rejection) await rejection
			else {
				await running
				assert.ok(published > 0)
			}
		})
	}

	it("joins every sibling and preserves later cleanup failure over earlier cancellation", async () => {
		const global = path.join(env.tempDir, "global-hooks")
		const workspace = path.join(env.tempDir, ".diracrules", "hooks")
		await fs.mkdir(global, { recursive: true })
		stubHookDirs(env.sandbox, [global, workspace])
		await writeHookScriptForPlatform(path.join(global, "PreToolUse"), "#!/usr/bin/env node\nprocess.exit(1)")
		await writeHookScriptForPlatform(path.join(workspace, "PreToolUse"), "#!/usr/bin/env node\nprocess.exit(0)")
		const cleanup = deferred()
		let starts = 0
		env.sandbox.stub(HookProcess.prototype, "run").callsFake(async () => {
			if (++starts === 1) throw HookExecutionError.cancellation("first")
			await cleanup.promise
			throw new HookCleanupError([new Error("publication failed")], "second hook cleanup failed")
		})
		const runner = await new HookFactory().create("PreToolUse")
		let settled = false
		const running = runner.run({ taskId: "test-task", preToolUse: { toolName: "test", parameters: {} } })
			.finally(() => { settled = true })
		const rejection = assert.rejects(running, (error: unknown) => {
			assert.ok(error instanceof HookCleanupError)
			assert.equal(error.errors.length, 2)
			assert.ok(error.errors.some((failure: unknown) => failure instanceof HookCleanupError))
			return true
		})
		await pWaitFor(() => starts === 2, { interval: 5 })
		assert.equal(settled, false)
		cleanup.resolve()
		await rejection
		assert.equal(settled, true)
	})
})
