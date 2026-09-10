import type { ModelInfo } from "../api"
import {
	DEFAULT_OPENAI_REASONING_EFFORT,
	isOpenaiReasoningEffort,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "../storage/types"

function modelIdSupportsReasoningEffort(modelId?: string): boolean {
	if (!modelId) return false

	const id = modelId.toLowerCase()
	return (
		id.includes("gemini") ||
		id.includes("gpt") ||
		id.startsWith("openai/o") ||
		id.includes("/o") ||
		id.startsWith("o") ||
		id.includes("grok") ||
		id.includes("deepseek")
	)
}

export function getReasoningEffortOptionsForModel(
	modelId?: string,
	modelInfo?: Pick<ModelInfo, "supportsReasoningEffort" | "reasoningEffortOptions">,
): readonly OpenaiReasoningEffort[] {
	if (modelInfo?.reasoningEffortOptions?.length) return modelInfo.reasoningEffortOptions
	return modelInfo?.supportsReasoningEffort || modelIdSupportsReasoningEffort(modelId) ? OPENAI_REASONING_EFFORT_OPTIONS : []
}

export function resolveReasoningEffortForModel(
	modelId: string | undefined,
	modelInfo: Pick<ModelInfo, "supportsReasoningEffort" | "reasoningEffortOptions" | "defaultReasoningEffort"> | undefined,
	requestedEffort?: string,
): OpenaiReasoningEffort | undefined {
	const options = getReasoningEffortOptionsForModel(modelId, modelInfo)
	if (options.length === 0) return undefined
	if (isOpenaiReasoningEffort(requestedEffort) && options.includes(requestedEffort)) return requestedEffort

	const modelDefault = modelInfo?.defaultReasoningEffort
	if (modelDefault && options.includes(modelDefault)) return modelDefault
	if (options.includes(DEFAULT_OPENAI_REASONING_EFFORT)) return DEFAULT_OPENAI_REASONING_EFFORT
	return options[0]
}

export function supportsReasoningEffortForModel(
	modelId?: string,
	modelInfo?: Pick<ModelInfo, "supportsReasoningEffort" | "reasoningEffortOptions">,
): boolean {
	return getReasoningEffortOptionsForModel(modelId, modelInfo).length > 0
}
