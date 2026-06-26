/**
 * Canonical model IDs used across test suites.
 * Centralizes the 100+ scattered hardcoded model ID strings in test files
 * so model migrations update one place, not 14 files.
 */
export const TEST_MODEL_IDS = {
	ANTHROPIC: "claude-3-5-sonnet",
	ANTHROPIC_FULL: "claude-3-5-sonnet-20241022",
	ANTHROPIC_HAIKU: "claude-3-5-haiku-20241022",
	ANTHROPIC_OPUS: "claude-3-opus",
	ANTHROPIC_BEDROCK: "anthropic.claude-3-5-sonnet-20241022",
	ANTHROPIC_OPENROUTER: "anthropic/claude-3.5-sonnet",
	OPENAI: "gpt-4",
	OPENAI_GPT4O: "gpt-4o",
	OPENAI_GPT35: "gpt-3.5-turbo",
	GEMINI: "gemini-2.5-pro",
	GEMINI_FLASH: "gemini-2.5-flash",
	GEMINI_OPENROUTER: "google/gemini-2.5-pro",
} as const

export type TestModelId = keyof typeof TEST_MODEL_IDS
