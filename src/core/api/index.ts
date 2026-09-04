import {
    ApiConfiguration,
    type ApiProvider,
    getModelInfo,
    ModelInfo,
    type ModelProviderSelection,
    modelSupportsInferenceSpeed,
    openAiModelInfoSaneDefaults,
    providerSupportsInferenceSpeed,
    QwenApiRegions,
} from "@shared/api"
import { DEFAULT_INFERENCE_SPEED, type InferenceSpeed, isInferenceSpeed, type Mode } from "@shared/storage/types"
import { DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { DiracTool } from "@/shared/tools"
import { ApiConfigurationError, ApiConfigurationErrorCode } from "./ApiConfigurationError"
import type {
    ApiConversationCompactionRequest,
    ApiConversationCompactionResult,
    ApiConversationRequestOptions,
} from "./conversation"
import { modelProviderSelectionUpdates } from "./modelProviderSelection"
import { AIhubmixHandler } from "./providers/aihubmix"
import { AnthropicHandler } from "./providers/anthropic"
import { BasetenHandler } from "./providers/baseten"
import { AwsBedrockHandler } from "./providers/bedrock"
import { CerebrasHandler } from "./providers/cerebras"
import { ClaudeCodeHandler } from "./providers/claude-code"
import { DeepSeekHandler } from "./providers/deepseek"
import { DifyHandler } from "./providers/dify"
import { DoubaoHandler } from "./providers/doubao"
import { FireworksHandler } from "./providers/fireworks"
import { GeminiHandler } from "./providers/gemini"
import { GithubCopilotHandler } from "./providers/github-copilot"
import { GroqHandler } from "./providers/groq"
import { HuaweiCloudMaaSHandler } from "./providers/huawei-cloud-maas"
import { HuggingFaceHandler } from "./providers/huggingface"
import { LiteLlmHandler } from "./providers/litellm"
import { LmStudioHandler } from "./providers/lmstudio"
import { MinimaxHandler } from "./providers/minimax"
import { MistralHandler } from "./providers/mistral"
import { MoonshotHandler } from "./providers/moonshot"
import { NebiusHandler } from "./providers/nebius"
import { NousResearchHandler } from "./providers/nousresearch"
import { OpenAiHandler } from "./providers/openai"
import { OpenAiCodexHandler } from "./providers/openai-codex"
import { OpenAiNativeHandler } from "./providers/openai-native"
import { OpenAiResponsesCompatibleHandler } from "./providers/openai-responses-compatible"
import { OpenRouterHandler } from "./providers/openrouter"
import { QwenHandler } from "./providers/qwen"
import { QwenCodeHandler } from "./providers/qwen-code"
import { RequestyHandler } from "./providers/requesty"
import { SambanovaHandler } from "./providers/sambanova"
import { TogetherHandler } from "./providers/together"
import { VercelAIGatewayHandler } from "./providers/vercel-ai-gateway"
import { VertexHandler } from "./providers/vertex"
import { VsCodeLmHandler } from "./providers/vscode-lm"
import { WandbHandler } from "./providers/wandb"
import { XAIHandler } from "./providers/xai"
import { ZAiHandler } from "./providers/zai"
import { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

export { ApiConfigurationError, ApiConfigurationErrorCode } from "./ApiConfigurationError"
export type {
	ApiConversationCheckpoint,
	ApiConversationCompactionRequest,
	ApiConversationCompactionResult,
	ApiConversationContinuationReset,
	ApiConversationProviderState,
	ApiConversationRequestOptions,
	PendingApiConversationCompaction,
} from "./conversation"
export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
	disableRetries?: boolean
	enableParallelToolCalling?: boolean
	inferenceSpeed?: InferenceSpeed
}
export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: DiracTool[],
		options?: ApiConversationRequestOptions,
	): ApiStream
	compactConversation?(request: ApiConversationCompactionRequest): Promise<ApiConversationCompactionResult>
	supportsNativeWebSearch?(): boolean
	/** Whether Dirac may estimate cost when the provider omits it. Defaults to true. */
	shouldEstimateCost?(): boolean
	getModel(): ApiHandlerModel
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
	abort?(): void
}

export interface ApiHandlerModel {
	id: string
	info: ModelInfo
}

export interface ApiProviderInfo {
	providerId: string
	model: ApiHandlerModel
	mode: Mode
	customPrompt?: string // "compact"
	supportsNativeWebSearch?: boolean
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

/** Resolves all mode-specific fields from config so provider cases use plain properties. */
export function resolveModeConfig(options: Omit<ApiConfiguration, "apiProvider">, mode: Mode) {
	const isPlan = mode === "plan"
	return {
		apiModelId: isPlan ? options.planModeApiModelId : options.actModeApiModelId,
		thinkingBudgetTokens: isPlan ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
		reasoningEffort: isPlan ? options.planModeReasoningEffort : options.actModeReasoningEffort,
		inferenceSpeed: isPlan ? options.planModeInferenceSpeed : options.actModeInferenceSpeed,
		openRouterModelId: isPlan ? options.planModeOpenRouterModelId : options.actModeOpenRouterModelId,
		openRouterModelInfo: isPlan ? options.planModeOpenRouterModelInfo : options.actModeOpenRouterModelInfo,
		openAiModelId: isPlan ? options.planModeOpenAiModelId : options.actModeOpenAiModelId,
		openAiModelInfo: isPlan ? options.planModeOpenAiModelInfo : options.actModeOpenAiModelInfo,
		openAiProfileName: isPlan ? options.planModeOpenAiProfileName : options.actModeOpenAiProfileName,
		lmStudioModelId: isPlan ? options.planModeLmStudioModelId : options.actModeLmStudioModelId,
		requestyModelId: isPlan ? options.planModeRequestyModelId : options.actModeRequestyModelId,
		requestyModelInfo: isPlan ? options.planModeRequestyModelInfo : options.actModeRequestyModelInfo,
		fireworksModelId: isPlan ? options.planModeFireworksModelId : options.actModeFireworksModelId,
		togetherModelId: isPlan ? options.planModeTogetherModelId : options.actModeTogetherModelId,
		liteLlmModelId: isPlan ? options.planModeLiteLlmModelId : options.actModeLiteLlmModelId,
		liteLlmModelInfo: isPlan ? options.planModeLiteLlmModelInfo : options.actModeLiteLlmModelInfo,
		vsCodeLmModelSelector: isPlan ? options.planModeVsCodeLmModelSelector : options.actModeVsCodeLmModelSelector,
		huggingFaceModelId: isPlan ? options.planModeHuggingFaceModelId : options.actModeHuggingFaceModelId,
		huggingFaceModelInfo: isPlan ? options.planModeHuggingFaceModelInfo : options.actModeHuggingFaceModelInfo,
		awsBedrockCustomSelected: isPlan ? options.planModeAwsBedrockCustomSelected : options.actModeAwsBedrockCustomSelected,
		awsBedrockCustomModelBaseId: isPlan
			? options.planModeAwsBedrockCustomModelBaseId
			: options.actModeAwsBedrockCustomModelBaseId,
		groqModelId: isPlan ? options.planModeGroqModelId : options.actModeGroqModelId,
		groqModelInfo: isPlan ? options.planModeGroqModelInfo : options.actModeGroqModelInfo,
		basetenModelId: isPlan ? options.planModeBasetenModelId : options.actModeBasetenModelId,
		basetenModelInfo: isPlan ? options.planModeBasetenModelInfo : options.actModeBasetenModelInfo,
		huaweiCloudMaasModelId: isPlan ? options.planModeHuaweiCloudMaasModelId : options.actModeHuaweiCloudMaasModelId,
		huaweiCloudMaasModelInfo: isPlan ? options.planModeHuaweiCloudMaasModelInfo : options.actModeHuaweiCloudMaasModelInfo,
		nousResearchModelId: isPlan ? options.planModeNousResearchModelId : options.actModeNousResearchModelId,
		vercelAiGatewayModelId: isPlan ? options.planModeVercelAiGatewayModelId : options.actModeVercelAiGatewayModelId,
		vercelAiGatewayModelInfo: isPlan ? options.planModeVercelAiGatewayModelInfo : options.actModeVercelAiGatewayModelInfo,
		aihubmixModelId: isPlan ? options.planModeAihubmixModelId : options.actModeAihubmixModelId,
		aihubmixModelInfo: isPlan ? options.planModeAihubmixModelInfo : options.actModeAihubmixModelInfo,
	}
}

const PROVIDER_REGISTRY: Record<
	string,
	(config: ApiConfiguration, modeConfig: ReturnType<typeof resolveModeConfig>) => ApiHandler
> = {
	anthropic: (cfg, mc) =>
		new AnthropicHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			apiKey: cfg.apiKey,
			anthropicBaseUrl: cfg.anthropicBaseUrl,
			anthropicHeaders: cfg.anthropicHeaders,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			reasoningEffort: mc.reasoningEffort,
			inferenceSpeed: mc.inferenceSpeed,
		}),
	openrouter: (cfg, mc) =>
		new OpenRouterHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			openRouterApiKey: cfg.openRouterApiKey,
			openRouterModelId: mc.openRouterModelId,
			openRouterModelInfo: mc.openRouterModelInfo,
			openRouterProviderSorting: cfg.openRouterProviderSorting,
			openRouterPinnedProviders: cfg.openRouterPinnedProviders,
			openRouterPreventFallbacks: cfg.openRouterPreventFallbacks,
			reasoningEffort: mc.reasoningEffort,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			enableParallelToolCalling: cfg.enableParallelToolCalling,
		}),
	bedrock: (cfg, mc) =>
		new AwsBedrockHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			apiModelId: mc.apiModelId,
			awsAccessKey: cfg.awsAccessKey,
			awsSecretKey: cfg.awsSecretKey,
			awsSessionToken: cfg.awsSessionToken,
			awsRegion: cfg.awsRegion,
			awsAuthentication: cfg.awsAuthentication,
			awsBedrockApiKey: cfg.awsBedrockApiKey,
			awsUseCrossRegionInference: cfg.awsUseCrossRegionInference,
			awsUseGlobalInference: cfg.awsUseGlobalInference,
			awsBedrockUsePromptCache: cfg.awsBedrockUsePromptCache,
			awsUseProfile: cfg.awsUseProfile,
			awsProfile: cfg.awsProfile,
			awsBedrockEndpoint: cfg.awsBedrockEndpoint,
			awsBedrockCustomSelected: mc.awsBedrockCustomSelected,
			awsBedrockCustomModelBaseId: mc.awsBedrockCustomModelBaseId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			reasoningEffort: mc.reasoningEffort,
		}),
	vertex: (cfg, mc) =>
		new VertexHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			vertexProjectId: cfg.vertexProjectId,
			vertexRegion: cfg.vertexRegion,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			geminiApiKey: cfg.geminiApiKey,
			geminiBaseUrl: cfg.geminiBaseUrl,
			reasoningEffort: mc.reasoningEffort,
			ulid: cfg.ulid,
		}),
	openai: (cfg, mc) => {
		const profile = cfg.openAiCompatibleProfiles?.find((p) => p.name === mc.openAiProfileName)
		if (mc.openAiProfileName && !profile) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ProfileMissing,
				`OpenAI-compatible profile not found: ${mc.openAiProfileName}`,
				"Select an available profile before retrying.",
			)
		}
		const openAiBaseUrl = profile ? profile.baseUrl : cfg.openAiBaseUrl
		const openAiApiKey = profile ? profile.apiKey : cfg.openAiApiKey
		const openAiModelId = mc.openAiModelId ?? profile?.modelId
		const openAiHeaders = profile ? profile.headers : cfg.openAiHeaders
		const azureApiVersion = profile ? profile.azureApiVersion : cfg.azureApiVersion
		let openAiModelInfo = mc.openAiModelInfo
		if (!openAiModelInfo && profile && openAiModelId === profile.modelId) openAiModelInfo = profile.modelInfo
		if (!openAiModelInfo && openAiModelId) openAiModelInfo = getModelInfo(openAiModelId)
		const isCustomUrl = openAiBaseUrl && openAiBaseUrl.startsWith("http")
		if (cfg.openAiCompatibleCustomApiKey || isCustomUrl) {
			openAiModelInfo = {
				...(openAiModelInfo || openAiModelInfoSaneDefaults),
				supportsTools: true,
				supportsReasoning: true,
				isR1FormatRequired: true,
			}
		}
		const apiKey = cfg.openAiCompatibleCustomApiKey || openAiApiKey
		if (apiKey) {
			Logger.info(`Using OpenAI API key (from ${cfg.openAiCompatibleCustomApiKey ? "custom key" : "standard key"})`)
		}
		if (openAiBaseUrl?.replace(/\/+$/, "").endsWith("/responses")) {
			const normalizedBaseUrl = openAiBaseUrl.replace(/\/responses\/?$/, "")
			return new OpenAiResponsesCompatibleHandler({
				onRetryAttempt: cfg.onRetryAttempt,
				disableRetries: cfg.disableRetries,
				openAiApiKey: apiKey,
				openAiBaseUrl: normalizedBaseUrl,
				openAiModelId,
				openAiModelInfo,
				reasoningEffort: mc.reasoningEffort,
				enableParallelToolCalling: cfg.enableParallelToolCalling,
			})
		}
		return new OpenAiHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			openAiApiKey: apiKey,
			openAiBaseUrl,
			azureApiVersion,
			openAiHeaders,
			openAiModelId,
			openAiModelInfo,
			reasoningEffort: mc.reasoningEffort,
			enableParallelToolCalling: cfg.enableParallelToolCalling,
		})
	},
	lmstudio: (cfg, mc) =>
		new LmStudioHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			lmStudioBaseUrl: cfg.lmStudioBaseUrl,
			lmStudioModelId: mc.lmStudioModelId,
			lmStudioMaxTokens: cfg.lmStudioMaxTokens,
		}),
	gemini: (cfg, mc) =>
		new GeminiHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			vertexProjectId: cfg.vertexProjectId,
			vertexRegion: cfg.vertexRegion,
			geminiApiKey: cfg.geminiApiKey,
			geminiBaseUrl: cfg.geminiBaseUrl,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			reasoningEffort: mc.reasoningEffort,
			apiModelId: mc.apiModelId,
			ulid: cfg.ulid,
			geminiSearchEnabled: cfg.geminiSearchEnabled,
		}),
	"openai-native": (cfg, mc) =>
		new OpenAiNativeHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			openAiNativeApiKey: cfg.openAiNativeApiKey,
			reasoningEffort: mc.reasoningEffort,
			inferenceSpeed: mc.inferenceSpeed,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			enableParallelToolCalling: cfg.enableParallelToolCalling,
		}),
	"openai-codex": (cfg, mc) =>
		new OpenAiCodexHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			reasoningEffort: mc.reasoningEffort,
			inferenceSpeed: mc.inferenceSpeed,
			apiModelId: mc.apiModelId,
			enableParallelToolCalling: cfg.enableParallelToolCalling,
		}),
	deepseek: (cfg, mc) =>
		new DeepSeekHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			deepSeekApiKey: cfg.deepSeekApiKey,
			reasoningEffort: mc.reasoningEffort,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			apiModelId: mc.apiModelId,
		}),
	requesty: (cfg, mc) =>
		new RequestyHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			requestyBaseUrl: cfg.requestyBaseUrl,
			requestyApiKey: cfg.requestyApiKey,
			reasoningEffort: mc.reasoningEffort,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			requestyModelId: mc.requestyModelId,
			requestyModelInfo: mc.requestyModelInfo,
		}),
	fireworks: (cfg, mc) =>
		new FireworksHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			fireworksApiKey: cfg.fireworksApiKey,
			fireworksModelId: mc.fireworksModelId,
		}),
	together: (cfg, mc) =>
		new TogetherHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			togetherApiKey: cfg.togetherApiKey,
			togetherModelId: mc.togetherModelId,
		}),
	qwen: (cfg, mc) =>
		new QwenHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			qwenApiKey: cfg.qwenApiKey,
			qwenApiLine: cfg.qwenApiLine === QwenApiRegions.INTERNATIONAL ? QwenApiRegions.INTERNATIONAL : QwenApiRegions.CHINA,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
		}),
	"qwen-code": (cfg, mc) =>
		new QwenCodeHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			qwenCodeOauthPath: cfg.qwenCodeOauthPath,
			apiModelId: mc.apiModelId,
		}),
	doubao: (cfg, mc) =>
		new DoubaoHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			doubaoApiKey: cfg.doubaoApiKey,
			apiModelId: mc.apiModelId,
		}),
	mistral: (cfg, mc) =>
		new MistralHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			mistralApiKey: cfg.mistralApiKey,
			apiModelId: mc.apiModelId,
		}),
	"vscode-lm": (cfg, mc) =>
		new VsCodeLmHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			vsCodeLmModelSelector: mc.vsCodeLmModelSelector,
		}),
	"github-copilot": (cfg, mc) => new GithubCopilotHandler({ onRetryAttempt: cfg.onRetryAttempt, apiModelId: mc.apiModelId }),
	litellm: (cfg, mc) =>
		new LiteLlmHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			liteLlmApiKey: cfg.liteLlmApiKey,
			liteLlmBaseUrl: cfg.liteLlmBaseUrl,
			liteLlmModelId: mc.liteLlmModelId,
			liteLlmModelInfo: mc.liteLlmModelInfo,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
			liteLlmUsePromptCache: cfg.liteLlmUsePromptCache,
			ulid: cfg.ulid,
		}),
	moonshot: (cfg, mc) =>
		new MoonshotHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			moonshotApiKey: cfg.moonshotApiKey,
			moonshotApiLine: cfg.moonshotApiLine,
			apiModelId: mc.apiModelId,
		}),
	huggingface: (cfg, mc) =>
		new HuggingFaceHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			huggingFaceApiKey: cfg.huggingFaceApiKey,
			huggingFaceModelId: mc.huggingFaceModelId,
			huggingFaceModelInfo: mc.huggingFaceModelInfo,
		}),
	nebius: (cfg, mc) =>
		new NebiusHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			nebiusApiKey: cfg.nebiusApiKey,
			apiModelId: mc.apiModelId,
		}),
	xai: (cfg, mc) =>
		new XAIHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			xaiApiKey: cfg.xaiApiKey,
			reasoningEffort: mc.reasoningEffort,
			apiModelId: mc.apiModelId,
		}),
	sambanova: (cfg, mc) =>
		new SambanovaHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			sambanovaApiKey: cfg.sambanovaApiKey,
			apiModelId: mc.apiModelId,
		}),
	cerebras: (cfg, mc) =>
		new CerebrasHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			cerebrasApiKey: cfg.cerebrasApiKey,
			apiModelId: mc.apiModelId,
		}),
	groq: (cfg, mc) =>
		new GroqHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			groqApiKey: cfg.groqApiKey,
			groqModelId: mc.groqModelId,
			groqModelInfo: mc.groqModelInfo,
			apiModelId: mc.apiModelId,
		}),
	baseten: (cfg, mc) =>
		new BasetenHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			basetenApiKey: cfg.basetenApiKey,
			basetenModelId: mc.basetenModelId,
			basetenModelInfo: mc.basetenModelInfo,
			apiModelId: mc.apiModelId,
		}),
	"claude-code": (cfg, mc) =>
		new ClaudeCodeHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			claudeCodePath: cfg.claudeCodePath,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
		}),
	"huawei-cloud-maas": (cfg, mc) =>
		new HuaweiCloudMaaSHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			huaweiCloudMaasApiKey: cfg.huaweiCloudMaasApiKey,
			huaweiCloudMaasModelId: mc.huaweiCloudMaasModelId,
			huaweiCloudMaasModelInfo: mc.huaweiCloudMaasModelInfo,
		}),
	dify: (cfg) => new DifyHandler({ difyApiKey: cfg.difyApiKey, difyBaseUrl: cfg.difyBaseUrl }),
	"vercel-ai-gateway": (cfg, mc) =>
		new VercelAIGatewayHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			vercelAiGatewayApiKey: cfg.vercelAiGatewayApiKey,
			openRouterModelId: mc.vercelAiGatewayModelId,
			openRouterModelInfo: mc.vercelAiGatewayModelInfo,
			reasoningEffort: mc.reasoningEffort,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
		}),
	zai: (cfg, mc) =>
		new ZAiHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			zaiApiLine: cfg.zaiApiLine,
			zaiApiKey: cfg.zaiApiKey,
			reasoningEffort: mc.reasoningEffort,
			apiModelId: mc.apiModelId,
		}),
	aihubmix: (cfg, mc) =>
		new AIhubmixHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			apiKey: cfg.aihubmixApiKey,
			baseURL: cfg.aihubmixBaseUrl,
			appCode: cfg.aihubmixAppCode,
			modelId: mc.aihubmixModelId,
			modelInfo: mc.aihubmixModelInfo,
		}),
	minimax: (cfg, mc) =>
		new MinimaxHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			minimaxApiKey: cfg.minimaxApiKey,
			minimaxApiLine: cfg.minimaxApiLine,
			apiModelId: mc.apiModelId,
			thinkingBudgetTokens: mc.thinkingBudgetTokens,
		}),
	nousResearch: (cfg, mc) =>
		new NousResearchHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			nousResearchApiKey: cfg.nousResearchApiKey,
			apiModelId: mc.nousResearchModelId,
		}),
	wandb: (cfg, mc) =>
		new WandbHandler({
			onRetryAttempt: cfg.onRetryAttempt,
			disableRetries: cfg.disableRetries,
			wandbApiKey: cfg.wandbApiKey,
			apiModelId: mc.apiModelId,
		}),
}

function configuredProvider(configuration: ApiConfiguration, mode: Mode): string | undefined {
	return (mode === "plan" ? configuration.planModeApiProvider : configuration.actModeApiProvider) ?? configuration.apiProvider
}

function assertProviderSupported(provider: string | undefined): asserts provider is string {
	if (!provider) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.ProviderMissing,
			"API provider is not configured",
			"Select a provider before starting or resuming the task.",
		)
	}
	if (!PROVIDER_REGISTRY[provider]) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.ProviderUnsupported,
			`Unsupported API provider: ${provider}`,
			"Select a supported provider before retrying.",
		)
	}
}

/**
 * Validate provider identity and prerequisites for one runtime mode, or for both
 * persisted modes when no mode is supplied.
 */
export function validateApiConfiguration(configuration: ApiConfiguration, mode?: Mode): void {
	const modes = mode === undefined ? (["plan", "act"] as const) : [mode]
	for (const selectedMode of modes) {
		const provider = configuredProvider(configuration, selectedMode)
		assertProviderSupported(provider)
		const modeConfig = resolveModeConfig(configuration, selectedMode)
		const configuredInferenceSpeed = modeConfig.inferenceSpeed
		if (configuredInferenceSpeed !== undefined && !isInferenceSpeed(configuredInferenceSpeed)) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ProviderConfigurationIncomplete,
				`Invalid inference speed: ${String(configuredInferenceSpeed)}`,
				"Select Default, Standard, or Fast before retrying.",
			)
		}
		const inferenceSpeed = configuredInferenceSpeed ?? DEFAULT_INFERENCE_SPEED
		if (inferenceSpeed === "standard" && !providerSupportsInferenceSpeed(provider as ApiProvider)) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ModelUnavailable,
				`Provider ${provider} does not support inference speed controls`,
				"Reset inference speed to Default before retrying.",
			)
		}
		if (
			inferenceSpeed === "fast" &&
			(!modeConfig.apiModelId || !modelSupportsInferenceSpeed(provider as ApiProvider, modeConfig.apiModelId))
		) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ModelUnavailable,
				`Model ${modeConfig.apiModelId || "(unconfigured)"} does not support Fast mode`,
				"Select a Fast-capable model or reset inference speed to Default.",
			)
		}
		if (
			provider === "openai" &&
			modeConfig.openAiProfileName &&
			!configuration.openAiCompatibleProfiles?.some((profile) => profile.name === modeConfig.openAiProfileName)
		) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ProfileMissing,
				`OpenAI-compatible profile not found: ${modeConfig.openAiProfileName}`,
				"Select an available profile before retrying.",
			)
		}
		if (provider === "dify" && (!configuration.difyApiKey || !configuration.difyBaseUrl)) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ProviderConfigurationIncomplete,
				"Dify requires both an API key and base URL",
				"Configure both values before selecting Dify.",
			)
		}
		const dynamicProviderModelId =
			provider === "openrouter"
				? modeConfig.openRouterModelId
				: provider === "together"
					? modeConfig.togetherModelId
					: provider === "vercel-ai-gateway"
						? modeConfig.vercelAiGatewayModelId
						: provider === "aihubmix"
							? modeConfig.aihubmixModelId
							: undefined
		if (["openrouter", "together", "vercel-ai-gateway", "aihubmix"].includes(provider) && !dynamicProviderModelId) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.ModelUnavailable,
				`${provider} requires an explicit model ID`,
				"Select a model before retrying.",
			)
		}
	}
}

export function createRegistryHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const m = resolveModeConfig(configuration, mode)
	const provider = configuration.apiProvider
	assertProviderSupported(provider)
	const factory = PROVIDER_REGISTRY[provider]
	return factory(configuration, m)
}

function createHandlerForProvider(
	apiProvider: string | undefined,
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ApiHandler {
	const fullConfig = { ...options, apiProvider } as ApiConfiguration
	return createRegistryHandler(fullConfig, mode)
}

export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const { planModeApiProvider, actModeApiProvider, apiProvider: fallbackProvider, ...options } = configuration
	const apiProvider = (mode === "plan" ? planModeApiProvider : actModeApiProvider) ?? fallbackProvider
	const handler = createHandlerForProvider(apiProvider, options, mode)
	const { thinkingBudgetTokens } = resolveModeConfig(options, mode)
	if (!thinkingBudgetTokens || thinkingBudgetTokens <= 0) return handler

	const modelInfo = handler.getModel().info
	const maxBudget = modelInfo.thinkingConfig?.maxBudget
	const isAnthropicFamily = apiProvider === "anthropic" || apiProvider === "vertex" || apiProvider === "bedrock"
	const effectiveCap =
		maxBudget ?? (modelInfo.maxTokens ? (isAnthropicFamily ? modelInfo.maxTokens - 1 : modelInfo.maxTokens) : undefined)

	if (!effectiveCap || thinkingBudgetTokens <= effectiveCap) {
		return handler
	}

	const clippedOptions = {
		...options,
		[mode === "plan" ? "planModeThinkingBudgetTokens" : "actModeThinkingBudgetTokens"]: effectiveCap,
	}
	return createHandlerForProvider(apiProvider, clippedOptions, mode)
}

export interface ApiHandlerForSelectionOptions {
	ulid?: string
}

/**
 * Creates an invocation-local configuration for a secret-free provider/model
 * selection. Existing credentials and endpoints are retained, while no Plan or
 * Act configuration object is mutated.
 */
export function createApiConfigurationForModelProviderSelection(
	baseConfiguration: ApiConfiguration,
	selection: ModelProviderSelection,
	options: ApiHandlerForSelectionOptions = {},
): ApiConfiguration {
	return {
		...baseConfiguration,
		...modelProviderSelectionUpdates("act", selection, baseConfiguration.actModeInferenceSpeed),
		apiProvider: selection.provider,
		ulid: options.ulid,
		disableRetries: true,
		actModeThinkingBudgetTokens: undefined,
		actModeReasoningEffort: undefined,
		geminiSearchEnabled: false,
		enableParallelToolCalling: false,
		onRetryAttempt: undefined,
	}
}

/** Builds a fresh one-shot handler for an independently selected Utility model. */
export function buildApiHandlerForSelection(
	baseConfiguration: ApiConfiguration,
	selection: ModelProviderSelection,
	options: ApiHandlerForSelectionOptions = {},
): ApiHandler {
	return buildApiHandler(createApiConfigurationForModelProviderSelection(baseConfiguration, selection, options), "act")
}

/**
 * Resolves a provider/model candidate through the same handler construction used
 * for inference. Static handlers return their declared default when the
 * candidate is incompatible; dynamic handlers preserve accepted IDs.
 */
export function resolveModelIdForProvider(
	baseConfiguration: ApiConfiguration,
	provider: ApiProvider,
	modelId: string,
	mode: Mode = "act",
): string {
	const configuredProvider = mode === "plan" ? baseConfiguration.planModeApiProvider : baseConfiguration.actModeApiProvider
	const selection: ModelProviderSelection = { provider, modelId }
	if (provider === "bedrock" && configuredProvider === "bedrock") {
		selection.awsBedrockCustomSelected =
			mode === "plan"
				? baseConfiguration.planModeAwsBedrockCustomSelected
				: baseConfiguration.actModeAwsBedrockCustomSelected
		selection.awsBedrockCustomModelBaseId =
			mode === "plan"
				? baseConfiguration.planModeAwsBedrockCustomModelBaseId
				: baseConfiguration.actModeAwsBedrockCustomModelBaseId
	}

	const configuration = {
		...baseConfiguration,
		...modelProviderSelectionUpdates(
			mode,
			selection,
			mode === "plan" ? baseConfiguration.planModeInferenceSpeed : baseConfiguration.actModeInferenceSpeed,
		),
		apiProvider: provider,
		disableRetries: true,
		geminiSearchEnabled: false,
		enableParallelToolCalling: false,
		onRetryAttempt: undefined,
	}
	return buildApiHandler(configuration, mode).getModel().id
}
