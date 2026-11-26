import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { qwenCodeDefaultModelId, qwenCodeModels } from "@shared/api"
import { getCachedQwenCodeModels, parseQwenCodeModels } from "../qwen-code-models"

const identity = { baseUrl: "https://auth.qwen.ai", clientId: "qwen-code-cli" }

describe("Qwen Subscription cached models", () => {
	let directory: string
	let file: string
	beforeEach(() => {
		directory = mkdtempSync(path.join(tmpdir(), "qwen-models-"))
		file = path.join(directory, "subscription_credentials.json")
	})
	afterEach(() => rmSync(directory, { recursive: true, force: true }))

	it("lists arbitrary account model IDs, projecting only public known capabilities", () => {
		const models = parseQwenCodeModels({
			...identity,
			models: ["qwen4-max", "account-model"],
			modelMetadata: [{ id: "account-model", modalities: { image: true }, contextWindowSize: 262144, tokens: "PRIVATE" }],
			tokens: { access_token: "PRIVATE", refresh_token: "PRIVATE" },
		})
		assert.deepEqual(Object.keys(models), ["qwen4-max", "account-model"])
		assert.equal(models["account-model"].contextWindow, 262144)
		assert.equal(models["account-model"].supportsImages, true)
		assert.equal(models["qwen4-max"].contextWindow, undefined)
		assert.equal(models["qwen4-max"].inputPrice, undefined)
		assert.equal(models["qwen4-max"].supportsReasoningEffort, undefined)
		assert.ok(!JSON.stringify(models).includes("PRIVATE"))
	})

	it("uses conservative updated fallback IDs only when discovery is absent", () => {
		assert.equal(qwenCodeDefaultModelId, "qwen3.8-max")
		assert.deepEqual(Object.keys(getCachedQwenCodeModels(file)), ["qwen3.8-max", "qwen4-max", "qwen3.8-flash"])
		writeFileSync(file, JSON.stringify(identity))
		assert.deepEqual(getCachedQwenCodeModels(file), qwenCodeModels)
		for (const info of Object.values(qwenCodeModels)) {
			assert.deepEqual(Object.keys(info).sort(), ["description", "supportsPromptCache"])
		}
	})

	it("does not invent malformed optional capabilities", () => {
		const models = parseQwenCodeModels({
			...identity, models: ["account-model"],
			modelMetadata: [{ id: "account-model", modalities: { image: "true" }, contextWindowSize: -1 }],
		})
		assert.equal(models["account-model"].supportsImages, undefined)
		assert.equal(models["account-model"].contextWindow, undefined)
	})

	it("rejects invalid IDs and a cache from a different identity without leaking diagnostics", () => {
		for (const value of [
			{ ...identity, models: ["PRIVATE\nMODEL"] },
			{ ...identity, models: ["__proto__"] },
			{ ...identity, models: [] },
			{ ...identity, baseUrl: "https://PRIVATE.example", models: ["x"] },
			{ ...identity, clientId: "PRIVATE", models: ["x"] },
			{ tokens: "PRIVATE" },
		]) {
			assert.throws(() => parseQwenCodeModels(value), (error: Error) => !error.message.includes("PRIVATE"))
		}
	})

	it("reads regular files without altering cached credentials", () => {
		const contents = JSON.stringify({ ...identity, models: ["account-model"], tokens: { access_token: "PRIVATE" } })
		writeFileSync(file, contents)
		assert.deepEqual(Object.keys(getCachedQwenCodeModels(file)), ["account-model"])
		assert.equal(readFileSync(file, "utf8"), contents)
	})

	it("refuses symlinks, directories, malformed JSON and oversized cache files", () => {
		const target = path.join(directory, "target.json")
		writeFileSync(target, JSON.stringify({ ...identity, models: ["PRIVATE"] }))
		symlinkSync(target, file)
		assert.throws(() => getCachedQwenCodeModels(file), /Unable to read/)
		assert.throws(() => getCachedQwenCodeModels(directory), /invalid or unreadable/)
		rmSync(file)
		writeFileSync(file, "{PRIVATE")
		assert.throws(() => getCachedQwenCodeModels(file), (error: Error) => !error.message.includes("PRIVATE"))
		writeFileSync(file, " ".repeat(1024 * 1024 + 1))
		assert.throws(() => getCachedQwenCodeModels(file), /invalid or unreadable/)
	})
})
