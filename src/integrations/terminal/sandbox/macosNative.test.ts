import assert from "node:assert/strict"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "mocha"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import { prepareNativeSandbox, probeNativeSandbox } from "./nativeSandbox"
import { NativeSandboxError, type NativeSandboxRequest } from "./types"

function observe(child: ChildProcess) {
	let stdout = "",
		stderr = ""
	const errors: Error[] = []
	child.stdout?.on("data", (bytes) => {
		stdout += bytes
	})
	child.stderr?.on("data", (bytes) => {
		stderr += bytes
	})
	child.on("error", (error) => errors.push(error))
	const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
		child.once("close", (code, signal) => resolve([code, signal])),
	)
	return { closed, output: () => ({ stdout, stderr }), errors }
}

function nativeFixture() {
	const root = realpathSync(mkdtempSync("/private/tmp/dirac-mac-native-"))
	const workspace = path.join(root, "work")
	const authority = path.join(workspace, "authority")
	const readonly = path.join(workspace, "readonly")
	const temp = path.join(root, "temp")
	for (const value of [authority, readonly, temp]) mkdirSync(value, { recursive: true })
	writeFileSync(path.join(authority, "secret"), "protected")
	writeFileSync(path.join(readonly, "data"), "unchanged")
	const policy: CustomSandboxProfile = {
		id: "native-test",
		revision: 1,
		kind: "custom",
		name: "Native test",
		description: "",
		filesystem: { base: "selected", workspace: "read-write", readable: [readonly], writable: [], blocked: [], caches: [] },
		temporaryDirectory: temp,
		network: "deny",
		environment: { passthrough: [], overrides: { VALUE: "literal ; $() = value" } },
	}
	const request: NativeSandboxRequest = {
		executable: "/bin/sh",
		args: [],
		cwd: workspace,
		env: process.env,
		policy,
		context: { workspaceRoots: [workspace], protectedPaths: [authority] },
	}
	return {
		root,
		workspace,
		authority,
		readonly,
		policy,
		request,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

async function waitForFile(file: string): Promise<string> {
	for (let i = 0; i < 100; i++) {
		if (existsSync(file)) return readFileSync(file, "utf8")
		await delay(20)
	}
	throw new Error("Native descendant did not produce its fixture result.")
}

function escapedFixtureSource(protectedFile: string, resultFile: string, lifetimeMs = 10000): string {
	// Arm expiry before any handoff I/O: the test may never learn this escaped PID.
	return `setTimeout(()=>process.exit(0),${lifetimeMs});let denied=false;try{require('node:fs').readFileSync(${JSON.stringify(protectedFile)})}catch{denied=true}const fs=require('node:fs');const result=${JSON.stringify(resultFile)};const pending=result+'.pending-'+process.pid;fs.writeFileSync(pending,JSON.stringify({pid:process.pid,denied}));fs.renameSync(pending,result)`
}

function stopEscapedFixture(pid: number): void {
	try {
		process.kill(pid, "SIGKILL")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
	}
}

describe("escaped native-test fixture safety (local Node, not Seatbelt)", () => {
	it("atomically publishes complete JSON and self-expires without any PID handoff", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "dirac-escaped-fixture-"))
		const resultFile = path.join(root, "result")
		const child = spawn(
			process.execPath,
			["-e", escapedFixtureSource(path.join(root, "missing-protected-file"), resultFile, 100)],
			{ stdio: "ignore" },
		)
		const result = observe(child)
		try {
			// Deliberately do not read/assign the fixture PID until it has expired by itself.
			assert.deepEqual(await result.closed, [0, null])
			const descendant = JSON.parse(readFileSync(resultFile, "utf8")) as { pid: number; denied: boolean }
			assert.equal(descendant.pid, child.pid)
			assert.equal(descendant.denied, true)
			assert.equal(existsSync(`${resultFile}.pending-${child.pid}`), false)
			stopEscapedFixture(descendant.pid) // Already-exited owned fixture: ESRCH is expected.
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
			rmSync(root, { recursive: true, force: true })
		}
	})
})

/** Linux skips are explicit: none of these tests are evidence of native macOS enforcement here. */
describe("actual macOS Seatbelt conformance (requires native host)", function () {
	this.timeout(30000)
	before(async function () {
		if (process.platform !== "darwin") {
			console.warn("macOS native conformance UNVERIFIED: executing host is not macOS.")
			this.skip()
		}
		const capability = await probeNativeSandbox()
		if (!capability.available || capability.backend !== "seatbelt" || !capability.policyCapabilities?.restrictiveProfiles) {
			console.warn("macOS restrictive conformance UNVERIFIED: helper or behavioral capability gate unavailable.")
			this.skip()
		}
	})

	it("launches the restrictive shell with literal env/private host temp and protected/RO exceptions", async () => {
		const f = nativeFixture()
		try {
			f.request.args = [
				"-c",
				`
[ "$VALUE" = 'literal ; $() = value' ] || exit 1
[ -z "\${HOME+x}" ] || exit 2
printf writable > writable || exit 3
(printf changed > readonly/data) && exit 4
/bin/cat authority/secret >/dev/null 2>&1 && exit 5
/bin/mv authority authority-moved >/dev/null 2>&1 && exit 6
printf temporary > "$TMPDIR/marker" || exit 7
printf '%s' "$TMPDIR"
exit 0
`,
			]
			const prepared = await prepareNativeSandbox(f.request)
			const result = observe(prepared.spawn())
			assert.deepEqual(await result.closed, [0, null], result.output().stderr)
			assert.deepEqual(result.errors, [])
			assert.equal(readFileSync(path.join(f.readonly, "data"), "utf8"), "unchanged")
			assert.equal(existsSync(result.output().stdout), false, "execution temp must be removed on close")
		} finally {
			f.cleanup()
		}
	})

	for (const openPipes of [false, true]) {
		it(`inherits restrictive policy into an escaped session with ${openPipes ? "open" : "closed"} pipes; reports cleanup uncertainty`, async () => {
			const f = nativeFixture()
			let escapedPid: number | undefined
			try {
				// Explicit broad RO is needed for the host's Node toolchain, not an implicit selected grant.
				f.policy.filesystem.base = "broad-read"
				const resultFile = path.join(f.workspace, "descendant-result")
				const code = escapedFixtureSource(path.join(f.authority, "secret"), resultFile)
				f.request.executable = process.execPath
				f.request.args = [
					"-e",
					`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{detached:true,stdio:${openPipes ? "['ignore',1,2]" : "'ignore'"}}).unref();setTimeout(()=>process.exit(0),200)`,
				]
				const prepared = await prepareNativeSandbox(f.request)
				const child = prepared.spawn()
				const result = observe(child)
				const descendant = JSON.parse(await waitForFile(resultFile)) as { pid: number; denied: boolean }
				escapedPid = descendant.pid
				assert.equal(descendant.denied, true, "escaped sessions must retain Seatbelt restrictions")
				await result.closed
				assert.equal(process.kill(escapedPid, 0), true, "Seatbelt is not an escaped-session lifetime owner")
				await assert.rejects(
					prepared.terminate(child),
					(error: NativeSandboxError) => error.category === "cleanup-failed" && error.stage === "execution-uncertain",
				)
				if (openPipes) assert.ok(result.errors.some((error) => /pipes remain open/.test(error.message)))
				else assert.deepEqual(result.errors, [])
			} finally {
				// Explicit native-test ownership: stop the known escaped fixture PID, never claim launcher did it.
				if (escapedPid) stopEscapedFixture(escapedPid)
				f.cleanup()
			}
		})
	}

	it("cancels only the original group and does not kill a simultaneous sibling", async () => {
		const base: NativeSandboxRequest = {
			executable: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)"],
			cwd: "/",
			env: process.env,
			policy: { id: "default" },
		}
		const first = await prepareNativeSandbox(base),
			sibling = await prepareNativeSandbox(base)
		const child = first.spawn(),
			siblingChild = sibling.spawn()
		const firstResult = observe(child),
			siblingResult = observe(siblingChild)
		try {
			await assert.rejects(first.terminate(child), /escaped-session/)
			await firstResult.closed
			assert.equal(process.kill(siblingChild.pid!, 0), true)
		} finally {
			await assert.rejects(sibling.terminate(siblingChild), /escaped-session/)
			await siblingResult.closed
		}
	})
})
