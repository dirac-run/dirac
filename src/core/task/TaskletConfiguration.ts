import { ALL_PROVIDERS, type ModelProviderSelection } from "@shared/api"

export interface TaskletStartOptions {
	/** User-global role selected for this assignment; default captures the parent model. */
	type: string
}

/** Durable delegation choices only; credentials and authority come from the current parent. */
export interface TaskletConfiguration {
	/** Absent only for historical conversations whose role was not recorded. */
	name?: string
	modelSelection: ModelProviderSelection
}

/** Persisted conversation configuration is a selection, never provider access or role policy. */
export function assertTaskletConfiguration(value: unknown): asserts value is TaskletConfiguration {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This historical tasklet has no saved model selection. Its history remains available; start a new subagent with an explicit role to continue the work.")
	const configuration = value as Record<string, unknown>
	if (Object.keys(configuration).some((key) => key !== "name" && key !== "modelSelection")) {
		throw new Error("Unsupported saved tasklet configuration field")
	}
	if (configuration.name !== undefined && (typeof configuration.name !== "string" || !configuration.name.trim())) throw new Error("Tasklet role name must be non-empty when recorded")
	const selection = configuration.modelSelection
	if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Tasklet conversation has no saved model selection")
	const fields = selection as Record<string, unknown>
	const allowed = new Set([
		"provider", "modelId", "modelInfo", "openAiProfileName", "vsCodeLmModelSelector",
		"awsBedrockCustomSelected", "awsBedrockCustomModelBaseId", "reasoningEffort", "thinkingBudgetTokens", "geminiThinkingLevel",
	])
	if (Object.keys(fields).some((key) => !allowed.has(key))) throw new Error("Unsupported saved tasklet model selection field")
	if (!ALL_PROVIDERS.includes(fields.provider as ModelProviderSelection["provider"]) ||
		typeof fields.modelId !== "string" || !fields.modelId.trim()) {
		throw new Error("Tasklet selection requires a supported provider and model ID")
	}
}
