import assert from "node:assert/strict"
import { once } from "node:events"
import fs from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import { after, before, describe, it } from "mocha"
import sinon from "sinon"
import { prepareNativeSandbox, probeNativeSandbox } from "./nativeSandbox"
import type { NativeSandboxRequest } from "./types"

let base: string
const at = (name: string) => path.join(base, name)
function profile(): CustomSandboxProfile {
	return {
		id: "test",
		revision: 1,
		name: "Test",
		description: "",
		kind: "custom",
		filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory: "/tmp",
		network: "deny",
		environment: { passthrough: [], overrides: {} },
	}
}
function request(policy: CustomSandboxProfile, code: string): NativeSandboxRequest {
	return {
		executable: "/usr/bin/python3",
		args: ["-c", code],
		cwd: at("work"),
		env: process.env,
		policy,
		context: { workspaceRoots: [at("work"), at("second")], protectedPaths: [at("state")] },
	}
}
async function run(input: NativeSandboxRequest) {
	const prepared = await prepareNativeSandbox(input)
	const child = prepared.spawn()
	let out = "",
		err = ""
	child.stdout!.on("data", (data) => {
		out += data
	})
	child.stderr!.on("data", (data) => {
		err += data
	})
	const [code, signal] = await once(child, "close")
	assert.equal(code, 0, err)
	assert.equal(signal, null)
	return out.trim()
}
const py = (value: string) => JSON.stringify(value)

describe("Linux x64 restrictive native policies", function () {
	this.timeout(15000)
	before(async function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const capability = await probeNativeSandbox()
		if (!capability.available) {
			console.warn(capability.error.message)
			this.skip()
		}
		base = await mkdtemp(path.join("/var/tmp", "dirac-policy-"))
		for (const name of ["work", "second", "read", "cache", "state", "blocked"]) await mkdir(at(name))
		await writeFile(at("read/input"), "visible")
		await writeFile(at("state/globalState.json"), "trusted")
		await writeFile(at("work/secret"), "secret")
		await symlink(at("state"), at("work/state-alias"))
	})
	after(async () => {
		if (base) await rm(base, { recursive: true, force: true })
	})

	it("enforces both workspace roots, extra RO/cache grants, protected aliases, blocks, and private temp", async () => {
		const policy = profile()
		policy.filesystem.readable = [at("read")]
		policy.filesystem.caches = [at("cache")]
		policy.filesystem.blocked = [at("work/secret")]
		assert.equal(
			await run(
				request(
					policy,
					`
import os
from pathlib import Path
assert Path(${py(at("read/input"))}).read_text() == 'visible'
for target in [${py(at("work/new"))},${py(at("second/new"))},${py(at("cache/new"))}]: Path(target).write_text('ok')
for target in [${py(at("read/input"))},${py(at("state/globalState.json"))},${py(at("work/state-alias/globalState.json"))}]:
 try: Path(target).write_text('bad'); raise AssertionError(target)
 except OSError: pass
try: assert Path(${py(at("work/secret"))}).read_text() == ''
except OSError: pass
Path('/tmp/private-marker').write_text('private')
assert os.environ['TMPDIR'] == '/tmp'
print('ok')`,
				),
			),
			"ok",
		)
		assert.equal(await readFile(at("state/globalState.json"), "utf8"), "trusted")
		await assert.rejects(readFile("/tmp/private-marker"), { code: "ENOENT" })
	})

	it("makes all workspace roots read-only and preserves broad readable host files", async () => {
		const policy = profile()
		policy.filesystem.base = "broad-read"
		policy.filesystem.workspace = "read-only"
		assert.equal(
			await run(
				request(
					policy,
					`
from pathlib import Path
assert Path('/etc/passwd').read_text()
for root in [${py(at("work"))},${py(at("second"))}]:
 try: Path(root+'/denied').write_text('bad'); raise AssertionError(root)
 except OSError: pass
try: Path(${py(at("state"))}).rename(${py(at("state-moved"))}); raise AssertionError('rename')
except OSError: pass
print('ok')`,
				),
			),
			"ok",
		)
	})

	it("passes only selected environment and overrides, without bootstrapping helper with workload loader vars", async () => {
		const policy = profile()
		policy.environment = { passthrough: ["VISIBLE"], overrides: { VISIBLE: "override", LD_PRELOAD: "/not/a/library" } }
		const input = request(
			policy,
			"import os; assert os.environ['VISIBLE']=='override'; assert 'SECRET' not in os.environ; assert os.environ['LD_PRELOAD']=='/not/a/library'; print('ok')",
		)
		input.env = { VISIBLE: "original", SECRET: "hidden", LD_PRELOAD: "/another/missing/library" }
		assert.equal(await run(input), "ok")
	})

	it("denies host loopback network but allows it when explicitly selected", async () => {
		const server = createServer((socket) => socket.end("ok"))
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		try {
			const address = server.address() as { port: number }
			for (const network of ["deny", "allow"] as const) {
				const policy = profile()
				policy.network = network
				assert.equal(
					await run(
						request(
							policy,
							`
import socket
try:
 s=socket.create_connection(('127.0.0.1',${address.port}),timeout=1); print(s.recv(2).decode()); s.close()
except OSError: print('denied')`,
						),
					),
					network === "deny" ? "denied" : "ok",
				)
			}
		} finally {
			server.close()
			await once(server, "close")
		}
	})

	it("uses private proc and denies namespace, mount and ptrace syscalls while allowing threads/fork", async () => {
		assert.equal(
			await run(
				request(
					profile(),
					`
import os,ctypes,errno,threading
from pathlib import Path
assert not Path('/proc/${process.pid}').exists()
libc=ctypes.CDLL(None,use_errno=True)
for nr,args in [(101,[0,0,0,0]),(272,[0x10000000]),(165,[0,0,0,0,0]),(435,[0,0]),(430,[0,0])]:
 assert libc.syscall(nr,*args)==-1
 assert ctypes.get_errno() in (errno.EPERM,errno.ENOSYS)
t=threading.Thread(target=lambda: None);t.start();t.join()
pid=os.fork()
if pid==0: os._exit(0)
os.waitpid(pid,0)
assert 'Seccomp:\\t2' in Path('/proc/self/status').read_text()
print('ok')`,
				),
			),
			"ok",
		)
	})

	it("kills an x32 ABI syscall attempt instead of bypassing native rules", async () => {
		const prepared = await prepareNativeSandbox(
			request(
				profile(),
				"import ctypes,resource;resource.setrlimit(resource.RLIMIT_CORE,(0,0));ctypes.CDLL(None).syscall(0x40000027)",
			),
		)
		const child = prepared.spawn()
		child.stdout!.resume()
		child.stderr!.resume()
		assert.deepEqual(await once(child, "close"), [159, null])
	})

	it("rejects canonical conflicts, missing sources, reserved paths, protected RW ancestors, and grants under blocks", async () => {
		for (const mutate of [
			(p: CustomSandboxProfile) => {
				p.filesystem.writable = [base]
			},
			(p: CustomSandboxProfile) => {
				p.filesystem.writable = [at("work/state-alias")]
			},
			(p: CustomSandboxProfile) => {
				p.filesystem.readable = [at("missing")]
			},
			(p: CustomSandboxProfile) => {
				p.filesystem.readable = ["/proc"]
			},
			(p: CustomSandboxProfile) => {
				p.filesystem.blocked = [at("work")]
			},
			(p: CustomSandboxProfile) => {
				p.filesystem.readable = [at("work")]
			},
		]) {
			const policy = profile()
			mutate(policy)
			await assert.rejects(
				prepareNativeSandbox(request(policy, "raise Exception('never')")),
				(error: { fallbackEligible: boolean }) => !error.fallbackEligible,
			)
		}
	})

	it("rejects an intermediate-symlink source swap to a protected directory", async () => {
		await mkdir(at("race/child"), { recursive: true })
		await mkdir(at("state/child"))
		const policy = profile()
		policy.filesystem.writable = [at("race/child")]
		const original = fs.openSync
		const stub = sinon.stub(fs, "openSync").callsFake(((source: fs.PathLike, flags: number) => {
			if (source === at("race/child")) {
				fs.renameSync(at("race"), at("race-old"))
				fs.symlinkSync(at("state"), at("race"))
			}
			return original(source, flags)
		}) as typeof fs.openSync)
		try {
			await assert.rejects(prepareNativeSandbox(request(policy, "print('never')")), /source identity changed/)
		} finally {
			stub.restore()
		}
	})

	it("releases all pinned descriptors after cancelled preparation and rejects later spawn", async () => {
		const count = async () => (await readdir("/proc/self/fd")).length
		const before = await count()
		const prepared = await prepareNativeSandbox(request(profile(), "print('never')"))
		assert.ok((await count()) > before)
		prepared.dispose()
		prepared.dispose()
		assert.equal(await count(), before)
		assert.throws(() => prepared.spawn(), /replay is forbidden/)
	})
})
