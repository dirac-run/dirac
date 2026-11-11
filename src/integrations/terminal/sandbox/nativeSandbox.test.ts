import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "mocha"
import { DEFAULT_SEATBELT_POLICY, defaultNativeArguments, permissiveSeccompFilter } from "./defaultPolicy"
import { NativeSandboxError, type NativeSandboxRequest, prepareNativeSandbox, probeNativeSandbox } from "./index"

const request = (source: string, args: string[] = []): NativeSandboxRequest => ({
	executable: process.execPath,
	args: ["-e", source, ...args],
	cwd: process.cwd(),
	env: process.env,
	policy: { id: "default" },
})

function collect(child: ChildProcess) {
	let stdout = ""
	let stderr = ""
	child.stdout?.on("data", (chunk) => {
		stdout += chunk
	})
	child.stderr?.on("data", (chunk) => {
		stderr += chunk
	})
	return { done: once(child, "close"), output: () => ({ stdout, stderr }) }
}

async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<RegExpMatchArray> {
	let output = ""
	for await (const chunk of child.stdout!) {
		output += chunk
		const match = output.match(pattern)
		if (match) return match
	}
	throw new Error(`Missing expected output: ${pattern}`)
}

async function waitForDeath(pid: number) {
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0)
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH")
			return
		}
		await delay(20)
	}
	assert.fail(`Process ${pid} survived native cleanup`)
}

// Default retains host-visible /proc, but kill() uses the calling test's PID namespace.
// Resolve that namespace's column, including when the test itself runs under Bubblewrap.
function callerVisiblePidExpression() {
	const namespacePids = readFileSync("/proc/self/status", "utf8").match(/^NSpid:\s+(.+)$/m)![1].trim().split(/\s+/)
	const callerNamespaceIndex = namespacePids.length - 1
	assert.equal(Number(namespacePids[callerNamespaceIndex]), process.pid)
	return `require('node:fs').readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s+(.+)$/m)[1].trim().split(/\\s+/)[${callerNamespaceIndex}]`
}

function forkDescendantSource() {
	const descendantSource = `console.log('descendant:'+${callerVisiblePidExpression()});setInterval(()=>{},1000)`
	return `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{detached:true,stdio:['ignore',1,2]}).unref();`
}

describe("native sandbox Default foundation", () => {
	it("constructs literal Seatbelt argv and an unconditional allow cBPF instruction", () => {
		const input = request("literal ; $(not-executed)")
		assert.deepEqual(
			defaultNativeArguments(
				{ available: true, backend: "seatbelt", helperPath: "/usr/bin/sandbox-exec", limitations: [] },
				input,
			),
			["-p", DEFAULT_SEATBELT_POLICY, process.execPath, ...input.args],
		)
		assert.equal(permissiveSeccompFilter().length, 8)
		assert.ok(
			permissiveSeccompFilter().equals(Buffer.from([6, 0, 0, 0, 0, 0, 255, 127])) ||
			permissiveSeccompFilter().equals(Buffer.from([0, 6, 0, 0, 127, 255, 0, 0])),
		)
	})

	it("rejects unsupported policies before launching", async () => {
		const input = request("")
		Object.assign(input, { policy: { id: "restrictive-not-implemented" } })
		await assert.rejects(
			prepareNativeSandbox(input),
			(error: NativeSandboxError) => error.category === "invalid-policy" && !error.fallbackEligible,
		)
	})

	it("caches the executing host capability and reports limitations", async () => {
		assert.equal(probeNativeSandbox(), probeNativeSandbox())
		const result = await probeNativeSandbox()
		if (!result.available) {
			assert.ok(result.error instanceof NativeSandboxError)
			assert.equal(result.error.stage, "before-launch")
			return
		}
		assert.ok(result.limitations.some((limit) => limit.includes("no meaningful isolation")))
	})

	describe("actual Linux Bubblewrap 0.12.0 + seccomp", function () {
		this.timeout(15000)
		before(async function () {
			if (process.platform !== "linux") this.skip()
			const result = await probeNativeSandbox()
			if (!result.available) {
				console.warn(`Native Linux tests unavailable: ${result.error.message}`)
				this.skip()
			}
		})

		it("preserves literal argv, cwd, env, both output streams, exit status, and frozen preparation", async () => {
			const cwd = await mkdtemp(join(tmpdir(), "dirac-native-"))
			try {
				const literal = "; $(touch never) ' \""
				const input = request(
					"console.log(JSON.stringify([process.cwd(),process.env.DIRAC_TEST,process.argv[1]]));console.error('stderr-ok');process.exitCode=7",
					[literal],
				)
				input.cwd = cwd
				input.env = { ...process.env, DIRAC_TEST: "env-ok" }
				const prepared = await prepareNativeSandbox(input)
				input.args = ["-e", "throw Error('mutated')"]
				input.env.DIRAC_TEST = "mutated"
				const child = prepared.spawn()
				const result = collect(child)
				assert.deepEqual(await result.done, [7, null])
				assert.deepEqual(JSON.parse(result.output().stdout), [cwd, "env-ok", literal])
				assert.equal(result.output().stderr, "stderr-ok\n")
				assert.throws(() => prepared.spawn(), /replay is forbidden/)
			} finally {
				await rm(cwd, { recursive: true })
			}
		})

		it("does not guess a workload signal from shell-encoded native exit status", async () => {
			for (const source of ["process.exit(143)", "process.kill(process.pid,'SIGTERM')"]) {
				const prepared = await prepareNativeSandbox(request(source))
				const result = collect(prepared.spawn())
				assert.deepEqual(await result.done, [143, null])
				assert.throws(() => prepared.spawn(), /replay is forbidden/)
			}
		})

		it("kills escaped-group descendants after main workload exits", async () => {
			const prepared = await prepareNativeSandbox(request(`${forkDescendantSource()}setTimeout(()=>process.exit(0),300)`))
			const child = prepared.spawn()
			const completion = once(child, "close")
			try {
				const match = await waitForOutput(child, /descendant:(\d+)/)
				assert.equal(process.kill(Number(match[1]), 0), true)
				assert.deepEqual(await completion, [0, null])
				await waitForDeath(Number(match[1]))
			} finally {
				await prepared.terminate(child)
			}
		})

		it("cancels owned descendants without killing a simultaneous sibling", async () => {
			const prepared = await prepareNativeSandbox(request(`${forkDescendantSource()}setInterval(()=>{},1000)`))
			const sibling = await prepareNativeSandbox(request(`console.log('sibling:'+${callerVisiblePidExpression()});setInterval(()=>{},1000)`))
			const child = prepared.spawn()
			const siblingChild = sibling.spawn()
			try {
				const [descendant, siblingPid] = await Promise.all([
					waitForOutput(child, /descendant:(\d+)/),
					waitForOutput(siblingChild, /sibling:(\d+)/),
				])
				assert.equal(process.kill(Number(descendant[1]), 0), true)
				assert.equal(process.kill(Number(siblingPid[1]), 0), true)
				await assert.rejects(prepared.terminate(siblingChild), /different execution/)
				await prepared.terminate(child)
				await waitForDeath(Number(descendant[1]))
				assert.equal(process.kill(Number(siblingPid[1]), 0), true)
			} finally {
				await Promise.all([prepared.terminate(child), sibling.terminate(siblingChild)])
			}
		})
	})
})
