import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchDynamicModels, getCustomModelLabel, getDefaultModelId, hasDynamicModels } from "./model-metadata"

const state = vi.hoisted(() => ({ credentialPath: "" }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getApiConfiguration: () => ({ qwenCodeOauthPath: state.credentialPath }) }) },
}))
vi.mock("@/core/controller/models/refreshGithubCopilotModels", () => ({ refreshGithubCopilotModels: vi.fn() }))
vi.mock("@/core/controller/models/refreshHuggingFaceModels", () => ({ getHuggingFaceModels: vi.fn() }))
vi.mock("@/core/controller/models/refreshOpenAiModels", () => ({ getOpenAiModels: vi.fn() }))
vi.mock("@/core/controller/models/refreshOpenRouterModels", () => ({ refreshOpenRouterModels: vi.fn() }))

let directory: string | undefined
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true })
	directory = undefined
})

describe("Qwen Subscription CLI model data", () => {
	it("loads cached account IDs from the configured local path", async () => {
		directory = mkdtempSync(path.join(tmpdir(), "qwen-cli-models-"))
		state.credentialPath = path.join(directory, "subscription_credentials.json")
		writeFileSync(state.credentialPath, JSON.stringify({
			baseUrl: "https://auth.qwen.ai",
			clientId: "qwen-code-cli",
			models: ["account-model"],
			modelMetadata: [{ id: "account-model", contextWindowSize: 262144 }],
		}))
		expect(hasDynamicModels("qwen-code")).toBe(true)
		const models = await fetchDynamicModels("qwen-code")
		expect(Object.keys(models)).toEqual(["account-model"])
		expect(models["account-model"]).toMatchObject({ contextWindow: 262144 })
	})

	it("offers an account ID entry and the updated conservative default", () => {
		expect(getCustomModelLabel("qwen-code")).toBe("Account Model ID")
		expect(getDefaultModelId("qwen-code")).toBe("qwen3.8-max")
	})
})
