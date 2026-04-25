import { ApiProvider } from "../api"
import { Secrets } from "./state-keys"

/**
 * Mapping of environment variables to Dirac secret keys.
 * This allows users to provide API keys via environment variables,
 * which is especially useful in non-persistent CLI environments.
 */
export const ENV_VAR_TO_SECRET_KEY: Record<string, keyof Secrets> = {
	ANTHROPIC_API_KEY: "apiKey",
	OPENAI_API_KEY: "openAiApiKey",
	AZURE_OPENAI_API_KEY: "openAiApiKey",
	GEMINI_API_KEY: "geminiApiKey",
	GROQ_API_KEY: "groqApiKey",
	CEREBRAS_API_KEY: "cerebrasApiKey",
	XAI_API_KEY: "xaiApiKey",
	OPENROUTER_API_KEY: "openRouterApiKey",
	AI_GATEWAY_API_KEY: "vercelAiGatewayApiKey",
	ZAI_API_KEY: "zaiApiKey",
	MISTRAL_API_KEY: "mistralApiKey",
	MOONSHOT_API_KEY: "moonshotApiKey",
	MINIMAX_API_KEY: "minimaxApiKey",
	MINIMAX_CN_API_KEY: "minimaxApiKey",
	HF_TOKEN: "huggingFaceApiKey",
	OPENCODE_API_KEY: "openAiNativeApiKey",
	KIMI_API_KEY: "openAiNativeApiKey",
	DEEPSEEK_API_KEY: "deepSeekApiKey",
	QWEN_API_KEY: "qwenApiKey",
	TOGETHER_API_KEY: "togetherApiKey",
	FIREWORKS_API_KEY: "fireworksApiKey",
	NEBIUS_API_KEY: "nebiusApiKey",
	OPENAI_COMPATIBLE_CUSTOM_KEY: "openAiCompatibleCustomApiKey"
}

/**
 * Get secrets from environment variables.
 * Returns a partial Secrets object with keys found in process.env.
 */
export function getSecretsFromEnv(): Partial<Secrets> {
	const secrets: Partial<Secrets> = {}

	for (const [envVar, secretKey] of Object.entries(ENV_VAR_TO_SECRET_KEY)) {
		const value = process.env[envVar]
		if (value) {
			secrets[secretKey] = value
		}
	}

	// Special case: OPENAI_API_KEY also maps to openAiNativeApiKey if not already set by OPENCODE_API_KEY or KIMI_API_KEY
	if (process.env.OPENAI_API_KEY && !secrets.openAiNativeApiKey) {
		secrets.openAiNativeApiKey = process.env.OPENAI_API_KEY
	}

	// Map OPENAI_COMPATIBLE_CUSTOM_KEY to openAiApiKey if not already set
	if (process.env.OPENAI_COMPATIBLE_CUSTOM_KEY && !secrets.openAiApiKey) {
		secrets.openAiApiKey = process.env.OPENAI_COMPATIBLE_CUSTOM_KEY
	}

	return secrets
}


/**
 * Get the best provider based on available environment variables.
 */
export function getProviderFromEnv(): ApiProvider | undefined {
	if (process.env.ANTHROPIC_API_KEY) return "anthropic"
	if (process.env.OPENROUTER_API_KEY) return "openrouter"
	if (process.env.OPENAI_API_KEY) return "openai-native"
	if (process.env.GEMINI_API_KEY) return "gemini"
	if (process.env.GROQ_API_KEY) return "groq"
	if (process.env.XAI_API_KEY) return "xai"
	if (process.env.MISTRAL_API_KEY) return "mistral"
	if (process.env.MOONSHOT_API_KEY) return "moonshot"
	if (process.env.HF_TOKEN) return "huggingface"
	if (process.env.ZAI_API_KEY) return "zai"
	if (process.env.MINIMAX_API_KEY || process.env.MINIMAX_CN_API_KEY) return "minimax"
	if (process.env.CEREBRAS_API_KEY) return "cerebras"
	if (process.env.AI_GATEWAY_API_KEY) return "vercel-ai-gateway"
	if (process.env.OPENCODE_API_KEY || process.env.KIMI_API_KEY) return "openai-native"
	if (process.env.DEEPSEEK_API_KEY) return "deepseek"
	if (process.env.QWEN_API_KEY) return "qwen"
	if (process.env.TOGETHER_API_KEY) return "together"
	if (process.env.FIREWORKS_API_KEY) return "fireworks"
	if (process.env.NEBIUS_API_KEY) return "nebius"
	if (process.env.OPENAI_COMPATIBLE_CUSTOM_KEY) return "openai"
	return undefined
}

