import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { requestSession, startSession } from "./client.mjs"
import { CREATE_FILE_CONTENT, CREATE_FILE_PATH } from "./fixture-provider.mjs"

async function stopAndRemove(metadata) {
	await requestSession(metadata.session, { operation: "stop" })
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(metadata.pid, 0)
		} catch (error) {
			if (error.code !== "ESRCH") throw error
			await rm(metadata.session, { recursive: true })
			return
		}
		await delay(30)
	}
	throw new Error("Harness owner did not exit")
}

for (const [cols, rows] of [[100, 40], [60, 24]]) {
	test(`approval settings immediately release pending permission without consuming the draft (${cols}x${rows})`, { timeout: 45000 }, async (context) => {
		const metadata = await startSession({ fixture: "create-file", cols, rows })
		context.after(() => stopAndRemove(metadata))
		const { session } = metadata
		await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		await requestSession(session, { operation: "write", text: "/askDirac Create the fixture file." })
		await requestSession(session, { operation: "key", key: "Enter" })
		const pending = await requestSession(session, { operation: "wait", text: "waiting for input", timeoutMs: 30000 })
		assert.equal(pending.fixtureRequests, 1)
		await requestSession(session, { operation: "paste", text: "Keep my independent draft" })
		// xterm Shift+Tab: a local setting change, not a permission response.
		await requestSession(session, { operation: "write", text: "\u001b[Z" })
		const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 5000 })
		assert.match(completed.screen, /Keep my independent draft/)
		assert.equal(completed.fixtureRequests, 2)
		assert.equal(await readFile(path.join(metadata.cwd, CREATE_FILE_PATH), "utf8"), CREATE_FILE_CONTENT)
	})
}
