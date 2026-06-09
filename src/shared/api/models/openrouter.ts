import type { ModelInfo } from "./types"
import { CLAUDE_SONNET_1M_SUFFIX } from "./anthropic"

export const openRouterDefaultModelId = "anthropic/claude-sonnet-4.5" // will always exist in openRouterModels
export const openRouterClaudeSonnet41mModelId = `anthropic/claude-sonnet-4${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet451mModelId = `anthropic/claude-sonnet-4.5${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet461mModelId = `anthropic/claude-sonnet-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus461mModelId = `anthropic/claude-opus-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus48ModelId = "anthropic/claude-opus-4.8"
export const openRouterClaudeOpus481mModelId = `anthropic/claude-opus-4.8${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeFable5ModelId = "anthropic/claude-fable-5"
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
