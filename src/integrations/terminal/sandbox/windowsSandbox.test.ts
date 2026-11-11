import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import type { NativeSandboxRequest } from "./types"
import { NativeSandboxError } from "./types"
import {
	translateWindowsPolicy,
	windowsPolicyPath,
	windowsTemporaryParent,
	WINDOWS_MXC_HELPER_VERSION,
	WINDOWS_MXC_PROTOCOL,
	WINDOWS_MXC_REVISION,
} from "./windowsPolicy"
import { validateWindowsMxcProbe, WindowsMxcProtocol } from "./windowsSandbox"

const host = {
	SystemRoot: "C:\\Windows",
	SystemDrive: "C:",
	LocalAppData: "C:\\Users\\test\\AppData\\Local",
	ProgramFiles: "C:\\Program Files",
	SECRET: "not inherited",
	PATH: "C:\\host-bin",
	FOO: "host",
}
function request(): NativeSandboxRequest {
	const policy: CustomSandboxProfile = {
		id: "custom",
		kind: "custom",
		revision: 1,
		name: "Selected",
		description: "",
		filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], caches: [], blocked: [] },
		temporaryDirectory: "C:\\Temp",
		network: "deny",
		environment: { passthrough: ["Path", "FOO"], overrides: { COLOR: "yes" } },
	}
	return {
		executable: "C:\\Windows\\System32\\cmd.exe",
		args: ["/d", "/c", "echo done"],
		cwd: "C:\\work",
		env: { PATH: "C:\\command-bin", FOO: "command" },
		policy,
		context: { workspaceRoots: ["C:\\work"], protectedPaths: ["C:\\Users\\test\\.dirac"] },
	}
}
function profile(r: NativeSandboxRequest): CustomSandboxProfile {
	return r.policy as CustomSandboxProfile
}
const compile = (r = request()) => translateWindowsPolicy(r, "C:\\Temp\\dirac-mxc-unique", host)
const frame = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n")

describe("Windows native MXC policy (portable, no native enforcement claim)", () => {
	it("uses selected grants, protected denies, host runtime and explicit case-insensitive workload environment", () => {
		const p = compile()
		assert.ok(p.readonlyPaths.includes("C:\\Windows"))
		assert.ok(p.readwritePaths.includes("C:\\work"))
		assert.ok(p.deniedPaths.includes("C:\\Users\\test\\.dirac"))
		assert.equal(p.environment.PATH, "C:\\command-bin")
		assert.equal(p.environment.FOO, "command")
		assert.equal(p.environment.SECRET, undefined)
		assert.equal(p.environment.LOCALAPPDATA, host.LocalAppData)
		assert.equal(p.environment.TEMP, "C:\\Temp\\dirac-mxc-unique")
		assert.equal(p.environment.TMP, p.environment.TEMP)
		assert.equal(p.environment.TMPDIR, p.environment.TEMP)
	})
	it("rejects Default, broad-read and ambiguous/root/alias/device paths without fallback", () => {
		const r = request()
		r.policy = { id: "default" }
		assert.throws(
			() => compile(r),
			(e: unknown) => e instanceof NativeSandboxError && !e.fallbackEligible,
		)
		const broad = request()
		profile(broad).filesystem.base = "broad-read"
		assert.throws(() => compile(broad), /selected-location/)
		for (const path of [
			"C:\\",
			"C:relative",
			"\\\\server\\share",
			"\\\\?\\C:\\work",
			"C:\\work\\..\\secret",
			"C:\\work\\file:stream",
			"C:\\PROGRA~1",
			"C:\\work. ",
			"C:\\CON.txt",
			"C:\\é",
		])
			assert.throws(() => windowsPolicyPath(path), path)
		assert.equal(windowsPolicyPath("c:/work/sub"), "c:\\work\\sub")
	})
	it("rejects nested read-only and deny reopening rather than flattening precedence", () => {
		const ro = request()
		profile(ro).filesystem.readable = ["C:\\work\\readonly"]
		assert.throws(() => compile(ro), /read-only grant nested/)
		const deny = request()
		profile(deny).filesystem.blocked = ["C:\\blocked"]
		profile(deny).filesystem.writable = ["C:\\blocked\\reopened"]
		assert.throws(() => compile(deny), /conflicts/)
	})
	it("validates internal helper denies before resolving more-specific grants", () => {
		const r = request()
		profile(r).filesystem.writable.push("C:\\install\\native\\windows-mxc\\x64\\reopened")
		assert.throws(
			() => translateWindowsPolicy(r, "C:\\Temp\\dirac-mxc-unique", host, ["C:\\install\\native\\windows-mxc\\x64"]),
			/conflicts/,
		)
	})
	it("rejects overlapping/sibling-visible temporary storage and custom POSIX temp", () => {
		const r = request()
		profile(r).temporaryDirectory = "C:\\work\\temp"
		assert.throws(() => compile(r), /temporary storage must not overlap/)
		profile(r).temporaryDirectory = "/tmp"
		assert.throws(() => windowsTemporaryParent(r), /drive-absolute/)
	})
	it("rejects environment case collisions and SDK-owned overrides", () => {
		const duplicate = request()
		profile(duplicate).environment.passthrough = ["Path", "PATH"]
		assert.throws(() => compile(duplicate), /case-insensitive duplicates/)
		const override = request()
		profile(override).environment.overrides = { localappdata: "C:\\attacker" }
		assert.throws(() => compile(override), /cannot be overridden/)
		const workload = request()
		workload.env = { FOO: "one", foo: "two" }
		assert.throws(() => compile(workload), /case-insensitive duplicate/)
	})
})

describe("Windows MXC trusted control protocol", () => {
	it("keeps workload control-like bytes separate and preserves workload failure vs helper success", () => {
		const output: Buffer[] = []
		const p = new WindowsMxcProtocol((_stream, bytes) => output.push(bytes))
		p.append(frame({ type: "started", pid: 42 }))
		const fake = Buffer.from('{"type":"settled","exitCode":0}\n')
		const encoded = frame({ type: "stdout", data: fake.toString("base64") })
		for (const byte of encoded) p.append(Buffer.from([byte]))
		p.append(frame({ type: "settled", exitCode: 7, cancelled: false }))
		assert.deepEqual(p.finish(), { exitCode: 7, cancelled: false })
		assert.deepEqual(Buffer.concat(output), fake)
		assert.throws(() => p.append(frame({ type: "started", pid: 2 })), /sequence/)
	})
	it("fails closed on malformed, oversized, incomplete, duplicate and out-of-order control", () => {
		for (const value of [
			{ type: "stdout", data: "eA==" },
			{ type: "settled", exitCode: 0, cancelled: false },
			{ type: "failure", code: "native-helper-failed" },
			{ type: "started", pid: 1, extra: true },
		])
			assert.throws(() => new WindowsMxcProtocol(() => undefined).append(frame(value)))
		assert.throws(
			() => new WindowsMxcProtocol(() => undefined).append(Buffer.from("invalid\n")),
			(e: unknown) => e instanceof NativeSandboxError && e.stage === "execution-uncertain",
		)
		assert.throws(() => new WindowsMxcProtocol(() => undefined).append(Buffer.alloc(65537, "x")), /bound/)
		assert.throws(() => new WindowsMxcProtocol(() => undefined).finish(), /settlement proof/)
		const duplicate = new WindowsMxcProtocol(() => undefined)
		duplicate.append(frame({ type: "started", pid: 1 }))
		assert.throws(() => duplicate.append(frame({ type: "started", pid: 1 })))
		assert.throws(() => duplicate.append(frame({ type: "stdout", data: "%%%" })), /encoding/)
	})
	it("requires exact version, source revision, features and native FS_DENY", () => {
		const valid = {
			protocol: WINDOWS_MXC_PROTOCOL,
			version: WINDOWS_MXC_HELPER_VERSION,
			revision: WINDOWS_MXC_REVISION,
			native: true,
			fsDeny: true,
			networkIngress: false,
			features: ["native-psec", "fs-deny", "self-job", "framed-output"],
		}
		assert.deepEqual(validateWindowsMxcProbe(valid), { networkIngress: false })
		for (const change of [
			{ protocol: 2 },
			{ revision: "other" },
			{ fsDeny: false },
			{ native: false },
			{ features: [...valid.features, "fallback"] },
			{ unknown: true },
		])
			assert.throws(() => validateWindowsMxcProbe({ ...valid, ...change }))
	})
	it("structurally pins native-only ordering and noninheritable self-job ownership", () => {
		const source = readFileSync(resolve("native/windows-mxc/src/native.rs"), "utf8")
		assert.ok(source.indexOf("let outer_job = own_helper()?") < source.indexOf("BaseContainerRunner::new()"))
		assert.match(source, /CreateJobObjectW\(std::ptr::null\(\), std::ptr::null\(\)\)/)
		assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
		assert.match(source, /AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/)
		assert.match(source, /allow_dacl_mutation: false/)
		assert.match(source, /FILE_FLAG_OPEN_REPARSE_POINT/)
		assert.match(source, /GetFinalPathNameByHandleW/)
		assert.ok(!source.includes("CREATE_BREAKAWAY_FROM_JOB"))
		assert.ok(!source.includes("dispatcher::"))
		assert.ok(source.indexOf("drop(child)") < source.indexOf('"type":"settled"'))
	})
})
