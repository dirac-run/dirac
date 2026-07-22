import {
	ApiConfiguration,
	ApiProvider,
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
	liteLlmModelInfoSaneDefaults,
	ModelInfo,
	mainlandQwenDefaultModelId,
	mainlandQwenModels,
	mainlandZAiDefaultModelId,
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
	openAiModelInfoSaneDefaults,
	openAiNativeDefaultModelId,
	openAiNativeModels,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	qwenCodeDefaultModelId,
	qwenCodeModels,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
	sambanovaDefaultModelId,
	sambanovaModels,
	vertexDefaultModelId,
	vertexModels,
	wandbDefaultModelId,
	wandbModels,
	xaiDefaultModelId,
	xaiModels,
} from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import * as reasoningSupport from "@shared/utils/reasoning-support"

export function supportsReasoningEffortForModelId(modelId?: string, modelInfo?: ModelInfo): boolean {
	if ((modelInfo as any)?.supportsReasoningEffort) {
		return true
	}
	return reasoningSupport.supportsReasoningEffortForModel(modelId)
}

/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, dirac, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
	apiProvider: ApiProvider | undefined,
	openRouterModels: Record<string, ModelInfo>,
	diracModels: Record<string, ModelInfo> | null,
	vercelAiGatewayModels: Record<string, ModelInfo>,
	liteLlmModels: Record<string, ModelInfo>,
	requestyModels: Record<string, ModelInfo>,
	groqModels: Record<string, ModelInfo>,
	basetenModels: Record<string, ModelInfo>,
	huggingFaceModels: Record<string, ModelInfo>,
	aihubmixModels: Record<string, ModelInfo>,
	githubCopilotModels: Record<string, ModelInfo> | undefined,
): Record<string, ModelInfo> {
	switch (apiProvider) {
		case "openrouter":
			return openRouterModels
		case "dirac":
			return diracModels || {}
		case "vercel-ai-gateway":
			return vercelAiGatewayModels
		case "litellm":
			return liteLlmModels
		case "requesty":
			return requestyModels
		case "groq":
			return groqModels
		case "baseten":
			return basetenModels
		case "huggingface":
			return huggingFaceModels
		case "aihubmix":
			return aihubmixModels
		case "github-copilot":
			return githubCopilotModels || {}
		case "anthropic":
			return anthropicModels
		case "claude-code":
			return claudeCodeModels
		case "bedrock":
			return bedrockModels
		case "vertex":
			return vertexModels
		case "gemini":
			return geminiModels
		case "openai-native":
			return openAiNativeModels
		case "openai-codex":
			return openAiCodexModels
		case "deepseek":
			return deepSeekModels
		case "qwen-code":
			return qwenCodeModels
		case "doubao":
			return doubaoModels
		case "mistral":
			return mistralModels
		case "xai":
			return xaiModels
		case "moonshot":
			return moonshotModels
		case "nebius":
			return nebiusModels
		case "wandb":
			return wandbModels
		case "sambanova":
			return sambanovaModels
		case "cerebras":
			return cerebrasModels
		case "huawei-cloud-maas":
			return huaweiCloudMaasModels
		case "fireworks":
			return fireworksModels
		case "minimax":
			return minimaxModels
		case "nousResearch":
			return nousResearchModels
		default:
			return {}
	}
}

/**
 * Interface for normalized API configuration
 */
export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Normalizes API configuration to ensure consistent values
 */
export function normalizeApiConfiguration(
	apiConfiguration: ApiConfiguration | undefined,
	currentMode: Mode,
): NormalizedApiConfig {
	const provider =
		(currentMode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) || "anthropic"

	const modelId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId

	const getProviderData = (models: Record<string, ModelInfo>, defaultId: string) => {
		let selectedModelId: string
		let selectedModelInfo: ModelInfo
		if (modelId && modelId in models) {
			selectedModelId = modelId
			selectedModelInfo = models[modelId]
		} else {
			selectedModelId = defaultId
			selectedModelInfo = models[defaultId]
		}
		return {
			selectedProvider: provider,
			selectedModelId,
			selectedModelInfo,
		}
	}

	switch (provider) {
		case "anthropic":
			return getProviderData(anthropicModels, anthropicDefaultModelId)
		case "claude-code":
			return getProviderData(claudeCodeModels, claudeCodeDefaultModelId)
		case "bedrock":
			const awsBedrockCustomSelected =
				currentMode === "plan"
					? apiConfiguration?.planModeAwsBedrockCustomSelected
					: apiConfiguration?.actModeAwsBedrockCustomSelected
			if (awsBedrockCustomSelected) {
				const baseModelId =
					currentMode === "plan"
						? apiConfiguration?.planModeAwsBedrockCustomModelBaseId
						: apiConfiguration?.actModeAwsBedrockCustomModelBaseId

				return {
					selectedProvider: provider,
					selectedModelId: modelId || bedrockDefaultModelId,
					selectedModelInfo:
						(baseModelId && bedrockModels[baseModelId as keyof typeof bedrockModels]) ||
						bedrockModels[bedrockDefaultModelId],
				}
			}
			return getProviderData(bedrockModels, bedrockDefaultModelId)
		case "vertex":
			return getProviderData(vertexModels, vertexDefaultModelId)
		case "gemini":
			return getProviderData(geminiModels, geminiDefaultModelId)
		case "openai-native":
			return getProviderData(openAiNativeModels, openAiNativeDefaultModelId)
		case "openai-codex":
			return getProviderData(openAiCodexModels, openAiCodexDefaultModelId)
		case "deepseek":
			return getProviderData(deepSeekModels, deepSeekDefaultModelId)
		case "qwen":
			const qwenModels = apiConfiguration?.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
			const qwenDefaultId =
				apiConfiguration?.qwenApiLine === "china" ? mainlandQwenDefaultModelId : internationalQwenDefaultModelId
			return getProviderData(qwenModels, qwenDefaultId)
		case "qwen-code":
			return getProviderData(qwenCodeModels, qwenCodeDefaultModelId)
		case "doubao":
			return getProviderData(doubaoModels, doubaoDefaultModelId)
		case "mistral":
			return getProviderData(mistralModels, mistralDefaultModelId)
		case "openrouter":
			const openRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const openRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openRouterModelId || openRouterDefaultModelId,
				selectedModelInfo: openRouterModelInfo || openRouterDefaultModelInfo,
			}
		case "requesty":
			const requestyModelId =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelId : apiConfiguration?.actModeRequestyModelId
			const requestyModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelInfo : apiConfiguration?.actModeRequestyModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: requestyModelId || requestyDefaultModelId,
				selectedModelInfo: requestyModelInfo || requestyDefaultModelInfo,
			}
		case "dirac":
			const fallbackOpenRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const fallbackOpenRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			const diracModelId =
				(currentMode === "plan" ? apiConfiguration?.planModeDiracModelId : apiConfiguration?.actModeDiracModelId) ||
				fallbackOpenRouterModelId ||
				openRouterDefaultModelId
			const diracModelInfo =
				(currentMode === "plan" ? apiConfiguration?.planModeDiracModelInfo : apiConfiguration?.actModeDiracModelInfo) ||
				fallbackOpenRouterModelInfo ||
				openRouterDefaultModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: diracModelId,
				selectedModelInfo: diracModelInfo,
			}
		case "openai":
			const openAiModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId
			const openAiModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openAiModelId || "",
				selectedModelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			}
		case "lmstudio":
			const lmStudioModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId
			return {
				selectedProvider: provider,
				selectedModelId: lmStudioModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.lmStudioMaxTokens ?? 32768),
				},
			}
		case "vscode-lm":
			const vsCodeLmModelSelector =
				currentMode === "plan"
					? apiConfiguration?.planModeVsCodeLmModelSelector
					: apiConfiguration?.actModeVsCodeLmModelSelector
			return {
				selectedProvider: provider,
				selectedModelId: vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor}/${vsCodeLmModelSelector.family}` : "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsImages: false, // VSCode LM API currently doesn't support images
				},
			}
		case "litellm": {
			const liteLlmModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId
			const liteLlmModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: liteLlmModelId || "",
				selectedModelInfo: liteLlmModelInfo || liteLlmModelInfoSaneDefaults,
			}
		}
		case "xai":
			return getProviderData(xaiModels, xaiDefaultModelId)
		case "moonshot":
			return getProviderData(moonshotModels, moonshotDefaultModelId)
		case "huggingface":
			const huggingFaceModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelId
					: apiConfiguration?.actModeHuggingFaceModelId
			const huggingFaceModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelInfo
					: apiConfiguration?.actModeHuggingFaceModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huggingFaceModelId || huggingFaceDefaultModelId,
				selectedModelInfo: huggingFaceModelInfo || huggingFaceModels[huggingFaceDefaultModelId],
			}
		case "nebius":
			return getProviderData(nebiusModels, nebiusDefaultModelId)
		case "wandb":
			return getProviderData(wandbModels, wandbDefaultModelId)
		case "sambanova":
			return getProviderData(sambanovaModels, sambanovaDefaultModelId)
		case "cerebras":
			return getProviderData(cerebrasModels, cerebrasDefaultModelId)
		case "groq":
			const groqModelId =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelId : apiConfiguration?.actModeGroqModelId
			const groqModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelInfo : apiConfiguration?.actModeGroqModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: groqModelId || groqDefaultModelId,
				selectedModelInfo: groqModelInfo || groqModels[groqDefaultModelId],
			}
		case "baseten": {
			const basetenModelId =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelId : apiConfiguration?.actModeBasetenModelId
			const basetenModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelInfo : apiConfiguration?.actModeBasetenModelInfo
			const finalBasetenModelId = basetenModelId || basetenDefaultModelId
			return {
				selectedProvider: provider,
				selectedModelId: finalBasetenModelId,
				selectedModelInfo: basetenModelInfo ||
					basetenModels[finalBasetenModelId as keyof typeof basetenModels] ||
					basetenModels[basetenDefaultModelId] || {
					description: "Baseten model",
				},
			}
		}
		case "huawei-cloud-maas":
			const huaweiCloudMaasModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelId
					: apiConfiguration?.actModeHuaweiCloudMaasModelId
			const huaweiCloudMaasModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelInfo
					: apiConfiguration?.actModeHuaweiCloudMaasModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huaweiCloudMaasModelId || huaweiCloudMaasDefaultModelId,
				selectedModelInfo: huaweiCloudMaasModelInfo || huaweiCloudMaasModels[huaweiCloudMaasDefaultModelId],
			}
		case "dify":
			return {
				selectedProvider: provider,
				selectedModelId: "dify-workflow",
				selectedModelInfo: {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsImages: true,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
					description: "Dify workflow - model selection is configured in your Dify application",
				},
			}
		case "vercel-ai-gateway":
			// Vercel AI Gateway uses its own model fields
			const vercelModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelId
					: apiConfiguration?.actModeVercelAiGatewayModelId
			const vercelModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelInfo
					: apiConfiguration?.actModeVercelAiGatewayModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: vercelModelId || "",
				selectedModelInfo: vercelModelInfo || openRouterDefaultModelInfo,
			}
		case "zai":
			const zaiModels = apiConfiguration?.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
			const zaiDefaultId =
				apiConfiguration?.zaiApiLine === "china" ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
			return getProviderData(zaiModels, zaiDefaultId)
		case "fireworks":
			const fireworksModelId =
				currentMode === "plan" ? apiConfiguration?.planModeFireworksModelId : apiConfiguration?.actModeFireworksModelId
			return {
				selectedProvider: provider,
				selectedModelId: fireworksModelId || fireworksDefaultModelId,
				selectedModelInfo:
					fireworksModelId && fireworksModelId in fireworksModels
						? fireworksModels[fireworksModelId as keyof typeof fireworksModels]
						: fireworksModels[fireworksDefaultModelId],
			}
		case "aihubmix":
			const aihubmixModelId =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelId : apiConfiguration?.actModeAihubmixModelId
			const aihubmixModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelInfo : apiConfiguration?.actModeAihubmixModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: aihubmixModelId || "",
				selectedModelInfo: aihubmixModelInfo || openAiModelInfoSaneDefaults,
			}
		case "minimax":
			return getProviderData(minimaxModels, minimaxDefaultModelId)
		case "nousResearch":
			const nousResearchModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeNousResearchModelId
					: apiConfiguration?.actModeNousResearchModelId
			return {
				selectedProvider: provider,
				selectedModelId: nousResearchModelId || nousResearchDefaultModelId,
				selectedModelInfo:
					nousResearchModelId && nousResearchModelId in nousResearchModels
						? nousResearchModels[nousResearchModelId as keyof typeof nousResearchModels]
						: nousResearchModels[nousResearchDefaultModelId],
			}
		default:
			return getProviderData(anthropicModels, anthropicDefaultModelId)
	}
}

/**
 * Gets mode-specific field values from API configuration
 * @param apiConfiguration The API configuration object
 * @param mode The current mode ("plan" or "act")
 * @returns Object containing mode-specific field values for clean destructuring
 */
export function getModeSpecificFields(apiConfiguration: ApiConfiguration | undefined, mode: Mode) {
	const apiProvider = mode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider

	return {
		apiProvider,
		apiModelId: mode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId,
		thinkingBudgetTokens:
			mode === "plan" ? apiConfiguration?.planModeThinkingBudgetTokens : apiConfiguration?.actModeThinkingBudgetTokens,
		reasoningEffort: mode === "plan" ? apiConfiguration?.planModeReasoningEffort : apiConfiguration?.actModeReasoningEffort,
		vsCodeLmModelSelector:
			mode === "plan" ? apiConfiguration?.planModeVsCodeLmModelSelector : apiConfiguration?.actModeVsCodeLmModelSelector,
		awsBedrockCustomSelected:
			mode === "plan"
				? apiConfiguration?.planModeAwsBedrockCustomSelected
				: apiConfiguration?.actModeAwsBedrockCustomSelected,
		awsBedrockCustomModelBaseId:
			mode === "plan"
				? apiConfiguration?.planModeAwsBedrockCustomModelBaseId
				: apiConfiguration?.actModeAwsBedrockCustomModelBaseId,
		openRouterModelId:
			mode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId,
		openRouterModelInfo:
			mode === "plan" ? apiConfiguration?.planModeOpenRouterModelInfo : apiConfiguration?.actModeOpenRouterModelInfo,
		diracModelId: mode === "plan" ? apiConfiguration?.planModeDiracModelId : apiConfiguration?.actModeDiracModelId,
		diracModelInfo: mode === "plan" ? apiConfiguration?.planModeDiracModelInfo : apiConfiguration?.actModeDiracModelInfo,
		openAiModelId: mode === "plan" ? apiConfiguration?.planModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId,
		openAiModelInfo: mode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo,
		openAiProfileName:
			mode === "plan" ? apiConfiguration?.planModeOpenAiProfileName : apiConfiguration?.actModeOpenAiProfileName,
		lmStudioModelId: mode === "plan" ? apiConfiguration?.planModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId,
		liteLlmModelId: mode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId,
		liteLlmModelInfo:
			mode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo,
		requestyModelId: mode === "plan" ? apiConfiguration?.planModeRequestyModelId : apiConfiguration?.actModeRequestyModelId,
		requestyModelInfo:
			mode === "plan" ? apiConfiguration?.planModeRequestyModelInfo : apiConfiguration?.actModeRequestyModelInfo,
		togetherModelId: mode === "plan" ? apiConfiguration?.planModeTogetherModelId : apiConfiguration?.actModeTogetherModelId,
		fireworksModelId:
			mode === "plan" ? apiConfiguration?.planModeFireworksModelId : apiConfiguration?.actModeFireworksModelId,
		groqModelId: mode === "plan" ? apiConfiguration?.planModeGroqModelId : apiConfiguration?.actModeGroqModelId,
		groqModelInfo: mode === "plan" ? apiConfiguration?.planModeGroqModelInfo : apiConfiguration?.actModeGroqModelInfo,
		basetenModelId: mode === "plan" ? apiConfiguration?.planModeBasetenModelId : apiConfiguration?.actModeBasetenModelId,
		basetenModelInfo:
			mode === "plan" ? apiConfiguration?.planModeBasetenModelInfo : apiConfiguration?.actModeBasetenModelInfo,
		huggingFaceModelId:
			mode === "plan" ? apiConfiguration?.planModeHuggingFaceModelId : apiConfiguration?.actModeHuggingFaceModelId,
		huggingFaceModelInfo:
			mode === "plan" ? apiConfiguration?.planModeHuggingFaceModelInfo : apiConfiguration?.actModeHuggingFaceModelInfo,
		huaweiCloudMaasModelId:
			mode === "plan" ? apiConfiguration?.planModeHuaweiCloudMaasModelId : apiConfiguration?.actModeHuaweiCloudMaasModelId,
		huaweiCloudMaasModelInfo:
			mode === "plan"
				? apiConfiguration?.planModeHuaweiCloudMaasModelInfo
				: apiConfiguration?.actModeHuaweiCloudMaasModelInfo,
		aihubmixModelId: mode === "plan" ? apiConfiguration?.planModeAihubmixModelId : apiConfiguration?.actModeAihubmixModelId,
		aihubmixModelInfo:
			mode === "plan" ? apiConfiguration?.planModeAihubmixModelInfo : apiConfiguration?.actModeAihubmixModelInfo,
		githubCopilotModelId:
			mode === "plan" ? apiConfiguration?.planModeGithubCopilotModelId : apiConfiguration?.actModeGithubCopilotModelId,
		githubCopilotModelInfo:
			mode === "plan" ? apiConfiguration?.planModeGithubCopilotModelInfo : apiConfiguration?.actModeGithubCopilotModelInfo,
		nousResearchModelId:
			mode === "plan" ? apiConfiguration?.planModeNousResearchModelId : apiConfiguration?.actModeNousResearchModelId,
		vercelAiGatewayModelId:
			mode === "plan" ? apiConfiguration?.planModeVercelAiGatewayModelId : apiConfiguration?.actModeVercelAiGatewayModelId,
		vercelAiGatewayModelInfo:
			mode === "plan"
				? apiConfiguration?.planModeVercelAiGatewayModelInfo
				: apiConfiguration?.actModeVercelAiGatewayModelInfo,
	}
}

/**
 * Synchronizes mode configurations by copying the source mode's settings to both modes
 * This is used when the "Use different models for Plan and Act modes" toggle is unchecked
 */
export async function syncModeConfigurations(
	apiConfiguration: ApiConfiguration | undefined,
	sourceMode: Mode,
	handleFieldsChange: (updates: Partial<ApiConfiguration>) => Promise<boolean>,
): Promise<void> {
	if (!apiConfiguration) {
		return
	}

	const sourceFields = getModeSpecificFields(apiConfiguration, sourceMode)
	const { apiProvider } = sourceFields

	if (!apiProvider) {
		return
	}

	// Build the complete update object with both plan and act mode fields
	const updates: Partial<ApiConfiguration> = {
		// Always sync common fields
		planModeApiProvider: sourceFields.apiProvider,
		actModeApiProvider: sourceFields.apiProvider,
		planModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		actModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		planModeReasoningEffort: sourceFields.reasoningEffort,
		actModeReasoningEffort: sourceFields.reasoningEffort,
	}

	// Handle provider-specific fields
	switch (apiProvider) {
		case "openrouter":
			updates.planModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.actModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.planModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			updates.actModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			break

		case "dirac":
			updates.planModeDiracModelId = sourceFields.diracModelId
			updates.actModeDiracModelId = sourceFields.diracModelId
			updates.planModeDiracModelInfo = sourceFields.diracModelInfo
			updates.actModeDiracModelInfo = sourceFields.diracModelInfo
			break

		case "requesty":
			updates.planModeRequestyModelId = sourceFields.requestyModelId
			updates.actModeRequestyModelId = sourceFields.requestyModelId
			updates.planModeRequestyModelInfo = sourceFields.requestyModelInfo
			updates.actModeRequestyModelInfo = sourceFields.requestyModelInfo
			break

		case "openai":
			updates.planModeOpenAiModelId = sourceFields.openAiModelId
			updates.actModeOpenAiModelId = sourceFields.openAiModelId
			updates.planModeOpenAiModelInfo = sourceFields.openAiModelInfo
			updates.actModeOpenAiModelInfo = sourceFields.openAiModelInfo
			updates.planModeOpenAiProfileName = sourceFields.openAiProfileName
			updates.actModeOpenAiProfileName = sourceFields.openAiProfileName
			break

		case "lmstudio":
			updates.planModeLmStudioModelId = sourceFields.lmStudioModelId
			updates.actModeLmStudioModelId = sourceFields.lmStudioModelId
			break

		case "vscode-lm":
			updates.planModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			updates.actModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			break

		case "litellm":
			updates.planModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.actModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.planModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			updates.actModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			break

		case "groq":
			updates.planModeGroqModelId = sourceFields.groqModelId
			updates.actModeGroqModelId = sourceFields.groqModelId
			updates.planModeGroqModelInfo = sourceFields.groqModelInfo
			updates.actModeGroqModelInfo = sourceFields.groqModelInfo
			break

		case "huggingface":
			updates.planModeHuggingFaceModelId = sourceFields.huggingFaceModelId
			updates.actModeHuggingFaceModelId = sourceFields.huggingFaceModelId
			updates.planModeHuggingFaceModelInfo = sourceFields.huggingFaceModelInfo
			updates.actModeHuggingFaceModelInfo = sourceFields.huggingFaceModelInfo
			break

		case "baseten":
			updates.planModeBasetenModelId = sourceFields.basetenModelId
			updates.actModeBasetenModelId = sourceFields.basetenModelId
			updates.planModeBasetenModelInfo = sourceFields.basetenModelInfo
			updates.actModeBasetenModelInfo = sourceFields.basetenModelInfo
			break

		case "together":
			updates.planModeTogetherModelId = sourceFields.togetherModelId
			updates.actModeTogetherModelId = sourceFields.togetherModelId
			break

		case "fireworks":
			updates.planModeFireworksModelId = sourceFields.fireworksModelId
			updates.actModeFireworksModelId = sourceFields.fireworksModelId
			break

		case "bedrock":
			updates.planModeApiModelId = sourceFields.apiModelId
			updates.actModeApiModelId = sourceFields.apiModelId
			updates.planModeAwsBedrockCustomSelected = sourceFields.awsBedrockCustomSelected
			updates.actModeAwsBedrockCustomSelected = sourceFields.awsBedrockCustomSelected
			updates.planModeAwsBedrockCustomModelBaseId = sourceFields.awsBedrockCustomModelBaseId
			updates.actModeAwsBedrockCustomModelBaseId = sourceFields.awsBedrockCustomModelBaseId
			break

		case "huawei-cloud-maas":
			updates.planModeHuaweiCloudMaasModelId = sourceFields.huaweiCloudMaasModelId
			updates.actModeHuaweiCloudMaasModelId = sourceFields.huaweiCloudMaasModelId
			updates.planModeHuaweiCloudMaasModelInfo = sourceFields.huaweiCloudMaasModelInfo
			updates.actModeHuaweiCloudMaasModelInfo = sourceFields.huaweiCloudMaasModelInfo
			break

		case "dify":
			// Dify doesn't have mode-specific model configurations
			// The model is configured in the Dify application itself
			break

		case "vercel-ai-gateway":
			// Vercel AI Gateway uses its own model fields
			updates.planModeVercelAiGatewayModelId = sourceFields.vercelAiGatewayModelId
			updates.actModeVercelAiGatewayModelId = sourceFields.vercelAiGatewayModelId
			updates.planModeVercelAiGatewayModelInfo = sourceFields.vercelAiGatewayModelInfo
			updates.actModeVercelAiGatewayModelInfo = sourceFields.vercelAiGatewayModelInfo
			break

		case "nousResearch":
			updates.planModeNousResearchModelId = sourceFields.nousResearchModelId
			updates.actModeNousResearchModelId = sourceFields.nousResearchModelId
			break

		case "aihubmix":
			updates.planModeAihubmixModelId = sourceFields.aihubmixModelId
			updates.planModeAihubmixModelInfo = sourceFields.aihubmixModelInfo
			updates.actModeAihubmixModelId = sourceFields.aihubmixModelId
			updates.actModeAihubmixModelInfo = sourceFields.aihubmixModelInfo
			break

		// Providers that use apiProvider + apiModelId fields
		case "anthropic":
		case "claude-code":
		case "vertex":
		case "gemini":
		case "openai-native":
		case "openai-codex":
		case "deepseek":
		case "qwen":
		case "doubao":
		case "mistral":
		case "xai":
		case "nebius":
		case "wandb":
		case "sambanova":
		case "cerebras":
		case "zai":
		case "minimax":
		default:
			updates.planModeApiModelId = sourceFields.apiModelId
			updates.actModeApiModelId = sourceFields.apiModelId
			break
	}

	// Make the atomic update
	await handleFieldsChange(updates)
}

export { filterOpenRouterModelIds } from "@shared/utils/model-filters"

// Helper to get provider-specific configuration info and empty state guidance
export const getProviderInfo = (
	provider: ApiProvider,
	apiConfiguration: any,
	effectiveMode: "plan" | "act",
): { modelId?: string; baseUrl?: string; helpText: string } => {
	switch (provider) {
		case "baseten":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeBasetenModelId : apiConfiguration.actModeBasetenModelId,
				baseUrl: apiConfiguration.basetenBaseUrl,
				helpText: "Start Baseten and load a model to begin",
			}
		case "lmstudio":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLmStudioModelId : apiConfiguration.actModeLmStudioModelId,
				baseUrl: apiConfiguration.lmStudioBaseUrl,
				helpText: "Start LM Studio and load a model to begin",
			}
		case "litellm":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLiteLlmModelId : apiConfiguration.actModeLiteLlmModelId,
				baseUrl: apiConfiguration.liteLlmBaseUrl,
				helpText: "Add your LiteLLM proxy URL in settings",
			}
		case "openai":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOpenAiModelId : apiConfiguration.actModeOpenAiModelId,
				baseUrl: apiConfiguration.openAiBaseUrl,
				helpText: "Add your OpenAI API key and endpoint",
			}
		case "vscode-lm":
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Select a VS Code language model from settings",
			}
		case "requesty":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeRequestyModelId : apiConfiguration.actModeRequestyModelId,
				baseUrl: apiConfiguration.requestyBaseUrl,
				helpText: "Add your Requesty API key in settings",
			}
		case "together":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeTogetherModelId : apiConfiguration.actModeTogetherModelId,
				baseUrl: undefined,
				helpText: "Add your Together AI API key in settings",
			}
		case "dify":
			return {
				modelId: undefined,
				baseUrl: apiConfiguration.difyBaseUrl,
				helpText: "Configure your Dify workflow URL and API key",
			}
		case "aihubmix":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeAihubmixModelId : apiConfiguration.actModeAihubmixModelId,
				baseUrl: apiConfiguration.aihubmixBaseUrl,
				helpText: "Add your AIHubMix API key in settings",
			}
		default:
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Configure this provider in model settings",
			}
	}
}
