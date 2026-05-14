/**
 * Shared provider model metadata for CLI surfaces.
 *
 * Keep this free of React/Ink imports so non-UI entrypoints such as ACP can use
 * the same provider/model lists as the interactive CLI.
 */

import {
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
	internationalZAiDefaultModelId,
	internationalZAiModels,
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
} from "@/shared/api"
import { getOpenRouterDefaultModelId, usesOpenRouterModels } from "./openrouter-models"

export const providerModels: Record<string, { models: Record<string, unknown>; defaultId: string }> = {
	anthropic: { models: anthropicModels, defaultId: anthropicDefaultModelId },
	baseten: { models: basetenModels, defaultId: basetenDefaultModelId },
	bedrock: { models: bedrockModels, defaultId: bedrockDefaultModelId },
	cerebras: { models: cerebrasModels, defaultId: cerebrasDefaultModelId },
	"claude-code": { models: claudeCodeModels, defaultId: claudeCodeDefaultModelId },
	deepseek: { models: deepSeekModels, defaultId: deepSeekDefaultModelId },
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
	qwen: { models: internationalQwenModels, defaultId: internationalQwenDefaultModelId },
	"qwen-code": { models: qwenCodeModels, defaultId: qwenCodeDefaultModelId },
	sambanova: { models: sambanovaModels, defaultId: sambanovaDefaultModelId },
	vertex: { models: vertexModels, defaultId: vertexDefaultModelId },
	wandb: { models: wandbModels, defaultId: wandbDefaultModelId },
	xai: { models: xaiModels, defaultId: xaiDefaultModelId },
	zai: { models: internationalZAiModels, defaultId: internationalZAiDefaultModelId },
}

export function hasStaticModels(provider: string): boolean {
	return provider in providerModels
}

export function hasModelPicker(provider: string): boolean {
	return hasStaticModels(provider) || usesOpenRouterModels(provider) || provider === "github-copilot"
}

export function getDefaultModelId(provider: string): string {
	if (usesOpenRouterModels(provider)) {
		return getOpenRouterDefaultModelId()
	}
	return providerModels[provider]?.defaultId || ""
}

export function getModelList(provider: string): string[] {
	if (!hasStaticModels(provider)) return []
	return Object.keys(providerModels[provider].models)
}
