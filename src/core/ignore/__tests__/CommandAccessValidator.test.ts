import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { findBlockedCommandArgument } from "../CommandAccessValidator"

// Deny exactly one file; everything else is allowed.
const deny = (blocked: string) => (filePath: string) => filePath !== blocked

describe("findBlockedCommandArgument", () => {
	it("ignores commands that do not read files", () => {
		assert.equal(findBlockedCommandArgument("ls secret.txt", deny("secret.txt")), undefined)
	})

	it("blocks a relative path argument", () => {
		assert.equal(findBlockedCommandArgument("cat secret.txt", deny("secret.txt")), "secret.txt")
	})

	it("does not block an allowed argument", () => {
		assert.equal(findBlockedCommandArgument("cat public.txt", deny("secret.txt")), undefined)
	})

	// Regression: any argument containing a colon was classified as a PowerShell parameter
	// name, so every drive-qualified Windows path skipped access validation entirely.
	it("blocks a drive-qualified Windows path", () => {
		assert.equal(findBlockedCommandArgument("type C:\\repo\\.env", deny("C:\\repo\\.env")), "C:\\repo\\.env")
		assert.equal(findBlockedCommandArgument("cat d:/repo/.env", deny("d:/repo/.env")), "d:/repo/.env")
	})

	it("still skips PowerShell parameters and provider drives", () => {
		// Multi-character provider drives stay excluded; single-letter drives do not.
		assert.equal(findBlockedCommandArgument("gc Env:PATH", deny("Env:PATH")), undefined)
		assert.equal(findBlockedCommandArgument("select-string -Pattern:secret x.txt", deny("-Pattern:secret")), undefined)
	})

	it("skips flags", () => {
		assert.equal(findBlockedCommandArgument("grep -n secret.txt", deny("-n")), undefined)
	})

	// Regression: a leading "/" was treated as a flag on every platform, so absolute POSIX
	// paths skipped validation too.
	it("classifies a leading slash per platform", () => {
		const result = findBlockedCommandArgument("cat /etc/secret", deny("/etc/secret"))
		if (process.platform === "win32") {
			assert.equal(result, undefined) // cmd/PowerShell switch
		} else {
			assert.equal(result, "/etc/secret") // absolute path
		}
	})
})
