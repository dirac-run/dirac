import type { ModelInfo } from "./types"
import { isOpenaiReasoningEffort } from "../../storage/types"
import { MODEL_CAPABILITIES } from "./capabilities"

export const ANTHROPIC_MIN_THINKING_BUDGET = 1_024
export const ANTHROPIC_MAX_THINKING_BUDGET = 6_000

// Claude Haiku 5.5 bills every token at the higher rates when total prompt input exceeds 100K.
export const CLAUDE_HAIKU_5_5_TIERS = [
	{
		contextWindow: 100_000,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheWritesPrice: 0.125,
		cacheReadsPrice: 0.01,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 0.5,
		outputPrice: 2.5,
		cacheWritesPrice: 0.625,
		cacheReadsPrice: 0.05,
	},
]

export type AnthropicModelId = keyof typeof anthropicModels

export const anthropicDefaultModelId: AnthropicModelId = "claude-sonnet-5"

export const anthropicModels = {
	"claude-sonnet-5-5": {
		...MODEL_CAPABILITIES["claude-sonnet-5-5"],
		supportsPromptCache: true,
		inputPrice: 2.0,
		outputPrice: 10.0,
		cacheWritesPrice: 2.5,
		cacheReadsPrice: 0.1,
	},
	"claude-haiku-5-5": {
		...MODEL_CAPABILITIES["claude-haiku-5-5"],
		supportsPromptCache: true,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheWritesPrice: 0.125,
		cacheReadsPrice: 0.01,
		tiers: CLAUDE_HAIKU_5_5_TIERS,
	},
	"claude-fable-5-1": {
		...MODEL_CAPABILITIES["claude-fable-5-1"],
		supportsPromptCache: true,
		inputPrice: 10.0,
		outputPrice: 50.0,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 0.25,
	},
	"claude-sonnet-4-6": {
		...MODEL_CAPABILITIES["claude-sonnet-4-6"],
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"claude-sonnet-5": {
		...MODEL_CAPABILITIES["claude-sonnet-5"],
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"claude-haiku-4-5-20251001": {
		...MODEL_CAPABILITIES["claude-haiku-4-5-20251001"],
		supportsPromptCache: true,
		inputPrice: 1,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
	},
	"claude-opus-4-6": {
		...MODEL_CAPABILITIES["claude-opus-4-6"],
		supportsPromptCache: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"claude-opus-4-7": {
		...MODEL_CAPABILITIES["claude-opus-4-7"],
		supportsPromptCache: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"claude-opus-4-8": {
		...MODEL_CAPABILITIES["claude-opus-4-8"],
		supportsPromptCache: true,
		supportsFastMode: true,
		fastModePriceMultiplier: 2,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		description: "Claude Opus 4.8. Anthropic Fast mode is available at 2x token pricing when enabled.",
	},
	"claude-opus-5": {
		...MODEL_CAPABILITIES["claude-opus-5"],
		supportsPromptCache: true,
		supportsFastMode: true,
		fastModePriceMultiplier: 2,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		description: "Claude Opus 5. Anthropic Fast mode is available at 2x token pricing when enabled.",
	},
	"claude-opus-5-5": {
		...MODEL_CAPABILITIES["claude-opus-5-5"],
		supportsPromptCache: true,
		supportsFastMode: true,
		fastModePriceMultiplier: 2,
		inputPrice: 4.0,
		outputPrice: 20.0,
		cacheWritesPrice: 5.0,
		cacheReadsPrice: 0.2,
		description: "Claude Opus 5.5. Adaptive thinking is always on. Fast mode is available at 2x token pricing.",
	},

	"claude-fable-5": {
		...MODEL_CAPABILITIES["claude-fable-5"],
		supportsPromptCache: true,
		inputPrice: 10.0,
		outputPrice: 50.0,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
} as const satisfies Record<string, ModelInfo>

export function getAnthropicReasoningEffort(modelInfo: ModelInfo, requestedEffort?: string): string {
	if (!modelInfo.supportsReasoningEffort && !modelInfo.thinkingAlwaysOn) {
		return requestedEffort || modelInfo.defaultReasoningEffort || "high"
	}
	if (isOpenaiReasoningEffort(requestedEffort) && modelInfo.reasoningEffortOptions?.includes(requestedEffort)) {
		return requestedEffort
	}
	return modelInfo.defaultReasoningEffort || "medium"
}

export type AnthropicThinkingConfig =
	| { type: "adaptive"; display: "summarized" }
	| { type: "enabled"; budget_tokens: number }
	| { type: "between_tools" }
	| { type: "disabled" }

/** Translate the budget toggle into a thinking mode the selected model accepts. */
export function getAnthropicThinkingConfig(
	modelId: string,
	modelInfo: ModelInfo,
	budgetTokens: number | undefined,
	requestedEffort?: string,
): AnthropicThinkingConfig | undefined {
	if (!modelInfo.supportsReasoning) return undefined

	const effort = getAnthropicReasoningEffort(modelInfo, requestedEffort)
	const requiresAdaptiveEffort = modelInfo.supportsReasoningEffort && (effort === "xhigh" || effort === "max")
	const defaultAdaptive = modelInfo.supportsReasoningEffort && budgetTokens === undefined
	if (modelInfo.thinkingAlwaysOn || (budgetTokens ?? 0) > 0 || requiresAdaptiveEffort || defaultAdaptive) {
		return isAnthropicAdaptiveThinkingSupported(modelId, modelInfo)
			? { type: "adaptive", display: "summarized" }
			: { type: "enabled", budget_tokens: budgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET }
	}
	if (modelInfo.supportsBetweenToolsThinking) return { type: "between_tools" }
	// Models with effort controls think by default, so omission does not disable thinking.
	if (modelInfo.supportsReasoningEffort) return { type: "disabled" }
	return undefined
}

/**
 * Helper to determine if an Anthropic model supports adaptive thinking.
 * Default opt-in pattern: If it's a known "old" model (<= 4.5), use enabled.
 * Otherwise (>= 4.6 or unknown future model), use adaptive.
 */

export function isAnthropicAdaptiveThinkingSupported(modelId: string, info?: ModelInfo): boolean {
	if (info?.supportsAdaptiveThinking !== undefined) {
		return info.supportsAdaptiveThinking
	}

	const id = modelId.toLowerCase()
	const isAnthropic = id.startsWith("claude-") || id.includes("anthropic.claude-") || id.startsWith("anthropic/")

	if (!isAnthropic) {
		return false
	}

	// Default opt-in pattern:
	// If it's a known "old" model (<= 4.5), use enabled.
	// Otherwise (>= 4.6 or unknown future model), use adaptive.

	const versionMatch = id.match(/claude-(\d+)[.-](\d+)/)
	if (versionMatch) {
		const major = parseInt(versionMatch[1])
		const minor = parseInt(versionMatch[2])
		if (major < 4 || (major === 4 && minor <= 5)) {
			return false // Old model
		}
	}

	// Also check for specific old models that might not match the regex perfectly
	if (id.includes("claude-3")) {
		return false
	}

	return true // Default to adaptive for everything else
}
