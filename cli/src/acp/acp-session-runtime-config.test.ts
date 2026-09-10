import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Settings } from "@shared/storage/state-keys"
import {
	copyTaskRuntimeSettings,
	deleteSessionRuntimeConfig,
	getSessionRuntimeConfig,
	setSessionRuntimeConfig,
	TASK_RUNTIME_SETTINGS_KEYS,
} from "./acp-session-runtime-config.js"

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dirac-acp-runtime-"))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

describe("ACP session runtime configuration", () => {
	it("copies complete mode-specific model state without provider infrastructure", () => {
		const modelInfo = { maxTokens: 8192, supportsPromptCache: false }
		const source = {
			mode: "act",
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "task-model",
			actModeOpenAiModelInfo: modelInfo,
			actModeOpenAiProfileName: "task-profile",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
			openAiBaseUrl: "https://provider.example/v1",
			openAiHeaders: { Authorization: "secret" },
			openAiCompatibleProfiles: [
				{
					name: "task-profile",
					baseUrl: "https://provider.example/v1",
					apiKey: "secret",
					modelId: "task-model",
					modelInfo,
				},
			],
			azureApiVersion: "infrastructure-protocol",
			requestTimeoutMs: 45_000,
		} satisfies Partial<Settings>

		const copied = copyTaskRuntimeSettings(source)
		modelInfo.maxTokens = 1

		expect(copied).toMatchObject({
			mode: "act",
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "task-model",
			actModeOpenAiModelInfo: { maxTokens: 8192 },
			actModeOpenAiProfileName: "task-profile",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
		})
		expect(copied.requestTimeoutMs).toBe(45_000)
		expect(copied).not.toHaveProperty("openAiBaseUrl")
		expect(copied).not.toHaveProperty("openAiHeaders")
		expect(copied).not.toHaveProperty("openAiCompatibleProfiles")
		expect(copied).not.toHaveProperty("azureApiVersion")
	})

	it("restores absent runtime keys as owned undefined values after restart", () => {
		const dataDir = temporaryDirectory()
		const sessionId = "session-with-undefined-runtime-values"

		setSessionRuntimeConfig(dataDir, sessionId, {
			settings: {
				mode: "act",
				actModeApiProvider: "deepseek",
				actModeApiModelId: "deepseek-flash",
			},
			cwd: "/workspace",
			createdAt: 123,
		})

		const restored = getSessionRuntimeConfig(dataDir, sessionId)
		expect(restored).toMatchObject({
			cwd: "/workspace",
			createdAt: 123,
			settings: {
				mode: "act",
				actModeApiProvider: "deepseek",
				actModeApiModelId: "deepseek-flash",
			},
		})
		for (const key of TASK_RUNTIME_SETTINGS_KEYS) {
			expect(Object.hasOwn(restored!.settings, key)).toBe(true)
		}
	})
	it("migrates legacy Anthropic Fast runtime settings and malformed speed values", () => {
		const copied = copyTaskRuntimeSettings({
			actModeApiProvider: "anthropic",
			actModeApiModelId: "claude-opus-4-8:1m:fast",
			planModeInferenceSpeed: "invalid" as never,
		})
		expect(copied.actModeApiModelId).toBe("claude-opus-4-8")
		expect(copied.actModeInferenceSpeed).toBe("fast")
		expect(copied.planModeInferenceSpeed).toBe("default")
	})

	it("stores sessions independently and reads the legacy aggregate format", () => {
		const dataDir = temporaryDirectory()
		setSessionRuntimeConfig(dataDir, "session-a", { settings: { mode: "act" } })
		setSessionRuntimeConfig(dataDir, "session-b", { settings: { mode: "plan" } })

		const runtimeDirectory = path.join(dataDir, "acp-session-runtime-configs")
		expect(fs.readdirSync(runtimeDirectory)).toHaveLength(2)
		expect(getSessionRuntimeConfig(dataDir, "session-a")?.settings.mode).toBe("act")
		expect(getSessionRuntimeConfig(dataDir, "session-b")?.settings.mode).toBe("plan")

		const legacySessionId = "legacy-session"
		fs.writeFileSync(
			path.join(dataDir, "acp-session-runtime-config.json"),
			JSON.stringify({
				[legacySessionId]: {
					version: 1,
					settings: { mode: "act", requestTimeoutMs: 12_000 },
					cwd: "/legacy-workspace",
				},
			}),
		)
		expect(getSessionRuntimeConfig(dataDir, legacySessionId)).toMatchObject({
			cwd: "/legacy-workspace",
			settings: { mode: "act", requestTimeoutMs: 12_000 },
		})
	})

	it("reports malformed and unsupported runtime records as recoverable configuration errors", () => {
		const dataDir = temporaryDirectory()
		const runtimeDirectory = path.join(dataDir, "acp-session-runtime-configs")
		fs.mkdirSync(runtimeDirectory, { recursive: true })

		fs.writeFileSync(path.join(runtimeDirectory, "malformed.json"), "{not-json")
		expect(() => getSessionRuntimeConfig(dataDir, "malformed")).toThrow("runtime configuration is malformed")

		fs.writeFileSync(
			path.join(runtimeDirectory, "future.json"),
			JSON.stringify({ version: 2, settings: { mode: "act" } }),
		)
		expect(() => getSessionRuntimeConfig(dataDir, "future")).toThrow("Unsupported ACP session runtime configuration version: 2")
	})


	it("deletes only the selected session runtime record", () => {
		const dataDir = temporaryDirectory()
		setSessionRuntimeConfig(dataDir, "session-a", { settings: { mode: "act" } })
		setSessionRuntimeConfig(dataDir, "session-b", { settings: { mode: "plan" } })

		deleteSessionRuntimeConfig(dataDir, "session-a")

		expect(getSessionRuntimeConfig(dataDir, "session-a")).toBeUndefined()
		expect(getSessionRuntimeConfig(dataDir, "session-b")?.settings.mode).toBe("plan")
	})
})
