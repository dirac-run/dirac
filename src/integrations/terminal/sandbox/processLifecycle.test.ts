import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "mocha"
import { ownNativeProcess } from "./processLifecycle"
import { NativeSandboxError } from "./types"

function fakeProcess() {
	const events = new EventEmitter()
	const stdout = new PassThrough(), stderr = new PassThrough()
	const child = Object.assign(events, { pid: 123, stdout, stderr, stdio: [null, stdout, stderr, new PassThrough()] }) as unknown as ChildProcess
	const errors: Error[] = []
	child.on("error", (error) => errors.push(error))
	return { child, errors }
}

describe("native process lifetime (fake-process tests, no OS enforcement claim)", () => {
	it("kills the original Seatbelt group on exit, even when a descendant holds pipes open", async () => {
		const { child, errors } = fakeProcess()
		let kills = 0, cleaned = 0
		const lifetime = ownNativeProcess(child, { descendantsContained: false, killGroup: () => { kills++ }, cleanup: () => { cleaned++ }, drainTimeoutMs: 10 })
		child.emit("exit", 0, null)
		assert.equal(kills, 1)
		assert.equal(cleaned, 0)
		await delay(25)
		assert.equal(child.stdout!.destroyed, true)
		assert.equal(child.stderr!.destroyed, true)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /escaped descendants/)
		child.emit("close", 0, null)
		assert.equal(cleaned, 1)
		await assert.rejects(lifetime.terminate(), /escaped descendants/)
		assert.equal(kills, 1)
	})

	it("normal leader exit and drained pipes do not emit routine errors or reject capability probes", async () => {
		const { child, errors } = fakeProcess()
		let kills = 0
		ownNativeProcess(child, { descendantsContained: false, killGroup: () => { kills++ }, cleanup() { }, drainTimeoutMs: 5 })
		child.emit("exit", 0, null); child.emit("close", 0, null)
		await delay(15)
		assert.equal(kills, 1); assert.deepEqual(errors, [])
	})

	it("closed-pipe escaped-session cleanup is explicitly uncertain on terminate, never guessed from close", async () => {
		const { child } = fakeProcess()
		let kills = 0
		const lifetime = ownNativeProcess(child, { descendantsContained: false, killGroup: () => { kills++ }, cleanup() { } })
		const stopped = lifetime.terminate()
		child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL")
		await assert.rejects(stopped, (error: NativeSandboxError) => error.category === "cleanup-failed" && error.stage === "execution-uncertain" && /escaped-session/.test(error.message))
		await assert.rejects(lifetime.terminate(), /escaped-session/)
		assert.equal(kills, 1)
	})

	it("namespace-owned process cleanup can settle successfully without group killing after close", async () => {
		const { child, errors } = fakeProcess()
		let kills = 0, cleaned = 0
		const lifetime = ownNativeProcess(child, { descendantsContained: true, killGroup: () => { kills++ }, cleanup: () => { cleaned++ } })
		const stopped = lifetime.terminate()
		assert.equal(kills, 1)
		child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL")
		await stopped; await lifetime.terminate()
		assert.equal(kills, 1); assert.equal(cleaned, 1); assert.deepEqual(errors, [])
	})

	it("bounds failed namespace-helper drain including policy pipes without claiming cleanup or killing another group", async () => {
		const { child, errors } = fakeProcess()
		let kills = 0, cleaned = 0
		const lifetime = ownNativeProcess(child, { descendantsContained: true, killGroup: () => { kills++ }, cleanup: () => { cleaned++ }, drainTimeoutMs: 10 })
		child.emit("exit", 1, null)
		await delay(25)
		assert.equal(kills, 0)
		assert.equal(cleaned, 0)
		assert.equal(errors.length, 1)
		assert.ok(errors[0] instanceof NativeSandboxError)
		assert.equal(errors[0].category, "cleanup-failed")
		assert.equal(errors[0].stage, "execution-uncertain")
		for (const stream of child.stdio) if (stream) assert.equal(stream.destroyed, true)
		child.emit("close", 1, null)
		assert.equal(cleaned, 1)
		await assert.rejects(lifetime.terminate(), (error) => error === errors[0])
		assert.equal(kills, 0)
	})

	it("cleanup failures are preserved, not swallowed or changed into success", async () => {
		const { child, errors } = fakeProcess()
		const failure = new NativeSandboxError("cleanup failed", "cleanup-failed", "execution-uncertain")
		const lifetime = ownNativeProcess(child, { descendantsContained: true, killGroup() { }, cleanup() { throw failure } })
		child.emit("exit", 0, null); child.emit("close", 0, null)
		assert.deepEqual(errors, [failure])
		await assert.rejects(lifetime.terminate(), (error) => error === failure)
	})
})
