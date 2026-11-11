import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import path from "node:path"
import { DEFAULT_SANDBOX_SETTINGS, getSandboxProfiles } from "@shared/SandboxSettings"
import { after, before, describe, it } from "mocha"
import { prepareNativeSandbox, probeNativeSandbox } from "./nativeSandbox"

/** Real launches: a preset's displayed capabilities must match OS enforcement. */
describe("Built-in restrictive sandbox profiles", function () {
	this.timeout(15000)
	let base: string
	let server: Server
	let port: number
	before(async function () {
		if (process.platform !== "linux" || process.arch !== "x64") {
			console.warn("Preset enforcement tests require Linux x64")
			this.skip()
		}
		const capability = await probeNativeSandbox()
		if (!capability.available) {
			console.warn(capability.error.message)
			this.skip()
		}
		// The preset's private /tmp must not cover the workspace being tested.
		base = await mkdtemp("/var/tmp/dirac-presets-")
		for (const folder of ["workspace", "state", "outside"]) await mkdir(path.join(base, folder))
		await writeFile(path.join(base, "workspace", "input.txt"), "project")
		await writeFile(path.join(base, "outside", "secret.txt"), "host-secret")
		server = createServer((socket) => socket.end())
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		port = (server.address() as { port: number }).port
	})
	after(async () => {
		if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
		if (base) await rm(base, { recursive: true, force: true })
	})

	for (const [name, writable, online] of [
		["Workspace", true, true],
		["Offline workspace", true, false],
		["Read-only", false, false],
	] as const) {
		it(`${name}: enforces workspace, network, host-file and environment capabilities`, async () => {
			const policy = getSandboxProfiles(DEFAULT_SANDBOX_SETTINGS).find((profile) => profile.name === name)
			assert.ok(policy && "kind" in policy, `Missing restrictive preset ${name}`)
			const outputPath = path.join(base, "workspace", `${policy.id}.txt`)
			const code = `
import os, socket, tempfile
from pathlib import Path
assert Path('input.txt').read_text() == 'project'
assert 'DIRAC_PRESET_TEST_SECRET' not in os.environ
try:
 Path(${JSON.stringify(path.join(base, "outside", "secret.txt"))}).read_text()
 raise AssertionError('Host files were exposed')
except OSError:
 pass
wrote = False
try:
 Path(${JSON.stringify(outputPath)}).write_text('built')
 wrote = True
except OSError:
 pass
assert wrote == ${writable ? "True" : "False"}
with tempfile.TemporaryFile() as f:
 f.write(b'private scratch')
connected = False
try:
 with socket.create_connection(('127.0.0.1', ${port}), timeout=1):
  connected = True
except OSError:
 pass
assert connected == ${online ? "True" : "False"}
print('preset-ok')
`
			const prepared = await prepareNativeSandbox({
				executable: "/usr/bin/python3", args: ["-c", code],
				cwd: path.join(base, "workspace"),
				env: { ...process.env, DIRAC_PRESET_TEST_SECRET: "not-for-workload" },
				policy,
				context: { workspaceRoots: [path.join(base, "workspace")], protectedPaths: [path.join(base, "state")] },
			})
			const child = prepared.spawn()
			let stdout = "", stderr = ""
			child.stdout!.on("data", (data) => { stdout += data })
			child.stderr!.on("data", (data) => { stderr += data })
			const [exitCode, signal] = await once(child, "close")
			assert.equal(exitCode, 0, stderr)
			assert.equal(signal, null)
			assert.equal(stdout.trim(), "preset-ok")
			if (writable) assert.equal(await readFile(outputPath, "utf8"), "built")
		})
	}
})
