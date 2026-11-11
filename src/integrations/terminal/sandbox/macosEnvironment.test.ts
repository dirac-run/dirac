import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import type { Writable } from "node:stream"
import { describe, it } from "mocha"
import { MACOS_ENVIRONMENT_BOOTSTRAP, MACOS_ENVIRONMENT_MAX_BYTES, macOSEnvironmentPayload } from "./macosEnvironment"

async function bootstrap(payload: Buffer, source = "console.log(JSON.stringify(process.env))", stdin = "") {
	const shell = process.platform === "darwin" ? "/bin/sh" : "/bin/bash"
	const argv = ["-c", MACOS_ENVIRONMENT_BOOTSTRAP, "bootstrap", process.execPath, "-e", source]
	const child = spawn(shell, argv, { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe", "pipe"] })
	let stdout = "",
		stderr = ""
	child.stdout!.on("data", (bytes) => {
		stdout += bytes
	})
	child.stderr!.on("data", (bytes) => {
		stderr += bytes
	})
	const control = child.stdio[3] as Writable
	control.on("error", () => {}) // Truncation/invalid-input tests deliberately close the reader early.
	control.end(payload)
	child.stdin!.end(stdin)
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", resolve)
	})
	return { code, stdout, stderr, argv }
}

describe("macOS private-FD workload environment protocol (local shell, not Seatbelt)", () => {
	it("preserves literal values/newlines/equals without putting values in argv", async () => {
		const env = { SECRET: 'literal\n\n; $(printf forbidden) " = \\', EMPTY: "", PATH: "/not-a-real-path" }
		const result = await bootstrap(macOSEnvironmentPayload(env))
		assert.equal(result.code, 0, result.stderr)
		const actual = JSON.parse(result.stdout)
		assert.deepEqual(actual, env)
		assert.ok(!result.argv.some((arg) => arg.includes(env.SECRET)))
		assert.equal(result.stderr, "")
	})

	it("does not interpret integer/special shell variable data as code", async () => {
		const value = "a[$(printf ENV_VALUE_EXECUTED >&2)]"
		const result = await bootstrap(macOSEnvironmentPayload({ RANDOM: value, SECONDS: value, OPTIND: value, LINENO: value }))
		assert.equal(result.code, 0, result.stderr)
		const actual = JSON.parse(result.stdout)
		for (const name of ["RANDOM", "SECONDS", "OPTIND", "LINENO"]) assert.equal(actual[name], value)
		assert.equal(result.stderr, "")
	})

	it("keeps stdin independent and closes control FD before workload exec", async () => {
		const result = await bootstrap(
			macOSEnvironmentPayload({ VALUE: "from-control" }),
			"console.log(require('node:fs').readFileSync(0,'utf8'));console.log(process.env.VALUE)",
			"workload-stdin",
		)
		assert.equal(result.code, 0, result.stderr)
		assert.equal(result.stdout, "workload-stdin\nfrom-control\n")
		const closed = await bootstrap(
			macOSEnvironmentPayload({}),
			"require('node:child_process').execFileSync('/bin/bash',['-c',': <&3'],{stdio:'inherit'})",
		)
		assert.notEqual(closed.code, 0)
	})

	it("rejects bad names/NUL/reserved names/oversized payload before any child is created", () => {
		for (const env of [
			{ "BAD=NAME": "value" },
			{ VALUE: "bad\0value" },
			{ __DIRAC_ENV_COUNT: "0" },
			{ SHELLOPTS: "xtrace" },
			{ BASH_XTRACEFD: "1" },
		]) {
			assert.throws(() => macOSEnvironmentPayload(env), /Invalid|reserved/)
		}
		assert.throws(() => macOSEnvironmentPayload({ BIG: "x".repeat(MACOS_ENVIRONMENT_MAX_BYTES) }), /byte size/)
		assert.throws(
			() => macOSEnvironmentPayload(Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`V${i}`, "v"]))),
			/entry count/,
		)
	})

	it("truncated/malformed/count-overflow input fails before workload exec", async () => {
		for (const payload of [
			Buffer.from("1\0VALUE=truncated"),
			Buffer.from("bad\0"),
			Buffer.from("1025\0"),
			Buffer.from("1\0__DIRAC_ENV_COUNT=0\0"),
		]) {
			const result = await bootstrap(payload, "console.log('WORKLOAD_STARTED')")
			assert.equal(result.code, 125)
			assert.equal(result.stdout, "")
		}
	})
})
