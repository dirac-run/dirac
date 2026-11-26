import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "mocha"
import { getQwenCachedCredentialPath } from "./qwenCodeCredentialPath"

describe("Qwen Code credential path", () => {
	it("finds subscription credentials under QWEN_HOME or the default home", () => {
		const prior = process.env.QWEN_HOME
		try {
			delete process.env.QWEN_HOME
			assert.equal(getQwenCachedCredentialPath(), path.join(os.homedir(), ".qwen", "subscription_credentials.json"))
			process.env.QWEN_HOME = "~/custom-qwen"
			assert.equal(getQwenCachedCredentialPath(""), path.join(os.homedir(), "custom-qwen", "subscription_credentials.json"))
		} finally {
			if (prior === undefined) delete process.env.QWEN_HOME
			else process.env.QWEN_HOME = prior
		}
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
