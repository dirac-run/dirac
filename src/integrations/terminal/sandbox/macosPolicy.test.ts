import assert from "node:assert/strict"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import { compileSeatbeltPolicy, prepareMacOSPolicy, seatbeltString } from "./macosPolicy"
import { NativeSandboxError, type NativeSandboxRequest } from "./types"

function fixture() {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dirac-mac-policy-")))
	const workspace = path.join(root, "workspace")
	const authority = path.join(root, "authority")
	const temporaryDirectory = path.join(root, "temp-parent")
	for (const value of [workspace, authority, temporaryDirectory]) mkdirSync(value)
	const profile: CustomSandboxProfile = {
		id: "test",
		revision: 1,
		kind: "custom",
		name: "Test",
		description: "",
		filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory,
		network: "deny",
		environment: { passthrough: ["PATH", "VISIBLE"], overrides: { FIXED: "value" } },
	}
	const request: NativeSandboxRequest = {
		executable: "/bin/sh",
		args: ["-c", "true"],
		cwd: workspace,
		env: { PATH: "/usr/bin:/bin", VISIBLE: "yes", SECRET: "not-passed", DYLD_INSERT_LIBRARIES: "/untrusted" },
		policy: profile,
		context: { workspaceRoots: [workspace], protectedPaths: [authority] },
	}
	return { root, workspace, authority, profile, request, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function ref(parameters: readonly string[], value: string) {
	const entry = parameters.find((p) => p.endsWith(`=${value}`))
	assert.ok(entry, `No parameter for ${value}`)
	return `(param "${entry.slice(0, entry.indexOf("="))}")`
}

const compilerInput = () => ({
	readable: ["/runtime", "/work/ro"],
	writable: ["/work", "/work/ro/cache"],
	blocked: ["/work/blocked"],
	protected: ["/work/config"],
	network: "deny" as const,
})

describe("macOS Seatbelt compiler (pure, not native enforcement)", () => {
	it("starts deny-default and never emits blanket IPC/network/default grants", () => {
		const { policy } = compileSeatbeltPolicy(compilerInput())
		assert.ok(policy.startsWith("(version 1)\n(deny default)\n"))
		assert.ok(policy.includes("(allow process-exec)\n(allow process-fork)"))
		assert.ok(policy.includes("file-map-executable"))
		assert.ok(policy.includes('(deny mach-lookup (xpc-service-name-prefix ""))'))
		assert.doesNotMatch(policy, /allow (?:default|network|mach|ipc|iokit)/)
	})

	it("uses named literal parameters rather than splicing path source or regexes", () => {
		const unusual = '/work/quote"; (allow default)'
		const compiled = compileSeatbeltPolicy({ ...compilerInput(), writable: [unusual] })
		assert.ok(compiled.parameters.some((p) => p.endsWith(`=${unusual}`)))
		assert.ok(!compiled.policy.includes(unusual))
		assert.ok(!compiled.policy.includes("regex"))
		assert.equal(seatbeltString('quote"slash\\'), '"quote\\"slash\\\\"')
		for (const value of ["/path\0", "/path\n", "/path\x7f"]) assert.throws(() => seatbeltString(value), NativeSandboxError)
	})

	it("excludes protected/blocked literal roots AND descendants in every grant", () => {
		const { policy, parameters } = compileSeatbeltPolicy(compilerInput())
		const grants = policy
			.split("\n")
			.filter((line) => line.startsWith("(allow file-read* file-map") || line.startsWith("(allow file-write*"))
		for (const value of ["/work/config", "/work/blocked"]) {
			const exclusion = `(require-not (require-any (literal ${ref(parameters, value)}) (subpath ${ref(parameters, value)})))`
			for (const grant of grants) assert.ok(grant.includes(exclusion), grant)
		}
	})

	it("preserves nested RO exceptions while reopening only explicit deeper writable grants", () => {
		const { policy, parameters } = compileSeatbeltPolicy(compilerInput())
		const writes = policy.split("\n").filter((line) => line.startsWith("(allow file-write*"))
		const ro = ref(parameters, "/work/ro")
		assert.ok(writes[0].includes(`(require-not (require-any (literal ${ro}) (subpath ${ro})))`))
		assert.ok(!writes[1].includes(`(require-not (require-any (literal ${ro})`))
	})

	it("guards every protected/RO/writable-directory ancestor against rename/replacement LAST", () => {
		const { policy, parameters } = compileSeatbeltPolicy(compilerInput())
		for (const value of ["/work/config", "/work/ro", "/work", "/work/ro/cache"]) {
			const guard = `(deny file-write-unlink (literal ${ref(parameters, value)}))`
			assert.ok(policy.includes(guard))
			assert.ok(policy.indexOf(guard) > policy.lastIndexOf("(allow "))
		}
	})

	it("uses literal-only positive file grants, never grants hypothetical child paths", () => {
		const compiled = compileSeatbeltPolicy({
			readable: [],
			writable: ["/one-file"],
			protected: [],
			blocked: [],
			directoryPaths: [],
			network: "deny",
		})
		const parameter = ref(compiled.parameters, "/one-file")
		const write = compiled.policy.split("\n").find((line) => line.startsWith("(allow file-write*"))!
		assert.ok(write.includes(`(literal ${parameter})`))
		assert.ok(!write.includes("subpath"))
		assert.ok(!compiled.policy.includes(`(deny file-write-unlink (literal ${parameter}))`))
	})

	it("final blocked-device denies cannot be reopened by fixed baseline allows", () => {
		const { policy, parameters } = compileSeatbeltPolicy({ ...compilerInput(), blocked: ["/dev/zero"] })
		const finalDeny = `(deny file-read* file-write* file-map-executable (require-any (literal ${ref(parameters, "/dev/zero")}) (subpath ${ref(parameters, "/dev/zero")})))`
		assert.ok(policy.indexOf(finalDeny) > policy.lastIndexOf("(allow "))
		assert.ok(policy.includes("(deny file-link)"))
	})

	it("network allow is IP-filtered; never silently grants UNIX sockets or Mach services", () => {
		const { policy } = compileSeatbeltPolicy({ ...compilerInput(), network: "allow" })
		assert.ok(policy.includes('(allow network-outbound (remote ip "*:*"))'))
		assert.ok(policy.includes('(allow network-inbound (local ip "*:*"))'))
		assert.ok(policy.includes('(allow network-bind (local ip "*:*"))'))
		assert.doesNotMatch(policy, /\(allow network\*|remote unix|allow mach/)
	})
})

describe("macOS policy preparation (Linux-local filesystem/env checks)", () => {
	it("creates unique mode0700 host-backed temp and filters environment; dispose is idempotent", () => {
		const f = fixture()
		try {
			const first = prepareMacOSPolicy(f.request, f.profile)
			const second = prepareMacOSPolicy(f.request, f.profile)
			assert.notEqual(first.temporaryDirectory, second.temporaryDirectory)
			assert.equal(statSync(first.temporaryDirectory).mode & 0o777, 0o700)
			assert.deepEqual(first.env, {
				PATH: "/usr/bin:/bin",
				VISIBLE: "yes",
				FIXED: "value",
				TMP: first.temporaryDirectory,
				TEMP: first.temporaryDirectory,
				TMPDIR: first.temporaryDirectory,
			})
			writeFileSync(path.join(first.temporaryDirectory, "host-visible"), "host-backed")
			assert.equal(readFileSync(path.join(first.temporaryDirectory, "host-visible"), "utf8"), "host-backed")
			first.dispose()
			first.dispose()
			assert.equal(existsSync(first.temporaryDirectory), false)
			assert.equal(existsSync(second.temporaryDirectory), true)
			second.dispose()
		} finally {
			f.cleanup()
		}
	})

	it("rejects explicitly requested loader-sensitive variables, without retaining temp resources", () => {
		const f = fixture()
		try {
			f.profile.environment.passthrough.push("DYLD_INSERT_LIBRARIES")
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /dynamic-loader/)
			f.profile.environment.passthrough.pop()
			f.profile.environment.overrides.LD_PRELOAD = "/inject"
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /dynamic-loader/)
		} finally {
			f.cleanup()
		}
	})

	it("rejects writable roots through mutable symlink components", () => {
		const f = fixture()
		try {
			const alias = path.join(f.root, "alias")
			symlinkSync(f.workspace, alias)
			f.request.context = { ...f.request.context!, workspaceRoots: [alias] }
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /mutable symlink/)
		} finally {
			f.cleanup()
		}
	})

	it("rejects writable-tree symlinks into runtime, blocked or protected authority", () => {
		for (const target of ["runtime", "protected", "readonly"]) {
			const f = fixture()
			try {
				const readonly = path.join(f.workspace, "readonly")
				mkdirSync(readonly)
				f.profile.filesystem.readable.push(readonly)
				symlinkSync(
					target === "runtime" ? "/usr" : target === "protected" ? f.authority : readonly,
					path.join(f.workspace, "escape"),
				)
				assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /outside writable authority/)
			} finally {
				f.cleanup()
			}
		}
	})

	it("supports nested protected roots by exclusions and guarded ancestors, never writable grant inside them", () => {
		const f = fixture()
		try {
			f.request.context = { workspaceRoots: [f.root], protectedPaths: [f.authority] }
			const prepared = prepareMacOSPolicy(f.request, f.profile)
			assert.ok(prepared.policy.includes("require-not"))
			prepared.dispose()
			f.profile.filesystem.writable.push(f.authority)
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /inside trusted configuration/)
		} finally {
			f.cleanup()
		}
	})

	it("revalidates dev/inode and canonical aliases at the single-use launch boundary", () => {
		const f = fixture()
		try {
			const prepared = prepareMacOSPolicy(f.request, f.profile)
			prepared.revalidate()
			renameSync(f.workspace, `${f.workspace}-old`)
			mkdirSync(f.workspace)
			assert.throws(() => prepared.revalidate(), /replaced after preparation/)
			prepared.dispose()
		} finally {
			f.cleanup()
		}
	})

	it("rejects blocked/protected temp parents, grant conflicts, missing roots and absent authority", () => {
		const f = fixture()
		try {
			f.profile.temporaryDirectory = f.authority
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /temporary directory parent/)
			f.profile.temporaryDirectory = path.join(f.root, "temp-parent")
			f.profile.filesystem.readable.push(f.workspace)
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /Conflicting/)
			f.profile.filesystem.readable = [path.join(f.root, "missing")]
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /must exist/)
			f.request.context = undefined
			assert.throws(() => prepareMacOSPolicy(f.request, f.profile), /trusted configuration/)
		} finally {
			f.cleanup()
		}
	})
})
