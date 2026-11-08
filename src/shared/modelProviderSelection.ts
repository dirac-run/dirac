import {
	modelSupportsInferenceSpeed,
	providerSupportsInferenceSpeed,
	type ApiConfiguration,
	type ApiProvider,
	type ModelProviderSelection,
} from "@shared/api"
import type { InferenceSpeed, Mode } from "@shared/storage/types"

const PROVIDER_MODEL_FIELD_SUFFIX: Partial<Record<ApiProvider, string>> = {
	openrouter: "OpenRouter",
	openai: "OpenAi",
	lmstudio: "LmStudio",
	litellm: "LiteLlm",
	requesty: "Requesty",
	together: "Together",
	fireworks: "Fireworks",
	groq: "Groq",
	baseten: "Baseten",
	huggingface: "HuggingFace",
	"huawei-cloud-maas": "HuaweiCloudMaas",
	aihubmix: "Aihubmix",
	"github-copilot": "GithubCopilot",
	"vercel-ai-gateway": "VercelAiGateway",
	nousResearch: "NousResearch",
}

const PROVIDER_MODEL_INFO_FIELD_SUFFIX: Partial<Record<ApiProvider, string>> = {
	openrouter: "OpenRouter",
	openai: "OpenAi",
	litellm: "LiteLlm",
	requesty: "Requesty",
	groq: "Groq",
	baseten: "Baseten",
	huggingface: "HuggingFace",
	"huawei-cloud-maas": "HuaweiCloudMaas",
	aihubmix: "Aihubmix",
	"vercel-ai-gateway": "VercelAiGateway",
}

/**
 * Projects a secret-free provider/model selection into the existing mode-based
 * handler configuration fields. The returned object never contains credentials.
 */
export function modelProviderSelectionUpdates(
	mode: Mode,
	selection: ModelProviderSelection,
	inferenceSpeed?: InferenceSpeed,
): Partial<ApiConfiguration> {
	const prefix = mode === "plan" ? "planMode" : "actMode"
	const updates: Record<string, unknown> = {
		[`${prefix}ApiProvider`]: selection.provider,
		[`${prefix}ApiModelId`]: selection.modelId,
		// Missing independent reasoning settings clear the active model's values.
		[`${prefix}ReasoningEffort`]: selection.reasoningEffort,
		[`${prefix}ThinkingBudgetTokens`]: selection.thinkingBudgetTokens,
		[`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`]: selection.geminiThinkingLevel,
	}
	if (
		(inferenceSpeed === "fast" && !modelSupportsInferenceSpeed(selection.provider, selection.modelId)) ||
		(inferenceSpeed === "standard" && !providerSupportsInferenceSpeed(selection.provider))
	) {
		updates[`${prefix}InferenceSpeed`] = "default"
	}

	const modelFieldSuffix = PROVIDER_MODEL_FIELD_SUFFIX[selection.provider]
	if (modelFieldSuffix) {
		updates[`${prefix}${modelFieldSuffix}ModelId`] = selection.modelId
	}

	const modelInfoFieldSuffix = PROVIDER_MODEL_INFO_FIELD_SUFFIX[selection.provider]
	if (modelInfoFieldSuffix) {
		updates[`${prefix}${modelInfoFieldSuffix}ModelInfo`] = selection.modelInfo
	}

	if (selection.provider === "lmstudio") {
		// LM Studio's legacy setting is also the handler's context-window contract.
		// Own the value even when metadata is absent rather than inherit another model's limit.
		updates.lmStudioMaxTokens = selection.modelInfo?.contextWindow?.toString()
	}

	if (selection.provider === "vscode-lm") {
		updates[`${prefix}VsCodeLmModelSelector`] = selection.vsCodeLmModelSelector
	}

	if (selection.provider === "bedrock") {
		updates[`${prefix}AwsBedrockCustomSelected`] = selection.awsBedrockCustomSelected
		updates[`${prefix}AwsBedrockCustomModelBaseId`] = selection.awsBedrockCustomModelBaseId
	}

	if (selection.provider === "openai") {
		updates[`${prefix}OpenAiProfileName`] = selection.openAiProfileName
	}

	return updates as Partial<ApiConfiguration>
}
