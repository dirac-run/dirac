import type { ModelInfo } from "./types"
import { anthropicModels } from "./anthropic"

export type ClaudeCodeModelId = keyof typeof claudeCodeModels

export const claudeCodeDefaultModelId: ClaudeCodeModelId = "claude-sonnet-4-6"

export const claudeCodeModels = {
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
	"claude-opus-4-8": {
		...anthropicModels["claude-opus-4-8"],
		supportsImages: false,
		supportsPromptCache: false,
	},
	"claude-opus-4-8[1m]": {
		...anthropicModels["claude-opus-4-8:1m"],
		supportsImages: false,
		supportsPromptCache: false,
	},
} as const satisfies Record<string, ModelInfo>
