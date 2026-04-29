import { ApiFormat } from "./proto/dirac/models"
import type { ApiHandlerSettings } from "./storage/state-keys"

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
	| "dirac"
	| "litellm"
	| "moonshot"
	| "nebius"
	| "fireworks"
	| "xai"
	| "sambanova"
	| "cerebras"
	| "sapaicore"
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
	| "hicap"
	| "nousResearch"
	| "wandb"
	| "firepass"

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
	"dirac",
	"litellm",
	"moonshot",
	"nebius",
	"fireworks",
	"xai",
	"sambanova",
	"cerebras",
	"sapaicore",
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
	"hicap",
	"nousResearch",
	"wandb",
	"firepass",
]

export const DEFAULT_API_PROVIDER = "openrouter" as ApiProvider

export interface ApiHandlerOptions extends Partial<ApiHandlerSettings> {
	ulid?: string // Used to identify the task in API requests
	geminiSearchEnabled?: boolean

	onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: any) => void // Callback function
}

export type ApiConfiguration = ApiHandlerOptions

// Models

interface PriceTier {
	tokenLimit: number // Upper limit (inclusive) of *input* tokens for this price. Use Infinity for the highest tier.
	price: number // Price per million tokens for this tier.
}

export interface ModelInfo {
	name?: string
	maxTokens?: number
	contextWindow?: number
	supportsImages?: boolean
	supportsPromptCache: boolean // this value is hardcoded for now
	supportsReasoning?: boolean // Whether the model supports reasoning/thinking mode
	inputPrice?: number // Keep for non-tiered input models
	outputPrice?: number // Keep for non-tiered output models
	thinkingConfig?: {
		maxBudget?: number // Max allowed thinking budget tokens
		outputPrice?: number // Output price per million tokens when budget > 0
		outputPriceTiers?: PriceTier[] // Optional: Tiered output price when budget > 0
		geminiThinkingLevel?: "low" | "high" // Optional: preset thinking level
		supportsThinkingLevel?: boolean // Whether the model supports thinking level (low/high)
	}
	supportsGlobalEndpoint?: boolean // Whether the model supports a global endpoint with Vertex AI
	cacheWritesPrice?: number
	cacheReadsPrice?: number
	description?: string
	tiers?: {
		contextWindow: number
		inputPrice?: number
		outputPrice?: number
		cacheWritesPrice?: number
		cacheReadsPrice?: number
	}[]
	temperature?: number
	supportsTools?: boolean

	apiFormat?: ApiFormat // The API format used by this model
}

export interface OpenAiCompatibleModelInfo extends ModelInfo {
	temperature?: number
	isR1FormatRequired?: boolean
	systemRole?: "developer" | "system"
	supportsReasoningEffort?: boolean
	supportsStreaming?: boolean
}

export interface OcaModelInfo extends OpenAiCompatibleModelInfo {
	modelName: string
	surveyId?: string
	banner?: string
	surveyContent?: string
	supportsReasoning?: boolean
	reasoningEffortOptions: string[]
}

export const CLAUDE_SONNET_1M_SUFFIX = ":1m"
export const ANTHROPIC_FAST_MODE_SUFFIX = ":fast"
export const CLAUDE_SONNET_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 3.0,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER, // storing infinity in vs storage is not possible, it converts to 'null', which causes crash in webview ModelInfoView
		inputPrice: 6,
		outputPrice: 22.5,
		cacheWritesPrice: 7.5,
		cacheReadsPrice: 0.6,
	},
]
export const CLAUDE_OPUS_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 5.0,
		outputPrice: 25,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10,
		outputPrice: 37.5,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_5_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 5.0,
		outputPrice: 30.0,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10.0,
		outputPrice: 45.0,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_4_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 2.5,
		outputPrice: 15.0,
		cacheReadsPrice: 0.25,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 5.0,
		outputPrice: 22.5,
		cacheReadsPrice: 0.5,
	},
]

export const GPT_5_4_PRO_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 30.0,
		outputPrice: 180.0,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 60.0,
		outputPrice: 270.0,
	},
]

export interface HicapCompatibleModelInfo extends ModelInfo {
	temperature?: number
}

export const hicapModelInfoSaneDefaults: HicapCompatibleModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	supportsTools: true,
	outputPrice: 0,
	temperature: 1,
}

// Anthropic
// https://docs.anthropic.com/en/docs/about-claude/models // prices updated 2025-01-02
export type AnthropicModelId = keyof typeof anthropicModels
export const anthropicDefaultModelId: AnthropicModelId = "claude-sonnet-4-6"
export const ANTHROPIC_MIN_THINKING_BUDGET = 1_024
export const ANTHROPIC_MAX_THINKING_BUDGET = 6_000
export const anthropicModels = {
	"claude-sonnet-4-6": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"claude-sonnet-4-6:1m": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"claude-haiku-4-5-20251001": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 1,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
	},
	"claude-opus-4-6": {
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"claude-opus-4-6:fast": {
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 30.0,
		outputPrice: 150.0,
		cacheWritesPrice: 37.5,
		cacheReadsPrice: 3.0,
		description:
			"Anthropic fast mode preview for Claude Opus 4.6. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
	},
	"claude-opus-4-7:1m": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"claude-opus-4-7:fast": {
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 30.0,
		outputPrice: 150.0,
		cacheWritesPrice: 37.5,
		cacheReadsPrice: 3.0,
		description:
			"Anthropic fast mode preview for Claude Opus 4.6. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
	},
	"claude-opus-4-6:1m": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"claude-opus-4-6:1m:fast": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 30.0,
		outputPrice: 150.0,
		cacheWritesPrice: 37.5,
		cacheReadsPrice: 3.0,
		description:
			"Anthropic fast mode preview for Claude Opus 4.6 with the 1M context beta enabled. Same model and capabilities with higher output token speed at premium pricing across the full 1M context window. Requires both fast mode and 1M context access on your Anthropic account.",
	},
} as const satisfies Record<string, ModelInfo> // as const assertion makes the object deeply readonly

// Claude Code
export type ClaudeCodeModelId = keyof typeof claudeCodeModels
export const claudeCodeDefaultModelId: ClaudeCodeModelId = "claude-sonnet-4-6"
export const claudeCodeModels = {
	opus: {
		...anthropicModels["claude-opus-4-6"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"opus[1m]": {
		...anthropicModels["claude-opus-4-6:1m"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-haiku-4-5-20251001": {
		...anthropicModels["claude-haiku-4-5-20251001"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-sonnet-4-6": {
		...anthropicModels["claude-sonnet-4-6"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-sonnet-4-6[1m]": {
		...anthropicModels["claude-sonnet-4-6:1m"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-6": {
		...anthropicModels["claude-opus-4-6"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-6[1m]": {
		...anthropicModels["claude-opus-4-6:1m"],
		supportsImages: false,
		supportsPromptCache: false,
	},
} as const satisfies Record<string, ModelInfo>

// AWS Bedrock
// https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
export type BedrockModelId = keyof typeof bedrockModels
export const bedrockDefaultModelId: BedrockModelId = "anthropic.claude-sonnet-4-6"
export const bedrockModels = {
	"anthropic.claude-sonnet-4-6": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"anthropic.claude-sonnet-4-6:1m": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-sonnet-4-5-20250929-v1:0:1m": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-haiku-4-5-20251001-v1:0": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 1,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
	},
	"anthropic.claude-sonnet-4-20250514-v1:0:1m": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-opus-4-6-v1": {
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"anthropic.claude-opus-4-6-v1:1m": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"openai.gpt-oss-120b-1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
		description:
			"A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
	},
	"openai.gpt-oss-20b-1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.3,
		description:
			"A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
	},
} as const satisfies Record<string, ModelInfo>

// OpenRouter
// https://openrouter.ai/models?order=newest&supported_parameters=tools
export const openRouterDefaultModelId = "anthropic/claude-sonnet-4.5" // will always exist in openRouterModels
export const openRouterClaudeSonnet41mModelId = `anthropic/claude-sonnet-4${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet451mModelId = `anthropic/claude-sonnet-4.5${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet461mModelId = `anthropic/claude-sonnet-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus461mModelId = `anthropic/claude-opus-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterDefaultModelInfo: ModelInfo = {
	maxTokens: 64_000,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description:
		"Claude Sonnet 4.5 delivers superior intelligence across coding, agentic search, and AI agent capabilities. It's a powerful choice for agentic coding, and can complete tasks across the entire software development lifecycle, from initial planning to bug fixes, maintenance to large refactors. It offers strong performance in both planning and solving for complex coding tasks, making it an ideal choice to power end-to-end software development processes.\n\nRead more in the [blog post here](https://www.anthropic.com/claude/sonnet)",
}

export const OPENROUTER_PROVIDER_PREFERENCES: Record<string, { order: string[]; allow_fallbacks: boolean }> = {
	// Exacto Providers
	"moonshotai/kimi-k2:exacto": {
		order: ["groq", "moonshotai"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.6:exacto": {
		order: ["z-ai", "novita"],
		allow_fallbacks: false,
	},
	"deepseek/deepseek-v3.1-terminus:exacto": {
		order: ["novita", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-coder:exacto": {
		order: ["baseten"],
		allow_fallbacks: false,
	},
	"openai/gpt-oss-120b:exacto": {
		order: ["groq", "novita"],
		allow_fallbacks: false,
	},

	// Normal Providers
	"moonshotai/kimi-k2": {
		order: ["groq", "fireworks", "baseten", "parasail", "novita", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-coder": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-235b-a22b-thinking-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-235b-a22b-07-25": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b-thinking-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b-instruct-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b:free": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-next-80b-a3b-thinking": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-next-80b-a3b-instruct": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-max": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"deepseek/deepseek-v3.2-exp": {
		order: ["deepseek", "novita", "fireworks", "nebius"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.6": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5v": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5-air": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
}

// Vertex AI
// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude
// https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models
export type VertexModelId = keyof typeof vertexModels
export const vertexDefaultModelId: VertexModelId = "gemini-3-pro-preview"
export const vertexModels = {
	"gemini-3.1-pro-preview": {
		maxTokens: 8192,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 2.0,
		outputPrice: 12.0,
		temperature: 1.0,
		supportsReasoning: true,
		thinkingConfig: {
			geminiThinkingLevel: "high",
			supportsThinkingLevel: true,
		},
	},
	"gemini-3-pro-preview": {
		maxTokens: 8192,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 2.0,
		outputPrice: 12.0,
		temperature: 1.0,
		supportsReasoning: true,
		thinkingConfig: {
			geminiThinkingLevel: "high",
			supportsThinkingLevel: true,
		},
	},
	"gemini-3-flash-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 0.5,
		outputPrice: 3.0,
		cacheReadsPrice: 0.05,
		cacheWritesPrice: 0.0,
		temperature: 0.35,
		supportsReasoning: true,
		thinkingConfig: {
			geminiThinkingLevel: "high",
			supportsThinkingLevel: true,
		},
	},
	"claude-sonnet-4-6": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		supportsReasoning: true,
	},
	"claude-sonnet-4-6:1m": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		supportsReasoning: true,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"claude-haiku-4-5@20251001": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1.0,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
		supportsReasoning: true,
	},
	"claude-opus-4-6": {
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		supportsReasoning: true,
	},
	"claude-opus-4-6:1m": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		supportsReasoning: true,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"mistral-small-2503": {
		maxTokens: 128_000,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"codestral-2501": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.9,
	},
	"llama-4-maverick-17b-128e-instruct-maas": {
		maxTokens: 128_000,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.35,
		outputPrice: 1.15,
	},
	"llama-4-scout-17b-16e-instruct-maas": {
		maxTokens: 1_000_000,
		contextWindow: 10_485_760,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.25,
		outputPrice: 0.7,
	},
	"gemini-2.5-pro-exp-03-25": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
	"gemini-2.5-pro": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 2.5,
		outputPrice: 15,
		cacheReadsPrice: 0.625,
		thinkingConfig: {
			maxBudget: 32767,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 1.25,
				outputPrice: 10,
				cacheReadsPrice: 0.31,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 2.5,
				outputPrice: 15,
				cacheReadsPrice: 0.625,
			},
		],
	},
	"gemini-2.5-flash": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 0.3,
		outputPrice: 2.5,
		thinkingConfig: {
			maxBudget: 24576,
			outputPrice: 3.5,
		},
	},

	"gemini-2.5-flash-lite-preview-06-17": {
		maxTokens: 64000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 0.1,
		outputPrice: 0.4,
		cacheReadsPrice: 0.025,
		description: "Preview version - may not be available in all regions",
		thinkingConfig: {
			maxBudget: 24576,
		},
	},
	"gemini-2.0-flash-thinking-exp-01-21": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		supportsGlobalEndpoint: true,
		inputPrice: 0,
		outputPrice: 0,
	},
} as const satisfies Record<string, ModelInfo>

export const vertexGlobalModels: Record<string, ModelInfo> = Object.fromEntries(
	Object.entries(vertexModels).filter(([_k, v]) => Object.hasOwn(v, "supportsGlobalEndpoint")),
) as Record<string, ModelInfo>

export const openAiModelInfoSaneDefaults: OpenAiCompatibleModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: false,
	supportsTools: true,
	supportsReasoning: true,
	isR1FormatRequired: false,
	inputPrice: 0,
	outputPrice: 0,
	temperature: 0,
}

// Gemini
// https://ai.google.dev/gemini-api/docs/models/gemini
export type GeminiModelId = keyof typeof geminiModels
export const geminiDefaultModelId: GeminiModelId = "gemini-3.1-pro-preview"
export const geminiModels = {
	"gemini-3.1-pro-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		thinkingConfig: {
			// If you don't specify a thinking level, Gemini will use the model's default
			// dynamic thinking level, "high", for Gemini 3 Pro Preview.
			geminiThinkingLevel: "high",
			supportsThinkingLevel: true,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
	},
	"gemini-3-pro-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		thinkingConfig: {
			geminiThinkingLevel: "high",
			supportsThinkingLevel: true,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
	},
	"gemini-3-flash-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 0.5,
		outputPrice: 3.0,
		cacheReadsPrice: 0.05,
		cacheWritesPrice: 0.0,
		temperature: 0.35,
		supportsReasoning: true,
		thinkingConfig: {
			geminiThinkingLevel: "low",
			supportsThinkingLevel: true,
		},
	},
	"gemini-2.5-pro": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 2.5,
		outputPrice: 15,
		cacheReadsPrice: 0.625,
		thinkingConfig: {
			maxBudget: 32767,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 1.25,
				outputPrice: 10,
				cacheReadsPrice: 0.31,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 2.5,
				outputPrice: 15,
				cacheReadsPrice: 0.625,
			},
		],
	},
	"gemini-2.5-flash-lite-preview-06-17": {
		maxTokens: 64000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 0.1,
		outputPrice: 0.4,
		cacheReadsPrice: 0.025,
		description: "Preview version - may not be available in all regions",
		thinkingConfig: {
			maxBudget: 24576,
		},
	},
	"gemini-2.5-flash": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 2.5,
		cacheReadsPrice: 0.075,
		thinkingConfig: {
			maxBudget: 24576,
			outputPrice: 3.5,
		},
	},
} as const satisfies Record<string, ModelInfo>

// OpenAI Native
// https://openai.com/api/pricing/
export type OpenAiNativeModelId = keyof typeof openAiNativeModels
export const openAiNativeDefaultModelId: OpenAiNativeModelId = "gpt-5.4"
export const openAiNativeModels = {
	"gpt-5.5": {
		name: "GPT-5.5",
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0,
		outputPrice: 30.0,
		cacheReadsPrice: 0.5,
		cacheWritesPrice: 0,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		tiers: GPT_5_5_TIERS,
	},
	"gpt-5.4": {
		name: "GPT-5.4",
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 2.5,
		outputPrice: 15,
		cacheReadsPrice: 0.25,
		cacheWritesPrice: 0,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		tiers: GPT_5_4_TIERS,
	},
	"gpt-5.4-mini": {
		name: "GPT-5.4 mini",
		maxTokens: 128_000,
		contextWindow: 400_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.75,
		outputPrice: 4.5,
		cacheReadsPrice: 0.075,
		cacheWritesPrice: 0,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
	},
	"gpt-5.4-nano": {
		name: "GPT-5.4 nano",
		maxTokens: 128_000,
		contextWindow: 400_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.2,
		outputPrice: 1.25,
		cacheReadsPrice: 0.02,
		cacheWritesPrice: 0,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
	},
	"gpt-5.4-pro": {
		name: "GPT-5.4 Pro",
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 30,
		outputPrice: 180,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		tiers: GPT_5_4_PRO_TIERS,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// OpenAI Codex (ChatGPT Plus/Pro subscription)
// Uses OAuth authentication via ChatGPT, routes to chatgpt.com/backend-api/codex/responses
// Subscription-based pricing (all costs are $0)
export type OpenAiCodexModelId = keyof typeof openAiCodexModels
export const openAiCodexDefaultModelId: OpenAiCodexModelId = "gpt-5.5-2026-04-23"
export const openAiCodexModels = {
	"gpt-5.5-2026-04-23": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		inputPrice: 0,
		outputPrice: 0,
		description: "GPT-5.5 Codex snapshot (2026-04-23), Dec 01, 2025 knowledge cutoff, with reasoning token support",
	},
	"gpt-5.4": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		// Subscription-based: no per-token costs
		inputPrice: 0,
		outputPrice: 0,
		description: "GPT-5.4 Codex: OpenAI's latest flagship coding model via ChatGPT subscription",
	},
	"gpt-5.4-mini": {
		maxTokens: 128_000,
		contextWindow: 400_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		inputPrice: 0,
		outputPrice: 0,
		description: "GPT-5.4 mini Codex via ChatGPT subscription",
	},
	"gpt-5.4-nano": {
		maxTokens: 128_000,
		contextWindow: 400_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		inputPrice: 0,
		outputPrice: 0,
		description: "GPT-5.4 nano Codex via ChatGPT subscription",
	},
	"gpt-5.4-pro": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoning: true,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		inputPrice: 0,
		outputPrice: 0,
		description: "GPT-5.4 Pro Codex via ChatGPT subscription",
	},
} as const satisfies Record<string, ModelInfo>

// Azure OpenAI
// https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation
// https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#api-specs
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"

// DeepSeek
// https://api-docs.deepseek.com/quick_start/pricing
export type DeepSeekModelId = keyof typeof deepSeekModels
export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-flash"
export const deepSeekModels = {
	"deepseek-v4-flash": {
		maxTokens: 384_000,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsTools: true,
		inputPrice: 0,
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.0028,
	},
	"deepseek-v4-pro": {
		maxTokens: 384_000,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsTools: true,
		inputPrice: 0,
		outputPrice: 3.48,
		cacheWritesPrice: 1.74,
		cacheReadsPrice: 0.0145,
	},
	"deepseek-chat": {
		maxTokens: 8_000,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true, // supports context caching, but not in the way anthropic does it (deepseek reports input tokens and reads/writes in the same usage report) FIXME: we need to show users cache stats how deepseek does it
		inputPrice: 0, // technically there is no input price, it's all either a cache hit or miss (ApiOptions will not show this). Input is the sum of cache reads and writes
		outputPrice: 1.1,
		cacheWritesPrice: 0.27,
		cacheReadsPrice: 0.07,
	},
	"deepseek-reasoner": {
		maxTokens: 8_000,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		supportsTools: true,
		inputPrice: 0,
		outputPrice: 2.19,
		cacheWritesPrice: 0.55,
		cacheReadsPrice: 0.14,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// Hugging Face Inference Providers
// https://huggingface.co/docs/inference-providers/en/index
export type HuggingFaceModelId = keyof typeof huggingFaceModels
export const huggingFaceDefaultModelId: HuggingFaceModelId = "moonshotai/Kimi-K2-Instruct"
export const huggingFaceModels = {
	"openai/gpt-oss-120b": {
		maxTokens: 32766,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Large open-weight reasoning model for high-end desktops and data centers, built for complex coding, math, and general AI tasks.",
	},
	"openai/gpt-oss-20b": {
		maxTokens: 32766,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Medium open-weight reasoning model that runs on most desktops, balancing strong reasoning with broad accessibility.",
	},
	"moonshotai/Kimi-K2-Instruct": {
		supportsTools: true,
		maxTokens: 131_072,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Advanced reasoning model with superior performance across coding, math, and general capabilities.",
	},
	"deepseek-ai/DeepSeek-R1": {
		maxTokens: 8192,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "DeepSeek's reasoning model with step-by-step thinking capabilities.",
	},
} as const satisfies Record<string, ModelInfo>

// Qwen
// https://bailian.console.aliyun.com/
// The first model in the list is used as the default model for each region
export const internationalQwenModels = {
	"qwen-turbo-latest": {
		maxTokens: 16_384,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.6,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.6,
		thinkingConfig: {
			maxBudget: 38_912,
			outputPrice: 6,
		},
	},
	"qwen-max-latest": {
		maxTokens: 30_720,
		contextWindow: 32_768,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.4,
		outputPrice: 9.6,
		cacheWritesPrice: 2.4,
		cacheReadsPrice: 9.6,
	},
} as const satisfies Record<string, ModelInfo>

export const mainlandQwenModels = {
	"qwen-plus-latest": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.8,
		outputPrice: 2,
		cacheWritesPrice: 0.8,
		cacheReadsPrice: 2,
		thinkingConfig: {
			maxBudget: 38_912,
			outputPrice: 16,
		},
	},
	"qwen-turbo-latest": {
		maxTokens: 16_384,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.6,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.6,
		thinkingConfig: {
			maxBudget: 38_912,
			outputPrice: 6,
		},
	},
	"deepseek-v3": {
		maxTokens: 8_000,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.014,
	},
	"deepseek-r1": {
		maxTokens: 8_000,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 2.19,
		cacheWritesPrice: 0.55,
		cacheReadsPrice: 0.14,
	},
	"qwen-vl-max": {
		maxTokens: 30_720,
		contextWindow: 32_768,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 3,
		outputPrice: 9,
		cacheWritesPrice: 3,
		cacheReadsPrice: 9,
	},
	"qwen-vl-max-latest": {
		maxTokens: 129_024,
		contextWindow: 131_072,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 3,
		outputPrice: 9,
		cacheWritesPrice: 3,
		cacheReadsPrice: 9,
	},
	"qwen-vl-plus": {
		maxTokens: 6_000,
		contextWindow: 8_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.5,
		outputPrice: 4.5,
		cacheWritesPrice: 1.5,
		cacheReadsPrice: 4.5,
	},
	"qwen-vl-plus-latest": {
		maxTokens: 129_024,
		contextWindow: 131_072,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.5,
		outputPrice: 4.5,
		cacheWritesPrice: 1.5,
		cacheReadsPrice: 4.5,
	},
} as const satisfies Record<string, ModelInfo>
export enum QwenApiRegions {
	CHINA = "china",
	INTERNATIONAL = "international",
}
export type MainlandQwenModelId = keyof typeof mainlandQwenModels
export type InternationalQwenModelId = keyof typeof internationalQwenModels
// Set first model in the list as the default model for each region
export const internationalQwenDefaultModelId: InternationalQwenModelId = Object.keys(
	internationalQwenModels,
)[0] as InternationalQwenModelId
export const mainlandQwenDefaultModelId: MainlandQwenModelId = Object.keys(mainlandQwenModels)[0] as MainlandQwenModelId

// Doubao
// https://www.volcengine.com/docs/82379/1298459
// https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement
export type DoubaoModelId = keyof typeof doubaoModels
export const doubaoDefaultModelId: DoubaoModelId = "doubao-1-5-pro-256k-250115"
export const doubaoModels = {
	"doubao-1-5-pro-256k-250115": {
		maxTokens: 12_288,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.7,
		outputPrice: 1.3,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"doubao-1-5-pro-32k-250115": {
		maxTokens: 12_288,
		contextWindow: 32_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.11,
		outputPrice: 0.3,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"deepseek-v3-250324": {
		maxTokens: 12_288,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.55,
		outputPrice: 2.19,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"deepseek-r1-250120": {
		maxTokens: 32_768,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.27,
		outputPrice: 1.09,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
} as const satisfies Record<string, ModelInfo>

// Mistral
// https://docs.mistral.ai/getting-started/models/models_overview/
export type MistralModelId = keyof typeof mistralModels
export const mistralDefaultModelId: MistralModelId = "devstral-2512"
export const mistralModels = {
	"devstral-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
	"labs-devstral-small-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
	"mistral-large-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 1.5,
	},
	"ministral-14b-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.2,
	},
	"mistral-small-latest": {
		maxTokens: 128_000,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"mistral-medium-latest": {
		maxTokens: 128_000,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
	},
	"mistral-small-2501": {
		maxTokens: 32_000,
		contextWindow: 32_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"open-codestral-mamba": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.15,
	},
	"codestral-2501": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.9,
	},
	"devstral-small-2505": {
		maxTokens: 128_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"devstral-medium-latest": {
		maxTokens: 128_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
	},
} as const satisfies Record<string, ModelInfo>

// LiteLLM
// https://docs.litellm.ai/docs/
export type LiteLLMModelId = string
export const liteLlmDefaultModelId = "anthropic/claude-4-6-sonnet"
export interface LiteLLMModelInfo extends ModelInfo {
	temperature?: number
}

export const liteLlmModelInfoSaneDefaults: LiteLLMModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	supportsTools: true,
	outputPrice: 0,
	cacheWritesPrice: 0,
	cacheReadsPrice: 0,
	temperature: 0,
}

// Nebius AI Studio
// https://docs.nebius.com/studio/inference/models
export const nebiusModels = {
	"openai/gpt-oss-120b": {
		maxTokens: 32766, // Quantization: fp4
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
	},
	"openai/gpt-oss-20b": {
		maxTokens: 32766, // Quantization: fp4
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
	},
} as const satisfies Record<string, ModelInfo>
export type NebiusModelId = keyof typeof nebiusModels
export const nebiusDefaultModelId = "openai/gpt-oss-120b" satisfies NebiusModelId

// W&B Inference by CoreWeave
// https://docs.wandb.ai/inference/models
export const wandbModels = {
	"MiniMaxAI/MiniMax-M2.5": {
		supportsTools: true,
		maxTokens: 40_960,
		contextWindow: 197_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 1.2,
		description:
			"MoE model with a highly sparse architecture designed for high-throughput and low latency with strong coding capabilities",
	},
	"nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8": {
		maxTokens: 8_192,
		contextWindow: 262_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.8,
		description: "A LatentMoE model designed to deliver strong agentic, reasoning, and conversational capabilities",
	},
	"openai/gpt-oss-120b": {
		maxTokens: 32_768,
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
		description: "Efficient Mixture-of-Experts model designed for high-reasoning, agentic and general-purpose use cases",
	},
	"openai/gpt-oss-20b": {
		maxTokens: 32_768,
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
		description:
			"Lower latency Mixture-of-Experts model trained on OpenAI’s Harmony response format with reasoning capabilities",
	},
	"zai-org/GLM-5-FP8": {
		supportsTools: true,
		maxTokens: 8_192,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.0,
		outputPrice: 3.2,
		description: "Mixture-of-Experts model for long-horizon agentic tasks with strong performance on reasoning and coding",
	},
} as const satisfies Record<string, ModelInfo>
export type WandbModelId = keyof typeof wandbModels
export const wandbDefaultModelId = "openai/gpt-oss-120b" satisfies WandbModelId

// X AI
// https://docs.x.ai/docs/api-reference
export type XAIModelId = keyof typeof xaiModels
export const xaiDefaultModelId: XAIModelId = "grok-4-1-fast-reasoning"
export const xaiModels = {
	"grok-4-1-fast-reasoning": {
		contextWindow: 2_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.05,
		outputPrice: 0.5,
		description: "xAI's Grok 4.1 Reasoning Fast - multimodal model with 2M context.",
	},
	"grok-4-1-fast-non-reasoning": {
		contextWindow: 2_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.05,
		outputPrice: 0.5,
		description: "xAI's Grok 4.1 Non-Reasoning Fast - multimodal model with 2M context.",
	},
	"grok-code-fast-1": {
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.02,
		outputPrice: 1.5,
		description: "xAI's Grok Coding model.",
	},
} as const satisfies Record<string, ModelInfo>

// SambaNova
// https://docs.sambanova.ai/cloud/docs/get-started/supported-models
export type SambanovaModelId = keyof typeof sambanovaModels
export const sambanovaDefaultModelId: SambanovaModelId = "Meta-Llama-3.3-70B-Instruct"
export const sambanovaModels = {
	"DeepSeek-R1-0528": {
		maxTokens: 7168,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 5.0,
		outputPrice: 7.0,
	},
	"DeepSeek-R1-Distill-Llama-70B": {
		maxTokens: 4096,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 0.7,
		outputPrice: 1.4,
	},
	"DeepSeek-V3-0324": {
		maxTokens: 7168,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.3,
		inputPrice: 3.0,
		outputPrice: 4.5,
	},
	"DeepSeek-V3.1": {
		maxTokens: 7168,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 3.0,
		outputPrice: 4.5,
	},
	"DeepSeek-V3.1-Terminus": {
		maxTokens: 7168,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 3.0,
		outputPrice: 4.5,
	},
	"Llama-4-Maverick-17B-128E-Instruct": {
		maxTokens: 4096,
		contextWindow: 131072,
		supportsImages: true,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 0.63,
		outputPrice: 1.8,
	},
	"Meta-Llama-3.1-8B-Instruct": {
		maxTokens: 4096,
		contextWindow: 16384,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 0.1,
		outputPrice: 0.2,
	},
	"Meta-Llama-3.3-70B-Instruct": {
		maxTokens: 3072,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 0.6,
		outputPrice: 1.2,
	},
	"MiniMax-M2.5": {
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 163840,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 1.0,
		inputPrice: 0.3,
		outputPrice: 1.2,
	},
	"Qwen3-235B": {
		maxTokens: 4096,
		contextWindow: 65536,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.7,
		inputPrice: 0.4,
		outputPrice: 0.8,
	},
	"Qwen3-32B": {
		maxTokens: 4096,
		contextWindow: 32768,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.6,
		inputPrice: 0.4,
		outputPrice: 0.8,
	},
} as const satisfies Record<string, ModelInfo>

// Cerebras
// https://inference-docs.cerebras.ai/api-reference/models
export type CerebrasModelId = keyof typeof cerebrasModels
export const cerebrasDefaultModelId: CerebrasModelId = "zai-glm-4.7"
export const cerebrasModels = {
	"zai-glm-4.7": {
		supportsTools: true,
		maxTokens: 40000,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: false,
		temperature: 0.9,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Highly capable general-purpose model on Cerebras (up to 1,000 tokens/s), competitive with leading proprietary models on coding tasks.",
	},
	"gpt-oss-120b": {
		maxTokens: 65536,
		contextWindow: 128000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Intelligent general purpose model with 3,000 tokens/s",
	},
	"qwen-3-235b-a22b-instruct-2507": {
		maxTokens: 64000,
		contextWindow: 64000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Intelligent model with ~1400 tokens/s",
	},
} as const satisfies Record<string, ModelInfo>

// Groq
// https://console.groq.com/docs/models
// https://groq.com/pricing/
export type GroqModelId = keyof typeof groqModels
export const groqDefaultModelId: GroqModelId = "openai/gpt-oss-20b"
export const groqModels = {
	"openai/gpt-oss-120b": {
		maxTokens: 32766, // Model fails if you try to use more than 32K tokens
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.75,
		description:
			"A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
	},
	"openai/gpt-oss-20b": {
		maxTokens: 32766, // Model fails if you try to use more than 32K tokens
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.5,
		description:
			"A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// Requesty
// https://requesty.ai/models
export const requestyDefaultModelId = "anthropic/claude-4-6-sonnet-latest"
export const requestyDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,

	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description: "Anthropic's most intelligent model. Highest level of intelligence and capability.",
}

// SAP AI Core
export type SapAiCoreModelId = keyof typeof sapAiCoreModels
export const sapAiCoreDefaultModelId: SapAiCoreModelId = "anthropic--claude-4.6-sonnet"
// Pricing is calculated using Capacity Units, not directly in USD
const sapAiCoreModelDescription = "Pricing is calculated using SAP's Capacity Units rather than direct USD pricing."
export const sapAiCoreModels = {
	"anthropic--claude-4.5-haiku": {
		maxTokens: 64000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"anthropic--claude-4.6-sonnet": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"anthropic--claude-4.5-sonnet": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"anthropic--claude-4-sonnet": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"anthropic--claude-4.5-opus": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"anthropic--claude-4-opus": {
		maxTokens: 32_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"gemini-2.5-pro": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		thinkingConfig: {
			maxBudget: 32767,
		},
		description: sapAiCoreModelDescription,
	},
	"gemini-2.5-flash": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		thinkingConfig: {
			maxBudget: 24576,
		},
		description: sapAiCoreModelDescription,
	},
	"gpt-4": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		description: sapAiCoreModelDescription,
	},
	"gpt-4o": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		description: sapAiCoreModelDescription,
	},
	"gpt-4o-mini": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		description: sapAiCoreModelDescription,
	},
	"gpt-4.1": {
		maxTokens: 32_768,
		contextWindow: 1_047_576,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"gpt-4.1-nano": {
		maxTokens: 32_768,
		contextWindow: 1_047_576,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"gpt-5": {
		maxTokens: 128_000,
		contextWindow: 272_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"gpt-5-nano": {
		maxTokens: 128_000,
		contextWindow: 272_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
	"gpt-5-mini": {
		maxTokens: 128_000,
		contextWindow: 272_000,
		supportsImages: true,
		supportsPromptCache: true,
		description: sapAiCoreModelDescription,
	},
} as const satisfies Record<string, ModelInfo>

// Moonshot AI Studio
// https://platform.moonshot.ai/docs/pricing/chat
export const moonshotModels = {
	"kimi-k2.6": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: true,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.95,
		outputPrice: 4.0,
		cacheReadsPrice: 0.16,
		temperature: 1.0,
		isR1FormatRequired: true,
		supportsTools: true,
	},
	"kimi-k2.5": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: true,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 3.0,
		cacheReadsPrice: 0.1,
		temperature: 1.0,
		isR1FormatRequired: true,
		supportsTools: true,
	},
	"kimi-k2-0905-preview": {
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: false,
		supportsReasoning: true,
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.5,
		temperature: 0.6,
		isR1FormatRequired: true,
		supportsTools: true,
	},
	"kimi-k2-thinking-turbo": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsReasoning: true,
		supportsPromptCache: false,
		inputPrice: 2.4,
		outputPrice: 10,
		temperature: 1.0,
		isR1FormatRequired: true,
		supportsTools: true,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
export type MoonshotModelId = keyof typeof moonshotModels
export const moonshotDefaultModelId = "kimi-k2.6" satisfies MoonshotModelId

// Huawei Cloud MaaS
// Dify.ai - No model selection needed, models are configured in Dify workflows

export type HuaweiCloudMaasModelId = keyof typeof huaweiCloudMaasModels
export const huaweiCloudMaasDefaultModelId: HuaweiCloudMaasModelId = "DeepSeek-V3"
export const huaweiCloudMaasModels = {
	"DeepSeek-V3": {
		maxTokens: 16_384,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.27,
		outputPrice: 1.1,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"DeepSeek-R1": {
		maxTokens: 16_384,
		contextWindow: 64_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.55,
		outputPrice: 2.2,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		thinkingConfig: {
			maxBudget: 8192,
			outputPrice: 2.2,
		},
	},
} as const satisfies Record<string, ModelInfo>

// Baseten
// https://baseten.co/products/model-apis/
// Extended ModelInfo to include supportedFeatures, like tools
export interface BasetenModelInfo extends ModelInfo {
	supportedFeatures?: string[]
}

export const basetenModels = {
	"moonshotai/Kimi-K2-Thinking": {
		supportsTools: true,
		maxTokens: 163_800,
		contextWindow: 262_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.5,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Kimi K2 Thinking - A model with enhanced reasoning capabilities from Kimi K2",
		supportsReasoning: true,
	},
	"zai-org/GLM-4.6": {
		supportsTools: true,
		maxTokens: 200_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.2,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Frontier open model with advanced agentic, reasoning and coding capabilities",
		supportsReasoning: true,
	},
	"deepseek-ai/DeepSeek-R1": {
		maxTokens: 131_072,
		contextWindow: 163_840,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.55,
		outputPrice: 5.95,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "DeepSeek's first-generation reasoning model",
		supportsReasoning: true,
	},
	"deepseek-ai/DeepSeek-V3.2": {
		maxTokens: 131_072,
		contextWindow: 163_840,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.45,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "DeepSeek's hybrid reasoning model with efficient long context scaling with GPT-5 level performance",
		supportsReasoning: true,
	},
	"openai/gpt-oss-120b": {
		maxTokens: 128_072,
		contextWindow: 128_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Extremely capable general-purpose LLM with strong, controllable reasoning capabilities",
		supportsReasoning: true,
	},
} as const satisfies Record<string, ModelInfo>
export type BasetenModelId = keyof typeof basetenModels
export const basetenDefaultModelId = "zai-org/GLM-4.6" satisfies BasetenModelId

// Z AI
// https://docs.z.ai/guides/llm/glm-5
// https://docs.z.ai/guides/overview/pricing
export type internationalZAiModelId = keyof typeof internationalZAiModels
export const internationalZAiDefaultModelId: internationalZAiModelId = "glm-5"
export const internationalZAiModels = {
	"glm-5.1": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.26,
		inputPrice: 1.4,
		outputPrice: 4.4,
	},
	"glm-5": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.2,
		inputPrice: 1.0,
		outputPrice: 3.2,
	},
} as const satisfies Record<string, ModelInfo>

export type mainlandZAiModelId = keyof typeof mainlandZAiModels
export const mainlandZAiDefaultModelId: mainlandZAiModelId = "glm-5"
export const mainlandZAiModels = {
	"glm-5.1": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.26,
		inputPrice: 1.4,
		outputPrice: 4.4,
	},
	"glm-5": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.2,
		inputPrice: 1.0,
		outputPrice: 3.2,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// Fireworks AI
export type FireworksModelId = keyof typeof fireworksModels
export const fireworksDefaultModelId: FireworksModelId = "accounts/fireworks/models/kimi-k2p6"
export const fireworksModels = {
	"accounts/fireworks/models/kimi-k2p6": {
		isR1FormatRequired: true,
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: true,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.95,
		outputPrice: 4,
		cacheReadsPrice: 0.16,
		description:
			"Moonshot's flagship open agentic model. Kimi K2.5 unifies vision and text, thinking and non-thinking modes, and single-agent and multi-agent execution.",
	},
	"accounts/fireworks/models/kimi-k2p5": {
		isR1FormatRequired: true,
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: true,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 3,
		cacheWritesPrice: 0.6,
		cacheReadsPrice: 0.1,
		description:
			"Moonshot's flagship open agentic model. Kimi K2.5 unifies vision and text, thinking and non-thinking modes, and single-agent and multi-agent execution.",
	},
	"accounts/fireworks/models/deepseek-v3p2": {
		maxTokens: 16384,
		contextWindow: 163840,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.56,
		outputPrice: 1.68,
		cacheWritesPrice: 0.56,
		cacheReadsPrice: 0.28,
		description: "DeepSeek V3.2 model tuned for high computational efficiency and strong reasoning and agent performance.",
	},
	"accounts/fireworks/models/glm-5": {
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 202752,
		supportsImages: false,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 1.0,
		outputPrice: 3.2,
		cacheWritesPrice: 1.0,
		cacheReadsPrice: 0.2,
		description: "GLM-5 is Z.ai's flagship reasoning model for complex systems engineering and long-horizon agentic tasks.",
	},
	"accounts/fireworks/models/minimax-m2p5": {
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 196608,
		supportsImages: false,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
		description: "MiniMax M2.5 is built for state-of-the-art coding, agentic tool use.",
	},
	"accounts/fireworks/models/minimax-m2p1": {
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 196608,
		supportsImages: false,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.1 is tuned for strong real-world performance across coding, agent-driven, and workflow-heavy tasks.",
	},
	"accounts/fireworks/models/gpt-oss-120b": {
		maxTokens: 16384,
		contextWindow: 131072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.15,
		outputPrice: 0.6,
		cacheWritesPrice: 0.15,
		cacheReadsPrice: 0.01,
		description: "OpenAI gpt-oss-120b open-weight model for production and high-reasoning use cases.",
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// Firepass (Fireworks Router Service)
// Uses Fireworks API key but accesses models via router path
export type FirepassModelId = keyof typeof firepassModels
export const firepassDefaultModelId: FirepassModelId = "accounts/fireworks/routers/kimi-k2p5-turbo"
export const firepassModels = {
	"accounts/fireworks/routers/kimi-k2p5-turbo": {
		supportsTools: true,
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: true,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 3,
		cacheWritesPrice: 0.6,
		cacheReadsPrice: 0.1,
		description:
			"Kimi K2.5 Turbo via Fireworks AI - a high-performance model with tool support and reasoning capabilities.",
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>

// Qwen Code
// https://chat.qwen.ai/
export const qwenCodeModels = {
	"qwen3-coder-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Qwen3 Coder Plus - High-performance coding model with 1M context window for large codebases",
	},
	"qwen3-coder-flash": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Qwen3 Coder Flash - Fast coding model with 1M context window optimized for speed",
	},
} as const satisfies Record<string, ModelInfo>
export type QwenCodeModelId = keyof typeof qwenCodeModels
export const qwenCodeDefaultModelId: QwenCodeModelId = "qwen3-coder-plus"

// Minimax
// https://www.minimax.io/platform/document/text_api_intro
// https://www.minimax.io/platform/document/pricing
export type MinimaxModelId = keyof typeof minimaxModels
export const minimaxDefaultModelId: MinimaxModelId = "MiniMax-M2.7"
export const minimaxModels = {
	"MiniMax-M2.7": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description: "Latest flagship model with enhanced reasoning and coding",
	},
	"MiniMax-M2.7-highspeed": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 0.6,
		outputPrice: 2.4,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description: "High-speed version of M2.7 for low-latency scenarios",
	},
	"MiniMax-M2.5": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
	},
	"MiniMax-M2.5-highspeed": {
		supportsTools: true,
		maxTokens: 128_000,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoning: true,
		inputPrice: 0.6,
		outputPrice: 2.4,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
	},
} as const satisfies Record<string, ModelInfo>

// NousResearch
// https://inference-api.nousResearch.com
export type NousResearchModelId = keyof typeof nousResearchModels
export const nousResearchDefaultModelId: NousResearchModelId = "Hermes-4-405B"
export const nousResearchModels = {
	"Hermes-4-405B": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.09,
		outputPrice: 0.37,
		description:
			"This is the largest model in the Hermes 4 family, and it is the fullest expression of our design, focused on advanced reasoning and creative depth rather than optimizing inference speed or cost.",
	},
	"Hermes-4-70B": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
		description:
			"This incarnation of Hermes 4 balances scale and size. It handles complex reasoning tasks, while staying fast and cost effective. A versatile choice for many use cases.",
	},
} as const satisfies Record<string, ModelInfo>

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
	["sapaicore", sapAiCoreModels],
	["moonshot", moonshotModels],
	["huawei-cloud-maas", huaweiCloudMaasModels],
	["baseten", basetenModels],
	["zai", internationalZAiModels],
	["zai", mainlandZAiModels],
	["fireworks", fireworksModels],
	["qwen-code", qwenCodeModels],
	["minimax", minimaxModels],
	["nousResearch", nousResearchModels],
	["firepass", firepassModels],
]

/**
 * Gets the provider for a given model ID based on hardcoded model maps.
 */
export function getProviderForModel(modelId: string): ApiProvider | undefined {
	for (const [provider, map] of ALL_MODEL_MAPS) {
		if (modelId in map) {
			return provider
		}
	}
	return undefined
}
