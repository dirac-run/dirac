import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "mocha"
import { settleMacOSProbeProcess } from "./macosProbe"

function fakeProbe() {
	const control = new PassThrough()
	let unreferences = 0
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		stdio: [null, null, null, control],
		unref() {
			unreferences++
		},
	}) as unknown as ChildProcess
	return { child, control, unreferences: () => unreferences }
}

describe("macOS conformance probe settlement (fake process, not Seatbelt)", () => {
	it("fails closed within its deadline when group kill fails and close never arrives", async () => {
		const fake = fakeProbe()
		let kills = 0
		const result = settleMacOSProbeProcess(fake.child, Buffer.from("0\0"), {
			timeoutMs: 5,
			killGroup() {
				kills++
				throw Object.assign(new Error("denied"), { code: "EPERM" })
			},
		})
		assert.equal(await result, false)
		assert.equal(kills, 1)
		assert.equal(fake.control.destroyed, true)
		assert.equal(fake.unreferences(), 1)
		fake.child.emit("close", 0, null)
		assert.equal(await result, false, "late close must never convert uncertain cleanup to success")
	})

	it("fails closed on control-pipe error even if no process close event follows", async () => {
		const fake = fakeProbe()
		let kills = 0
		const result = settleMacOSProbeProcess(fake.child, Buffer.from("0\0"), {
			timeoutMs: 1000,
			killGroup() {
				kills++
			},
		})
		fake.control.emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }))
		assert.equal(await result, false)
		assert.equal(kills, 1)
		assert.equal(fake.control.destroyed, true)
	})

	it("successful close clears its deadline and never invokes cleanup or detaches the process", async () => {
		const fake = fakeProbe()
		let kills = 0
		const result = settleMacOSProbeProcess(fake.child, Buffer.from("0\0"), {
			timeoutMs: 5,
			killGroup() {
				kills++
			},
		})
		fake.child.emit("close", 0, null)
		assert.equal(await result, true)
		await delay(15)
		assert.equal(kills, 0)
		assert.equal(fake.unreferences(), 0)
	})
})
