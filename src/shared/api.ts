import type { ApiHandlerSettings } from "./storage/state-keys"

// Re-export everything from the models sub-package for backward compatibility.
// All 50+ consumer files import from "@shared/api" — this barrel keeps them working.
export * from "./api/models"

/**
 * Strips the OpenRouter preset suffix from a model ID.
 * Example: "anthropic/claude-3.5-sonnet@preset/my-preset" -> "anthropic/claude-3.5-sonnet"
 * Example: "@preset/my-preset" -> ""
 */
export function stripOpenRouterPreset(modelId: string): string {
	const index = modelId.indexOf("@preset/")
	if (index !== -1) {
		return modelId.substring(0, index)
	}
	return modelId
}

export type ApiProvider =
	| "anthropic"
	| "claude-code"
	| "openrouter"
	| "bedrock"
	| "vertex"
	| "openai"
	| "lmstudio"
	| "gemini"
	| "openai-native"
	| "openai-codex"
	| "requesty"
	| "together"
	| "deepseek"
	| "qwen"
	| "qwen-code"
	| "doubao"
	| "mistral"
	| "github-copilot"
	| "vscode-lm"
	| "litellm"
	| "moonshot"
	| "nebius"
	| "fireworks"
	| "xai"
	| "sambanova"
	| "cerebras"
	| "groq"
	| "huggingface"
	| "huawei-cloud-maas"
	| "dify"
	| "baseten"
	| "vercel-ai-gateway"
	| "zai"
	| "oca"
	| "aihubmix"
	| "minimax"
	| "nousResearch"
	| "wandb"

export const ALL_PROVIDERS: ApiProvider[] = [
	"anthropic",
	"claude-code",
	"openrouter",
	"bedrock",
	"vertex",
	"openai",
	"lmstudio",
	"gemini",
	"openai-native",
	"openai-codex",
	"requesty",
	"together",
	"deepseek",
	"qwen",
	"qwen-code",
	"doubao",
	"mistral",
	"github-copilot",
	"vscode-lm",
	"litellm",
	"moonshot",
	"nebius",
	"fireworks",
	"xai",
	"sambanova",
	"cerebras",
	"groq",
	"huggingface",
	"huawei-cloud-maas",
	"dify",
	"baseten",
	"vercel-ai-gateway",
	"zai",
	"oca",
	"aihubmix",
	"minimax",
	"nousResearch",
	"wandb",
]

export const DEFAULT_API_PROVIDER = "openrouter" as ApiProvider

export interface ApiHandlerOptions extends Partial<ApiHandlerSettings> {
	apiProvider?: ApiProvider // Runtime provider selection (not persisted in settings)
	ulid?: string // Used to identify the task in API requests
	geminiSearchEnabled?: boolean
	/** Disables provider-level retries for one-shot sidecar operations. */
	disableRetries?: boolean

	onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: any) => void // Callback function
}

export type ApiConfiguration = ApiHandlerOptions

// ─────────────────────────────────────────────────────────────
// Model-to-provider registry
// ─────────────────────────────────────────────────────────────

import type { ModelInfo } from "./api/models"
import {
    anthropicModels,
    basetenModels,
    bedrockModels,
    cerebrasModels,
    claudeCodeModels,
    deepSeekModels,
    doubaoModels,
    fireworksModels,
    geminiModels,
    groqModels,
    huaweiCloudMaasModels,
    huggingFaceModels,
    internationalQwenModels,
    internationalZAiModels,
    mainlandQwenModels,
    mainlandZAiModels,
    minimaxModels,
    mistralModels,
    moonshotModels,
    nebiusModels,
    nousResearchModels,
    openAiCodexModels,
    openAiNativeModels,
    qwenCodeModels,
    sambanovaModels,
    vertexModels,
    wandbModels,
    xaiModels,
} from "./api/models"

/**
 * Central registry of all hardcoded model maps.
 * This is used as the single source of truth for model-to-provider mapping.
 */
export const ALL_MODEL_MAPS: [ApiProvider, Record<string, ModelInfo>][] = [
	["anthropic", anthropicModels],
	["claude-code", claudeCodeModels],
	["bedrock", bedrockModels],
	["vertex", vertexModels],
	["gemini", geminiModels],
	["openai-native", openAiNativeModels],
	["openai-codex", openAiCodexModels],
	["deepseek", deepSeekModels],
	["huggingface", huggingFaceModels],
	["qwen", internationalQwenModels],
	["qwen", mainlandQwenModels],
	["doubao", doubaoModels],
	["mistral", mistralModels],
	["nebius", nebiusModels],
	["wandb", wandbModels],
	["xai", xaiModels],
	["sambanova", sambanovaModels],
	["cerebras", cerebrasModels],
	["groq", groqModels],
	["moonshot", moonshotModels],
	["huawei-cloud-maas", huaweiCloudMaasModels],
	["baseten", basetenModels],
	["zai", internationalZAiModels],
	["zai", mainlandZAiModels],
	["fireworks", fireworksModels],
	["qwen-code", qwenCodeModels],
	["minimax", minimaxModels],
	["nousResearch", nousResearchModels],
]

/**
 * Gets the provider for a given model ID based on hardcoded model maps.
 */
export function getProviderForModel(modelId: string): ApiProvider | undefined {
	const baseModelId = stripOpenRouterPreset(modelId)
	for (const [provider, map] of ALL_MODEL_MAPS) {
		if (baseModelId && baseModelId in map) {
			return provider as ApiProvider
		}
	}
	return undefined
}

/**
 * Gets the model info for a given model ID based on hardcoded model maps.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
	const baseModelId = stripOpenRouterPreset(modelId)
	for (const [_, map] of ALL_MODEL_MAPS) {
		if (baseModelId && baseModelId in map) {
			return map[baseModelId]
		}
	}
	return undefined
}

const INFERENCE_SPEED_PROVIDERS = new Set<ApiProvider>(["anthropic", "openai-native", "openai-codex"])

export function getModelInfoForProvider(provider: ApiProvider, modelId: string): ModelInfo | undefined {
	const baseModelId = stripOpenRouterPreset(modelId)
	for (const [registeredProvider, map] of ALL_MODEL_MAPS) {
		if (registeredProvider === provider && baseModelId in map) return map[baseModelId]
	}
	return undefined
}

export function providerSupportsInferenceSpeed(provider: ApiProvider): boolean {
	return INFERENCE_SPEED_PROVIDERS.has(provider)
}

export function modelSupportsInferenceSpeed(provider: ApiProvider, modelId: string): boolean {
	return providerSupportsInferenceSpeed(provider) && getModelInfoForProvider(provider, modelId)?.supportsFastMode === true
}

/**
 * Clamps thinking budget tokens to valid provider and model constraints.
 * Ensures budget_tokens does not exceed maxBudget or maxTokens.
 */
export function clampThinkingBudget(budget: number | undefined, modelInfo?: ModelInfo, strictlyLessThanMax = false): number {
	if (!budget || budget <= 0) return 0
	if (!modelInfo) return budget
	const effectiveMax =
		modelInfo.thinkingConfig?.maxBudget ??
		(modelInfo.maxTokens ? (strictlyLessThanMax ? modelInfo.maxTokens - 1 : modelInfo.maxTokens) : undefined)
	if (!effectiveMax) return budget
	return Math.min(budget, effectiveMax)
}

