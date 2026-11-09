import type { ModelInfo } from "./types"
import { anthropicModels } from "./anthropic"
import { CLAUDE_OPUS_1M_TIERS, CLAUDE_SONNET_1M_TIERS } from "./shared-tiers"

export type ClaudeCodeModelId = keyof typeof claudeCodeModels

export const claudeCodeDefaultModelId: ClaudeCodeModelId = "claude-sonnet-5"

export const claudeCodeModels = {
	"claude-sonnet-5-5": {
		...anthropicModels["claude-sonnet-5-5"],
		supportsImages: false,
		supportsPromptCache: false,
		thinkingAlwaysOn: true,
		supportsBetweenToolsThinking: false,
		defaultReasoningEffort: "medium",
		description: "Requires Claude Code 2.1.284 or later. Claude Code always uses adaptive thinking for this model.",
	},
	"claude-haiku-5-5": {
		...anthropicModels["claude-haiku-5-5"],
		supportsImages: false,
		supportsPromptCache: false,
		thinkingAlwaysOn: true,
		description: "Requires Claude Code 2.1.293 or later. Claude Code always uses adaptive thinking for this model.",
	},
	"claude-fable-5-1": {
		...anthropicModels["claude-fable-5-1"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"opus[1m]": {
		...anthropicModels["claude-opus-4-6"],
		contextWindow: 1_000_000,
		tiers: CLAUDE_OPUS_1M_TIERS,
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
		...anthropicModels["claude-sonnet-4-6"],
		contextWindow: 1_000_000,
		tiers: CLAUDE_SONNET_1M_TIERS,
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-6": {
		...anthropicModels["claude-opus-4-6"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-6[1m]": {
		...anthropicModels["claude-opus-4-6"],
		contextWindow: 1_000_000,
		tiers: CLAUDE_OPUS_1M_TIERS,
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-8": {
		...anthropicModels["claude-opus-4-8"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-8[1m]": {
		...anthropicModels["claude-opus-4-8"],
		contextWindow: 1_000_000,
		tiers: CLAUDE_OPUS_1M_TIERS,
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-5": {
		...anthropicModels["claude-opus-5"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-5-5": {
		...anthropicModels["claude-opus-5-5"],
		supportsImages: false,
		supportsPromptCache: false,
		supportsFastMode: false,
	},

	"claude-sonnet-5": {
		...anthropicModels["claude-sonnet-5"],
		supportsImages: false,
		supportsPromptCache: false,
	},
} as const satisfies Record<string, ModelInfo>
