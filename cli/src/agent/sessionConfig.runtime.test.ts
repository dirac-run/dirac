import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DiracAcpSession } from "./public-types.js"
import { SessionConfigManager } from "./sessionConfig.js"

const stateManagerMock = vi.hoisted(() => {
	return {
		captureEffectiveTaskConfiguration: vi.fn((explicitOverrides: Partial<Settings>) => ({
			apiConfiguration: structuredClone(explicitOverrides),
		})),
		getModelInfo: vi.fn(() => undefined),
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => stateManagerMock },
}))

const refreshGithubCopilotModelsMock = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock("@/core/controller/models/refreshGithubCopilotModels", () => ({
	refreshGithubCopilotModels: refreshGithubCopilotModelsMock,
}))

const refreshOpenRouterModelsMock = vi.hoisted(() => vi.fn())

vi.mock("@/core/controller/models/refreshOpenRouterModels", () => ({
	refreshOpenRouterModels: refreshOpenRouterModelsMock,
}))

const dynamicOpenRouterModelId = "xiaomi/mimo-v2.5-pro"
const dynamicOpenRouterModelInfo: ModelInfo = {
	name: "MiMo V2.5 Pro",
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	inputPrice: 0.15,
	outputPrice: 0.6,
	supportsPromptCache: false,
	supportsReasoning: true,
	supportsTools: true,
}

function session(mode: "act" | "plan" = "act"): DiracAcpSession {
	return {
		sessionId: "session-1",
		cwd: "/workspace",
		mode,
		createdAt: 1,
		lastActivityAt: 1,
	}
}

function linkedDeepSeekRuntime(): Partial<Settings> {
	return {
		mode: "act",
		planActSeparateModelsSetting: false,
		planModeApiProvider: "deepseek",
		actModeApiProvider: "deepseek",
		planModeApiModelId: "deepseek-v4-flash",
		actModeApiModelId: "deepseek-v4-flash",
		planModeReasoningEffort: "medium",
		actModeReasoningEffort: "medium",
		planModeThinkingBudgetTokens: 0,
		actModeThinkingBudgetTokens: 0,
	}
}

function selectOption(options: Awaited<ReturnType<SessionConfigManager["getSessionConfigOptions"]>>, id: string) {
	return options.find((option) => option.id === id) as Extract<(typeof options)[number], { type: "select" }>
}

function optionValues(option: ReturnType<typeof selectOption>): string[] {
	return option.options.flatMap((entry) =>
		"value" in entry ? [entry.value] : entry.options.map((groupedOption) => groupedOption.value),
	)
}

describe("SessionConfigManager task runtime behavior", () => {
	beforeEach(() => {
		refreshGithubCopilotModelsMock.mockClear()
		refreshGithubCopilotModelsMock.mockResolvedValue({})
		refreshOpenRouterModelsMock.mockReset()
		refreshOpenRouterModelsMock.mockResolvedValue({ [dynamicOpenRouterModelId]: dynamicOpenRouterModelInfo })
	})

	it("updates both modes only when the task snapshot links their models", async () => {
		const manager = new SessionConfigManager()
		const linked = linkedDeepSeekRuntime()
		await manager.applyModelConfigOption(session(), "deepseek-v4-pro", linked)
		expect(linked.actModeApiModelId).toBe("deepseek-v4-pro")
		expect(linked.planModeApiModelId).toBe("deepseek-v4-pro")

		const separate = { ...linkedDeepSeekRuntime(), planActSeparateModelsSetting: true }
		await manager.applyModelConfigOption(session(), "deepseek-v4-pro", separate)
		expect(separate.actModeApiModelId).toBe("deepseek-v4-pro")
		expect(separate.planModeApiModelId).toBe("deepseek-v4-flash")
	})

	it("clears stale model metadata when an advertised model is selected", async () => {
		const manager = new SessionConfigManager()
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "openai",
			actModeApiProvider: "openai",
			planModeOpenAiModelId: "old-model",
			actModeOpenAiModelId: "old-model",
			planModeOpenAiModelInfo: openAiModelInfoSaneDefaults,
			actModeOpenAiModelInfo: openAiModelInfoSaneDefaults,
		}
		const model = selectOption(await manager.getSessionConfigOptions(session(), runtime), "model")
		const replacement = optionValues(model).find((value) => value !== "old-model")!

		await manager.applyModelConfigOption(session(), replacement, runtime)

		expect(runtime.planModeOpenAiModelId).toBe(replacement)
		expect(runtime.actModeOpenAiModelId).toBe(replacement)
		expect(runtime.planModeOpenAiModelInfo).toBeUndefined()
		expect(runtime.actModeOpenAiModelInfo).toBeUndefined()
	})

	it("retains complete metadata for a dynamically selected OpenRouter model", async () => {
		const manager = new SessionConfigManager()
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "openrouter",
			actModeApiProvider: "openrouter",
			planModeOpenRouterModelId: "old/model",
			actModeOpenRouterModelId: "old/model",
			planModeOpenRouterModelInfo: { contextWindow: 1, supportsPromptCache: false },
			actModeOpenRouterModelInfo: { contextWindow: 1, supportsPromptCache: false },
		}

		await manager.applyModelConfigOption(session(), dynamicOpenRouterModelId, runtime)

		expect(runtime.actModeOpenRouterModelId).toBe(dynamicOpenRouterModelId)
		expect(runtime.planModeOpenRouterModelId).toBe(dynamicOpenRouterModelId)
		expect(runtime.actModeOpenRouterModelInfo).toEqual(dynamicOpenRouterModelInfo)
		expect(runtime.planModeOpenRouterModelInfo).toEqual(dynamicOpenRouterModelInfo)
		expect(runtime.actModeOpenRouterModelInfo).toMatchObject({
			contextWindow: 1_048_576,
			inputPrice: 0.15,
			outputPrice: 0.6,
		})
	})

	it("normalizes a removed historical model to the provider default", async () => {
		const manager = new SessionConfigManager()
		const runtime = linkedDeepSeekRuntime()
		runtime.actModeApiModelId = "removed-deepseek-model"

		const options = await manager.getSessionConfigOptions(session(), runtime)
		const model = selectOption(options, "model")
		expect(model.currentValue).toBe("deepseek-v4-flash")
		expect(optionValues(model)).not.toContain("removed-deepseek-model")
		expect(runtime.actModeApiModelId).toBe("deepseek-v4-flash")
		await expect(manager.assertTaskRuntimeAvailable(session(), runtime)).resolves.toBeUndefined()
	})

	it("never advertises an OpenAI model while DeepSeek is active", async () => {
		const manager = new SessionConfigManager()
		const runtime = linkedDeepSeekRuntime()
		runtime.actModeApiModelId = "gpt-5.6-sol"

		const options = await manager.getSessionConfigOptions(session(), runtime)
		const model = selectOption(options, "model")
		expect(model.currentValue).toBe("deepseek-v4-flash")
		expect(optionValues(model)).not.toContain("gpt-5.6-sol")
	})

	it("preserves a model shared by the old and new providers", async () => {
		const manager = new SessionConfigManager()
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "anthropic",
			actModeApiProvider: "anthropic",
			planModeApiModelId: "claude-sonnet-5",
			actModeApiModelId: "claude-sonnet-5",
		}

		await manager.applyProviderConfigOption(session(), "claude-code", runtime)

		expect(runtime.actModeApiProvider).toBe("claude-code")
		expect(runtime.actModeApiModelId).toBe("claude-sonnet-5")
	})

	it("selects the new provider default when the current model is incompatible", async () => {
		const manager = new SessionConfigManager()
		const runtime = linkedDeepSeekRuntime()

		await manager.applyProviderConfigOption(session(), "openai-native", runtime)

		expect(runtime.actModeApiProvider).toBe("openai-native")
		expect(runtime.actModeApiModelId).toBe("gpt-6-astra")
	})

	it("does not carry a source model into a permissive target provider catalog", async () => {
		const manager = new SessionConfigManager()
		const runtime = linkedDeepSeekRuntime()

		await manager.applyProviderConfigOption(session(), "openai", runtime)

		expect(runtime.actModeApiProvider).toBe("openai")
		expect(runtime.actModeOpenAiModelId).not.toBe("deepseek-v4-flash")
	})

	it("rejects an incompatible direct model request without mutation", async () => {
		const manager = new SessionConfigManager()
		const runtime = linkedDeepSeekRuntime()
		const before = structuredClone(runtime)

		await expect(manager.applyModelConfigOption(session(), "gpt-5.6-sol", runtime)).rejects.toThrow(
			"Model gpt-5.6-sol is unavailable for provider deepseek",
		)
		expect(runtime).toEqual(before)
	})

	it("preserves an active custom Bedrock model and clears custom metadata when a standard model is selected", async () => {
		const manager = new SessionConfigManager()
		const customModelId = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/custom"
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "bedrock",
			actModeApiProvider: "bedrock",
			planModeApiModelId: customModelId,
			actModeApiModelId: customModelId,
			planModeAwsBedrockCustomSelected: true,
			actModeAwsBedrockCustomSelected: true,
			planModeAwsBedrockCustomModelBaseId: "anthropic.claude-sonnet-4-6",
			actModeAwsBedrockCustomModelBaseId: "anthropic.claude-sonnet-4-6",
		}

		const model = selectOption(await manager.getSessionConfigOptions(session(), runtime), "model")
		expect(model.currentValue).toBe(customModelId)
		expect(optionValues(model)).toContain(customModelId)

		const standardModelId = optionValues(model).find((modelId) => modelId !== customModelId)!
		await manager.applyModelConfigOption(session(), standardModelId, runtime)

		expect(runtime.actModeApiModelId).toBe(standardModelId)
		expect(runtime.planModeApiModelId).toBe(standardModelId)
		expect(runtime.actModeAwsBedrockCustomSelected).toBe(false)
		expect(runtime.planModeAwsBedrockCustomSelected).toBe(false)
		expect(runtime.actModeAwsBedrockCustomModelBaseId).toBeUndefined()
		expect(runtime.planModeAwsBedrockCustomModelBaseId).toBeUndefined()
	})

	it("keeps OpenRouter selectable before its dynamic catalog is loaded", async () => {
		const manager = new SessionConfigManager()
		const provider = selectOption(await manager.getSessionConfigOptions(session(), linkedDeepSeekRuntime()), "provider")

		expect(optionValues(provider)).toContain("openrouter")
	})

	it("refreshes the active GitHub Copilot catalog once while building config options", async () => {
		refreshGithubCopilotModelsMock.mockResolvedValue({ "gpt-4o": openAiModelInfoSaneDefaults })
		const manager = new SessionConfigManager()
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "github-copilot",
			actModeApiProvider: "github-copilot",
			planModeApiModelId: "gpt-4o",
			actModeApiModelId: "gpt-4o",
		}

		await manager.getSessionConfigOptions(session(), runtime)

		expect(refreshGithubCopilotModelsMock).toHaveBeenCalledTimes(1)
	})

	it("removes a disabled provider and normalizes its active session", async () => {
		const providerConfiguration = {
			isProviderEnabled: vi.fn((provider: string) => provider !== "deepseek"),
			assertProviderEnabled: vi.fn((provider: string) => {
				if (provider === "deepseek") throw new Error("Provider deepseek is disabled")
			}),
		}
		const manager = new SessionConfigManager(providerConfiguration as never)
		const runtime = linkedDeepSeekRuntime()

		const options = await manager.getSessionConfigOptions(session(), runtime)
		const provider = selectOption(options, "provider")
		expect(provider.currentValue).not.toBe("deepseek")
		expect(optionValues(provider)).not.toContain("deepseek")
	})

	it("advertises, applies, and clears inference speed for supported models", async () => {
		const manager = new SessionConfigManager()
		const runtime: Partial<Settings> = {
			mode: "act",
			planActSeparateModelsSetting: false,
			planModeApiProvider: "openai-native",
			actModeApiProvider: "openai-native",
			planModeApiModelId: "gpt-5.4",
			actModeApiModelId: "gpt-5.4",
		}

		const speed = selectOption(await manager.getSessionConfigOptions(session(), runtime), "inference_speed")
		expect(optionValues(speed)).toEqual(["default", "standard", "fast"])
		manager.applyInferenceSpeedConfigOption(session(), "fast", runtime)
		expect(runtime.planModeInferenceSpeed).toBe("fast")
		expect(runtime.actModeInferenceSpeed).toBe("fast")

		await manager.applyModelConfigOption(session(), "gpt-5.4-nano", runtime)
		expect(runtime.planModeInferenceSpeed).toBe("default")
		expect(runtime.actModeInferenceSpeed).toBe("default")
		const standardOnlySpeed = selectOption(await manager.getSessionConfigOptions(session(), runtime), "inference_speed")
		expect(optionValues(standardOnlySpeed)).toEqual(["default", "standard"])
		manager.applyInferenceSpeedConfigOption(session(), "standard", runtime)
		expect(runtime.planModeInferenceSpeed).toBe("standard")
		expect(runtime.actModeInferenceSpeed).toBe("standard")
	})

	it("uses standard ACP categories with provider before model", async () => {
		const options = await new SessionConfigManager().getSessionConfigOptions(session(), linkedDeepSeekRuntime())
		expect(options.map(({ id, category }) => [id, category])).toEqual([
			["mode", "mode"],
			["auto_approve", "mode"],
			["yolo", "mode"],
			["provider", "_provider"],
			["model", "model"],
			["reasoning_effort", "thought_level"],
			["thinking_budget", "thought_level"],
		])
		expect(options.findIndex((option) => option.id === "provider")).toBeLessThan(
			options.findIndex((option) => option.id === "model"),
		)
	})

	it("advertises independent Plan/Act, auto-approve, and YOLO values", async () => {
		const runtime = { ...linkedDeepSeekRuntime(), mode: "plan" as const, autoApproveAllToggled: false, yoloModeToggled: true }
		const options = await new SessionConfigManager().getSessionConfigOptions(session("act"), runtime)
		const mode = selectOption(options, "mode")
		expect(mode).toMatchObject({ type: "select", currentValue: "plan" })
		expect(optionValues(mode)).toEqual(["plan", "act"])
		expect(options.find((option) => option.id === "auto_approve")).toMatchObject({ type: "boolean", currentValue: false })
		expect(options.find((option) => option.id === "yolo")).toMatchObject({ type: "boolean", currentValue: true })
	})

	it("includes 65,536 tokens tier in thinking budget options", async () => {
		const options = await new SessionConfigManager().getSessionConfigOptions(session(), linkedDeepSeekRuntime())
		const thinkingOption = selectOption(options, "thinking_budget")
		expect(optionValues(thinkingOption)).toContain("65536")
	})

	it("clamps thinking budget when switching to a model with lower limits", async () => {
		const manager = new SessionConfigManager()
		const s = session("act")
		const runtime: Partial<Settings> = {
			...linkedDeepSeekRuntime(),
			actModeApiProvider: "anthropic",
			actModeThinkingBudgetTokens: 65536,
		}
		// Apply a model with 8192 max tokens
		await manager.applyModelConfigOption(s, "claude-haiku-4-5-20251001", runtime)
		expect(runtime.actModeThinkingBudgetTokens).toBeLessThanOrEqual(63999)
	})
})
