import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { LINUX_SELECTED_READABLE_BASELINE as enforcedLinuxBaseline } from "./linuxPolicy"
import { canonicalSandboxPath, LINUX_SELECTED_READABLE_BASELINE, MACOS_SELECTED_READABLE_BASELINE, requireSandboxTaskHost, sandboxPathContains, sandboxPlatformPolicy } from "./platformPolicy"

describe("explicit sandbox platform policy semantics", () => {
	it("uses exactly the enforcement Linux runtime baseline", () => {
		assert.deepEqual(LINUX_SELECTED_READABLE_BASELINE, enforcedLinuxBaseline)
		assert.equal(sandboxPlatformPolicy("linux", "x64").temporaryStorage, "private-tmpfs")
		assert.equal(sandboxPlatformPolicy("darwin", "arm64").temporaryStorage, "private-host-directory")
		assert.ok(!MACOS_SELECTED_READABLE_BASELINE.includes("/private/etc"))
		assert.ok(!MACOS_SELECTED_READABLE_BASELINE.some((p) => p.includes("home") || p.includes("ssh")))
	})
	it("does not guess case/alias semantics for task authority or use a POSIX canonicalizer on Windows", () => {
		assert.throws(() => requireSandboxTaskHost("darwin", "arm64"), /path identity.*not validated/)
		assert.throws(() => requireSandboxTaskHost("linux", "arm64"), /unsupported/)
		assert.throws(() => canonicalSandboxPath("C:\\work", "linux"), /execution host/)
		if (process.platform !== "win32") assert.throws(() => canonicalSandboxPath("C:\\work", "win32"), /native execution host/)
	})
	it("compares explicit ASCII Windows drive boundaries case-insensitively without sibling-prefix confusion", () => {
		assert.equal(sandboxPathContains("C:\\Work", "c:/work/child", "win32"), true)
		assert.equal(sandboxPathContains("C:\\", "c:\\work", "win32"), true)
		assert.equal(sandboxPathContains("C:\\work", "C:\\work-other", "win32"), false)
		assert.equal(sandboxPathContains("C:\\work", "D:\\work", "win32"), false)
		assert.throws(() => sandboxPathContains("\\\\server\\share", "C:\\work", "win32"), /unsupported/i)
		assert.equal(sandboxPathContains("/Work", "/work/child", "darwin"), false)
	})
})
