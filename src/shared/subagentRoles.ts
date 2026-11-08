import { ALL_PROVIDERS } from "./api/providerNames"
import type { ModelProviderSelection } from "./api/models/types"
import { isOpenaiReasoningEffort } from "./storage/types"

/** User-global execution presets; descriptions are discovery text, not system prompts. */
export interface SubagentRole {
	name: string
	description: string
	enabled: boolean
	modelSelection?: ModelProviderSelection
}

export const DEFAULT_SUBAGENT_ROLES: SubagentRole[] = [
	{ name: "Scout", description: "Quick code examinations.", enabled: false },
	{ name: "Reviewer", description: "Code review.", enabled: false },
	{ name: "Simple coder", description: "Simple coding tasks.", enabled: false },
	{ name: "Complex coder", description: "Complex coding tasks.", enabled: false },
]

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
	return value as Record<string, unknown>
}

function requireText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`)
	return value.trim()
}

function validateSelection(value: unknown): ModelProviderSelection {
	const selection = requireRecord(value, "Role model selection")
	const allowed = new Set([
		"provider", "modelId", "modelInfo", "openAiProfileName", "vsCodeLmModelSelector",
		"awsBedrockCustomSelected", "awsBedrockCustomModelBaseId", "reasoningEffort", "thinkingBudgetTokens", "geminiThinkingLevel",
	])
	for (const key of Object.keys(selection)) {
		if (!allowed.has(key)) throw new Error(`Unsupported role model selection field: ${key}`)
	}
	if (!ALL_PROVIDERS.includes(selection.provider as ModelProviderSelection["provider"])) {
		throw new Error("Role model selection requires a supported provider")
	}
	requireText(selection.modelId, "Role model ID")
	if (selection.openAiProfileName !== undefined) {
		requireText(selection.openAiProfileName, "Named endpoint")
		if (selection.provider !== "openai") throw new Error("Named endpoints require the OpenAI-compatible provider")
	}
	if (selection.thinkingBudgetTokens !== undefined &&
		(!Number.isSafeInteger(selection.thinkingBudgetTokens) || (selection.thinkingBudgetTokens as number) < 0)) {
		throw new Error("Thinking budget must be a non-negative integer")
	}
	if (selection.reasoningEffort !== undefined && !isOpenaiReasoningEffort(selection.reasoningEffort)) {
		throw new Error("Unsupported reasoning effort")
	}
	if (selection.geminiThinkingLevel !== undefined) requireText(selection.geminiThinkingLevel, "Gemini thinking level")
	return structuredClone(Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined))) as unknown as ModelProviderSelection
}

/** Validate a complete catalog before persistence; an empty catalog intentionally removes all roles. */
export function validateSubagentRoles(value: unknown): SubagentRole[] {
	if (!Array.isArray(value)) throw new Error("Subagent roles must be an array")
	const names = new Set<string>()
	return value.map((entry) => {
		const role = requireRecord(entry, "Subagent role")
		for (const key of Object.keys(role)) {
			if (!["name", "description", "enabled", "modelSelection"].includes(key)) {
				throw new Error(`Unsupported subagent role field: ${key}`)
			}
		}
		const name = requireText(role.name, "Role name")
		const identity = name.toLowerCase()
		if (identity === "default") throw new Error("The default subagent role is not configurable")
		if (names.has(identity)) throw new Error(`Duplicate subagent role name: ${name}`)
		names.add(identity)
		const description = requireText(role.description, "Role description")
		if (/[\r\n]/.test(description)) throw new Error("Role description must be a single line")
		if (typeof role.enabled !== "boolean") throw new Error("Role enabled state must be a boolean")
		const modelSelection = role.modelSelection === undefined ? undefined : validateSelection(role.modelSelection)
		if (role.enabled && !modelSelection) throw new Error(`Enabled role ${name} requires a model selection`)
		return { name, description, enabled: role.enabled, ...(modelSelection ? { modelSelection } : {}) }
	})
}
