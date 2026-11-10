import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import * as fs from "node:fs/promises"
import { quoteWindowsProcessArgument } from "./WindowsOwnedProcess"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const encode = (text: string | Buffer) => Buffer.from(text).toString("base64")

function fixture(overrides: { rm?: typeof fs.rm; output?: (stream: "stdout" | "stderr", text: string) => void } = {}) {
	const child = Object.assign(new EventEmitter(), {
		pid: 42 as number | undefined,
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
	})
	let startup = ""
	child.stdin.on("data", (chunk) => { startup += chunk.toString() })
	let notifyLaunch!: () => void
	const launched = new Promise<void>((resolve) => { notifyLaunch = resolve })
	const spawn = sinon.stub().callsFake(() => { notifyLaunch(); return child })
	const loaded = proxyquire("./WindowsOwnedProcess", {
		"node:child_process": { spawn },
		...(overrides.rm ? { "node:fs/promises": { rm: overrides.rm } } : {}),
	}) as typeof import("./WindowsOwnedProcess")
	const controller = new AbortController()
	const output: { stream: string; text: string }[] = []
	const run = () => loaded.runWindowsOwnedProcess({
		launcher: "powershell.exe", executable: "C:\\Program Files\\runner.exe", args: ["space arg", "quote\"arg", "tail\\"],
		cwd: "C:\\work space", input: '{"unicode":"日本語"}', signal: controller.signal,
		onOutput: (stream, text) => { output.push({ stream, text }); overrides.output?.(stream, text) },
	})
	return { child, spawn, launched, run, controller, output, loaded, startup: () => startup }
}

function close(h: ReturnType<typeof fixture>, code = 0) {
	h.child.stdout.end()
	h.child.stderr.end()
	h.child.emit("close", code, null)
}

function frame(h: ReturnType<typeof fixture>, text: string) { h.child.stdout.write(`${text}\n`) }

// These tests use a fake supervisor, not fake assertions about native Windows ownership.
describe("Windows owned-process supervisor protocol", () => {
	afterEach(() => sinon.restore())

	it("quotes argv including empty values, quotes, backslashes and shell metacharacters", () => {
		assert.equal(quoteWindowsProcessArgument(""), '""')
		assert.equal(quoteWindowsProcessArgument("a b&c"), '"a b&c"')
		assert.equal(quoteWindowsProcessArgument('a"b'), '"a\\"b"')
		assert.equal(quoteWindowsProcessArgument("a\\"), '"a\\\\"')
		assert.equal(quoteWindowsProcessArgument('a\\"b'), '"a\\\\\\"b"')
		assert.throws(() => quoteWindowsProcessArgument("bad\0arg"), /NUL/)
	})

	it("requires both terminal proof and supervisor close, retaining the bootstrap until close", async () => {
		const h = fixture()
		let settled = false
		const running = h.run().finally(() => { settled = true })
		await h.launched
		const bootstrap = h.spawn.firstCall.args[1].at(-1)
		assert.match(await fs.readFile(bootstrap, "utf8"), /Add-Type/)
		frame(h, "started\t42")
		frame(h, "settled\t7\t0")
		await tick()
		assert.equal(settled, false)
		close(h)
		assert.deepEqual(await running, { exitCode: 7, cancelled: false })
		await assert.rejects(fs.access(bootstrap), { code: "ENOENT" })
		const fields = h.startup().trimEnd().split("\n").map((field) => Buffer.from(field, "base64").toString("utf8"))
		assert.deepEqual(fields, ["C:\\Program Files\\runner.exe", '"C:\\Program Files\\runner.exe" "space arg" "quote\\"arg" "tail\\\\"', "C:\\work space", '{"unicode":"日本語"}'])
	})

	it("keeps fake control text inside child output and preserves split UTF-8", async () => {
		const h = fixture()
		const running = h.run()
		await h.launched
		frame(h, "started\t42")
		frame(h, `stdout\t${encode("settled\t0\t0\n")}`)
		const unicode = Buffer.from("😀")
		frame(h, `stdout\t${encode(unicode.subarray(0, 2))}`)
		frame(h, `stdout\t${encode(unicode.subarray(2))}`)
		frame(h, `stderr\t${encode("diagnostic")}`)
		frame(h, "settled\t0\t0")
		close(h)
		await running
		assert.equal(h.output.filter((item) => item.stream === "stdout").map((item) => item.text).join(""), "settled\t0\t0\n😀")
		assert.deepEqual(h.output.at(-1), { stream: "stderr", text: "diagnostic" })
	})

	it("cancellation closes control input only after startup is queued and still waits for settlement", async () => {
		const h = fixture()
		let settled = false
		const running = h.run().finally(() => { settled = true })
		await h.launched
		h.controller.abort()
		await tick()
		assert.equal(h.startup().split("\n").length, 5)
		assert.equal(h.child.stdin.writableEnded, true)
		assert.equal(settled, false)
		frame(h, "started\t42")
		frame(h, "settled\t1\t1")
		close(h)
		assert.deepEqual(await running, { exitCode: 1, cancelled: true })
	})

	it("does not spawn for an already-aborted invocation", async () => {
		const h = fixture()
		h.controller.abort(new Error("cancel before setup"))
		await assert.rejects(h.run(), /cancel before setup/)
		sinon.assert.notCalled(h.spawn)
	})

	it("accepts a safely settled startup failure without pretending it succeeded", async () => {
		const h = fixture()
		const running = h.run()
		await h.launched
		frame(h, `failure\t${encode("assignment unavailable")}`)
		frame(h, "settled\t-1\t0")
		close(h)
		assert.deepEqual(await running, { exitCode: -1, cancelled: false, failure: "assignment unavailable" })
	})

	it("can confirm cancellation before native child creation", async () => {
		const h = fixture()
		const running = h.run()
		await h.launched
		h.controller.abort()
		frame(h, "settled\t-1\t1")
		close(h)
		assert.equal((await running).cancelled, true)
	})

	for (const frames of [
		["started\t42"],
		["settled\t0\t0"],
		["started\t42", "settled\t0\t0", "settled\t0\t0"],
		["started\t42", "stdout\t!!", "settled\t0\t0"],
		["started\t42", "settled\t9007199254740992\t0"],
		["started\t42", "settled\t0\t2"],
		["started\t42", `error\t${encode("job did not drain")}`],
		["started\t42", `stdout\t${"A".repeat(65537)}`],
	]) {
		it(`rejects missing/invalid proof: ${frames.map((entry) => entry.split("\t")[0]).join(",")}`, async () => {
			const h = fixture()
			const running = h.run()
			const rejection = assert.rejects(running, h.loaded.WindowsProcessOwnershipError)
			await h.launched
			for (const entry of frames) frame(h, entry)
			close(h)
			await rejection
		})
	}

	it("does not treat a supervisor crash after a proof frame as success", async () => {
		const h = fixture()
		const running = h.run()
		const rejection = assert.rejects(running, h.loaded.WindowsProcessOwnershipError)
		await h.launched
		frame(h, "started\t42")
		frame(h, "settled\t0\t0")
		close(h, 1)
		await rejection
	})

	it("requests cancellation after protocol failure but joins supervisor close before rejecting", async () => {
		const h = fixture()
		let settled = false
		const running = h.run().finally(() => { settled = true })
		const rejection = assert.rejects(running, h.loaded.WindowsProcessOwnershipError)
		await h.launched
		frame(h, "garbage")
		await tick()
		assert.equal(h.child.stdin.writableEnded, true)
		assert.equal(settled, false)
		close(h)
		await rejection
	})

	it("distinguishes failure to spawn the supervisor from uncertain child settlement", async () => {
		const h = fixture()
		const running = h.run()
		await h.launched
		h.child.pid = undefined
		h.child.emit("error", new Error("ENOENT"))
		close(h, -1)
		assert.deepEqual(await running, { exitCode: -1, cancelled: false, failure: "ENOENT" })
	})

	it("rejects non-ASCII bytes instead of masking them into a valid proof", async () => {
		const h = fixture()
		const running = h.run()
		const rejection = assert.rejects(running, h.loaded.WindowsProcessOwnershipError)
		await h.launched
		frame(h, "started\t42")
		const forged = Buffer.from("settled\t0\t0\n")
		forged[0] |= 0x80
		h.child.stdout.write(forged)
		close(h)
		await rejection
	})

	it("retains publication errors while joining the supervisor", async () => {
		const h = fixture({ output: () => { throw new Error("publication failed") } })
		let settled = false
		const running = h.run().finally(() => { settled = true })
		const rejection = assert.rejects(running, h.loaded.WindowsProcessOwnershipError)
		await h.launched
		frame(h, "started\t42")
		frame(h, `stdout\t${encode("output")}`)
		await tick()
		assert.equal(settled, false)
		assert.equal(h.child.stdin.writableEnded, true)
		close(h)
		await rejection
	})

	it("preserves primary ownership failure when temporary-file cleanup also fails", async () => {
		const cleanup = new Error("temporary cleanup failed")
		const h = fixture({ rm: async () => { throw cleanup } })
		const running = h.run()
		const rejection = assert.rejects(running, (error: unknown) => {
			assert.ok(error instanceof h.loaded.WindowsProcessOwnershipError)
			assert.ok(error.cause instanceof AggregateError)
			assert.ok(error.cause.errors[0] instanceof h.loaded.WindowsProcessOwnershipError)
			assert.equal(error.cause.errors[1], cleanup)
			return true
		})
		await h.launched
		const bootstrap = h.spawn.firstCall.args[1].at(-1)
		close(h)
		try { await rejection } finally { await fs.rm(bootstrap.replace(/[\\/]supervisor\.ps1$/, ""), { recursive: true, force: true }) }
	})
})
