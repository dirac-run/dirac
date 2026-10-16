/**
 * Shared provider model metadata for CLI surfaces.
 *
 * Keep this free of React/Ink imports so non-UI entrypoints such as ACP can use
 * the same provider/model lists as the interactive CLI.
 */

import type { Controller } from "@/core/controller";
import { refreshGithubCopilotModels } from "@/core/controller/models/refreshGithubCopilotModels";
import { getHuggingFaceModels } from "@/core/controller/models/refreshHuggingFaceModels";
import { getOpenAiModels } from "@/core/controller/models/refreshOpenAiModels";
import { refreshOpenRouterModels } from "@/core/controller/models/refreshOpenRouterModels";
import {
	type ApiProvider,
	anthropicDefaultModelId,
	anthropicModels,
	basetenDefaultModelId,
	basetenModels,
	bedrockDefaultModelId,
	bedrockModels,
	cerebrasDefaultModelId,
	cerebrasModels,
	claudeCodeDefaultModelId,
	claudeCodeModels,
	deepSeekDefaultModelId,
	deepSeekModels,
	unbiasedDefaultModelId,
	unbiasedModels,
	doubaoDefaultModelId,
	doubaoModels,
	fireworksDefaultModelId,
	fireworksModels,
	geminiDefaultModelId,
	geminiModels,
	groqDefaultModelId,
	groqModels,
	huaweiCloudMaasDefaultModelId,
	huaweiCloudMaasModels,
	huggingFaceDefaultModelId,
	huggingFaceModels,
	internationalQwenDefaultModelId,
	internationalQwenModels,
	mainlandQwenModels,
	internationalZAiDefaultModelId,
	internationalZAiModels,
	mainlandZAiModels,
	minimaxDefaultModelId,
	minimaxModels,
	mistralDefaultModelId,
	mistralModels,
	moonshotDefaultModelId,
	moonshotModels,
	nebiusDefaultModelId,
	nebiusModels,
	nousResearchDefaultModelId,
	nousResearchModels,
	openAiCodexDefaultModelId,
	openAiCodexModels,
	openAiNativeDefaultModelId,
	openAiNativeModels,
	qwenCodeDefaultModelId,
	qwenCodeModels,
	sambanovaDefaultModelId,
	sambanovaModels,
	vertexDefaultModelId,
	vertexModels,
	wandbDefaultModelId,
	wandbModels,
	xaiDefaultModelId,
	xaiModels,
} from "@/shared/api";
import { getProviderDefaultModelId } from "@/shared/storage/provider-keys";
import { usesOpenRouterModels } from "./openrouter-models";

export const providerModels: Record<string, { models: Record<string, unknown>; defaultId: string }> = {
	anthropic: { models: anthropicModels, defaultId: anthropicDefaultModelId },
	baseten: { models: basetenModels, defaultId: basetenDefaultModelId },
	bedrock: { models: bedrockModels, defaultId: bedrockDefaultModelId },
	cerebras: { models: cerebrasModels, defaultId: cerebrasDefaultModelId },
	"claude-code": { models: claudeCodeModels, defaultId: claudeCodeDefaultModelId },
	deepseek: { models: deepSeekModels, defaultId: deepSeekDefaultModelId },
	unbiased: { models: unbiasedModels, defaultId: unbiasedDefaultModelId },
	doubao: { models: doubaoModels, defaultId: doubaoDefaultModelId },
	fireworks: { models: fireworksModels, defaultId: fireworksDefaultModelId },
	gemini: { models: geminiModels, defaultId: geminiDefaultModelId },
	groq: { models: groqModels, defaultId: groqDefaultModelId },
	"huawei-cloud-maas": { models: huaweiCloudMaasModels, defaultId: huaweiCloudMaasDefaultModelId },
	huggingface: { models: huggingFaceModels, defaultId: huggingFaceDefaultModelId },
	minimax: { models: minimaxModels, defaultId: minimaxDefaultModelId },
	mistral: { models: mistralModels, defaultId: mistralDefaultModelId },
	moonshot: { models: moonshotModels, defaultId: moonshotDefaultModelId },
	nebius: { models: nebiusModels, defaultId: nebiusDefaultModelId },
	nousResearch: { models: nousResearchModels, defaultId: nousResearchDefaultModelId },
	"openai-codex": { models: openAiCodexModels, defaultId: openAiCodexDefaultModelId },
	"openai-native": { models: openAiNativeModels, defaultId: openAiNativeDefaultModelId },
	qwen: { models: { ...internationalQwenModels, ...mainlandQwenModels }, defaultId: internationalQwenDefaultModelId },
	"qwen-code": { models: qwenCodeModels, defaultId: qwenCodeDefaultModelId },
	sambanova: { models: sambanovaModels, defaultId: sambanovaDefaultModelId },
	vertex: { models: vertexModels, defaultId: vertexDefaultModelId },
	wandb: { models: wandbModels, defaultId: wandbDefaultModelId },
	xai: { models: xaiModels, defaultId: xaiDefaultModelId },
	zai: { models: { ...internationalZAiModels, ...mainlandZAiModels }, defaultId: internationalZAiDefaultModelId },
}

export interface DynamicModelFetchOptions {
	controller?: Controller
	baseUrl?: string
	apiKey?: string
}

// Single source of truth mapping dynamic providers to their remote catalog loaders.
const DYNAMIC_MODEL_LOADERS: Record<string, (options: DynamicModelFetchOptions) => Promise<Record<string, unknown>>> = {
	openrouter: (options) => refreshOpenRouterModels(options.controller),
	huggingface: () => getHuggingFaceModels(),
	"github-copilot": () => refreshGithubCopilotModels(),
	openai: (options) => getOpenAiModels(options),
}

const CUSTOM_MODEL_LABELS: Record<string, string> = {
	bedrock: "Custom (ARN / Inference Profile)",
	openrouter: "Custom Model ID / Preset",
	openai: "Custom Model ID / Preset",
}

export function hasStaticModels(provider: string): boolean {
	return provider in providerModels
}

export function hasDynamicModels(provider: string): boolean {
	return provider in DYNAMIC_MODEL_LOADERS
}

export function fetchDynamicModels(
	provider: string,
	options: DynamicModelFetchOptions = {},
): Promise<Record<string, unknown>> {
	const loader = DYNAMIC_MODEL_LOADERS[provider]
	if (!loader) throw new Error(`Provider ${provider} does not support dynamic model discovery`)
	return loader(options)
}

export function hasModelPicker(provider: string): boolean {
	return hasStaticModels(provider) || hasDynamicModels(provider)
}

export function getCustomModelLabel(provider: string): string | undefined {
	return CUSTOM_MODEL_LABELS[provider]
}

export function getDefaultModelId(provider: string): string {
	if (usesOpenRouterModels(provider)) return ""
	if (provider === "github-copilot") return "gpt-4o"
	if (provider === "dify") return "dify-workflow"
	return providerModels[provider]?.defaultId || getProviderDefaultModelId(provider as ApiProvider) || ""
}

export function getModelList(provider: string): string[] {
	if (!hasStaticModels(provider)) return []
	if (provider === "huggingface") {
		return Object.entries(huggingFaceModels)
			.filter(([, info]) => info.supportsTools)
			.map(([id]) => id)
	}
	return Object.keys(providerModels[provider].models)
}
