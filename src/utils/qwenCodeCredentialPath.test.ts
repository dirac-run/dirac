import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "mocha"
import { getQwenCachedCredentialPath } from "./qwenCodeCredentialPath"

describe("Qwen Code credential path", () => {
	it("preserves the default OAuth file location", () => {
		assert.equal(getQwenCachedCredentialPath(), path.join(os.homedir(), ".qwen", "oauth_creds.json"))
		assert.equal(getQwenCachedCredentialPath(""), getQwenCachedCredentialPath())
	})

	it("preserves home-relative custom paths", () => {
		assert.equal(getQwenCachedCredentialPath("~/custom/oauth.json"), path.join(os.homedir(), "custom/oauth.json"))
	})

	it("preserves relative and absolute custom paths", () => {
		assert.equal(getQwenCachedCredentialPath("custom/oauth.json"), path.resolve("custom/oauth.json"))
		const absolute = path.resolve("custom/oauth.json")
		assert.equal(getQwenCachedCredentialPath(absolute), absolute)
	})
})
