import type { ApiProvider } from "./api/providerNames"

/** Existing compatible/aggregator paths that pass user-supplied model IDs through. */
export function supportsCustomModelId(provider: ApiProvider): boolean {
	return CUSTOM_MODEL_ID_PROVIDERS.has(provider)
}

const CUSTOM_MODEL_ID_PROVIDERS = new Set<ApiProvider>([
	"openai",
	"lmstudio",
	"litellm",
	"openrouter",
	"requesty",
	"together",
	"huggingface",
	"vercel-ai-gateway",
	"aihubmix",
])
