import { ApiConfiguration, getModelInfo, ModelInfo, openAiModelInfoSaneDefaults, QwenApiRegions } from "@shared/api"
import { Mode } from "@shared/storage/types"
import { DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { DiracTool } from "@/shared/tools"
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

export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
}
export interface ApiHandler {
	createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[], useResponseApi?: boolean): ApiStream
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
		awsBedrockCustomModelBaseId: isPlan ? options.planModeAwsBedrockCustomModelBaseId : options.actModeAwsBedrockCustomModelBaseId,
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

const PROVIDER_REGISTRY: Record<string, (config: ApiConfiguration, modeConfig: ReturnType<typeof resolveModeConfig>) => ApiHandler> = {
	anthropic: (cfg, mc) => new AnthropicHandler({ onRetryAttempt: cfg.onRetryAttempt, apiKey: cfg.apiKey, anthropicBaseUrl: cfg.anthropicBaseUrl, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens, reasoningEffort: mc.reasoningEffort }),
	openrouter: (cfg, mc) => new OpenRouterHandler({ onRetryAttempt: cfg.onRetryAttempt, openRouterApiKey: cfg.openRouterApiKey, openRouterModelId: mc.openRouterModelId, openRouterModelInfo: mc.openRouterModelInfo, openRouterProviderSorting: cfg.openRouterProviderSorting, reasoningEffort: mc.reasoningEffort, thinkingBudgetTokens: mc.thinkingBudgetTokens, enableParallelToolCalling: cfg.enableParallelToolCalling }),
	bedrock: (cfg, mc) => new AwsBedrockHandler({ onRetryAttempt: cfg.onRetryAttempt, apiModelId: mc.apiModelId, awsAccessKey: cfg.awsAccessKey, awsSecretKey: cfg.awsSecretKey, awsSessionToken: cfg.awsSessionToken, awsRegion: cfg.awsRegion, awsAuthentication: cfg.awsAuthentication, awsBedrockApiKey: cfg.awsBedrockApiKey, awsUseCrossRegionInference: cfg.awsUseCrossRegionInference, awsUseGlobalInference: cfg.awsUseGlobalInference, awsBedrockUsePromptCache: cfg.awsBedrockUsePromptCache, awsUseProfile: cfg.awsUseProfile, awsProfile: cfg.awsProfile, awsBedrockEndpoint: cfg.awsBedrockEndpoint, awsBedrockCustomSelected: mc.awsBedrockCustomSelected, awsBedrockCustomModelBaseId: mc.awsBedrockCustomModelBaseId, thinkingBudgetTokens: mc.thinkingBudgetTokens, reasoningEffort: mc.reasoningEffort }),
	vertex: (cfg, mc) => new VertexHandler({ onRetryAttempt: cfg.onRetryAttempt, vertexProjectId: cfg.vertexProjectId, vertexRegion: cfg.vertexRegion, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens, geminiApiKey: cfg.geminiApiKey, geminiBaseUrl: cfg.geminiBaseUrl, reasoningEffort: mc.reasoningEffort, ulid: cfg.ulid }),
	openai: (cfg, mc) => {
		const profile = cfg.openAiCompatibleProfiles?.find((p) => p.name === mc.openAiProfileName)
		const openAiBaseUrl = profile ? profile.baseUrl : cfg.openAiBaseUrl
		const openAiApiKey = profile ? profile.apiKey : cfg.openAiApiKey
		const openAiModelId = profile ? profile.modelId : mc.openAiModelId
		const openAiHeaders = profile ? profile.headers : cfg.openAiHeaders
		const azureApiVersion = profile ? profile.azureApiVersion : cfg.azureApiVersion
		let openAiModelInfo = profile ? profile.modelInfo : mc.openAiModelInfo
		if (!openAiModelInfo && openAiModelId) openAiModelInfo = getModelInfo(openAiModelId)
		const isCustomUrl = openAiBaseUrl && openAiBaseUrl.startsWith("http")
		if (cfg.openAiCompatibleCustomApiKey || isCustomUrl) {
			openAiModelInfo = { ...(openAiModelInfo || openAiModelInfoSaneDefaults), supportsTools: true, supportsReasoning: true, isR1FormatRequired: true }
		}
		const apiKey = cfg.openAiCompatibleCustomApiKey || openAiApiKey
		if (apiKey) {
			const maskedKey = `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`
			Logger.info(`Using OpenAI API key: ${maskedKey} (from ${cfg.openAiCompatibleCustomApiKey ? "custom key" : "standard key"})`)
		}
		if (openAiBaseUrl?.replace(/\/+$/, "").endsWith("/responses")) {
			const normalizedBaseUrl = openAiBaseUrl.replace(/\/responses\/?$/, "")
			return new OpenAiResponsesCompatibleHandler({ onRetryAttempt: cfg.onRetryAttempt, openAiApiKey: apiKey, openAiBaseUrl: normalizedBaseUrl, openAiModelId, openAiModelInfo, reasoningEffort: mc.reasoningEffort })
		}
		return new OpenAiHandler({ onRetryAttempt: cfg.onRetryAttempt, openAiApiKey: apiKey, openAiBaseUrl, azureApiVersion, openAiHeaders, openAiModelId, openAiModelInfo, reasoningEffort: mc.reasoningEffort })
	},
	lmstudio: (cfg, mc) => new LmStudioHandler({ onRetryAttempt: cfg.onRetryAttempt, lmStudioBaseUrl: cfg.lmStudioBaseUrl, lmStudioModelId: mc.lmStudioModelId, lmStudioMaxTokens: cfg.lmStudioMaxTokens }),
	gemini: (cfg, mc) => new GeminiHandler({ onRetryAttempt: cfg.onRetryAttempt, vertexProjectId: cfg.vertexProjectId, vertexRegion: cfg.vertexRegion, geminiApiKey: cfg.geminiApiKey, geminiBaseUrl: cfg.geminiBaseUrl, thinkingBudgetTokens: mc.thinkingBudgetTokens, reasoningEffort: mc.reasoningEffort, apiModelId: mc.apiModelId, ulid: cfg.ulid, geminiSearchEnabled: cfg.geminiSearchEnabled }),
	"openai-native": (cfg, mc) => new OpenAiNativeHandler({ onRetryAttempt: cfg.onRetryAttempt, openAiNativeApiKey: cfg.openAiNativeApiKey, reasoningEffort: mc.reasoningEffort, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens }),
	"openai-codex": (cfg, mc) => new OpenAiCodexHandler({ onRetryAttempt: cfg.onRetryAttempt, reasoningEffort: mc.reasoningEffort, apiModelId: mc.apiModelId }),
	deepseek: (cfg, mc) => new DeepSeekHandler({ onRetryAttempt: cfg.onRetryAttempt, deepSeekApiKey: cfg.deepSeekApiKey, reasoningEffort: mc.reasoningEffort, thinkingBudgetTokens: mc.thinkingBudgetTokens, apiModelId: mc.apiModelId }),
	requesty: (cfg, mc) => new RequestyHandler({ onRetryAttempt: cfg.onRetryAttempt, requestyBaseUrl: cfg.requestyBaseUrl, requestyApiKey: cfg.requestyApiKey, reasoningEffort: mc.reasoningEffort, thinkingBudgetTokens: mc.thinkingBudgetTokens, requestyModelId: mc.requestyModelId, requestyModelInfo: mc.requestyModelInfo }),
	fireworks: (cfg, mc) => new FireworksHandler({ onRetryAttempt: cfg.onRetryAttempt, fireworksApiKey: cfg.fireworksApiKey, fireworksModelId: mc.fireworksModelId }),
	together: (cfg, mc) => new TogetherHandler({ onRetryAttempt: cfg.onRetryAttempt, togetherApiKey: cfg.togetherApiKey, togetherModelId: mc.togetherModelId }),
	qwen: (cfg, mc) => new QwenHandler({ onRetryAttempt: cfg.onRetryAttempt, qwenApiKey: cfg.qwenApiKey, qwenApiLine: cfg.qwenApiLine === QwenApiRegions.INTERNATIONAL ? QwenApiRegions.INTERNATIONAL : QwenApiRegions.CHINA, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens }),
	"qwen-code": (cfg, mc) => new QwenCodeHandler({ onRetryAttempt: cfg.onRetryAttempt, qwenCodeOauthPath: cfg.qwenCodeOauthPath, apiModelId: mc.apiModelId }),
	doubao: (cfg, mc) => new DoubaoHandler({ onRetryAttempt: cfg.onRetryAttempt, doubaoApiKey: cfg.doubaoApiKey, apiModelId: mc.apiModelId }),
	mistral: (cfg, mc) => new MistralHandler({ onRetryAttempt: cfg.onRetryAttempt, mistralApiKey: cfg.mistralApiKey, apiModelId: mc.apiModelId }),
	"vscode-lm": (cfg, mc) => new VsCodeLmHandler({ onRetryAttempt: cfg.onRetryAttempt, vsCodeLmModelSelector: mc.vsCodeLmModelSelector }),
	"github-copilot": (cfg, mc) => new GithubCopilotHandler({ onRetryAttempt: cfg.onRetryAttempt, apiModelId: mc.apiModelId }),
	litellm: (cfg, mc) => new LiteLlmHandler({ onRetryAttempt: cfg.onRetryAttempt, liteLlmApiKey: cfg.liteLlmApiKey, liteLlmBaseUrl: cfg.liteLlmBaseUrl, liteLlmModelId: mc.liteLlmModelId, liteLlmModelInfo: mc.liteLlmModelInfo, thinkingBudgetTokens: mc.thinkingBudgetTokens, liteLlmUsePromptCache: cfg.liteLlmUsePromptCache, ulid: cfg.ulid }),
	moonshot: (cfg, mc) => new MoonshotHandler({ onRetryAttempt: cfg.onRetryAttempt, moonshotApiKey: cfg.moonshotApiKey, moonshotApiLine: cfg.moonshotApiLine, apiModelId: mc.apiModelId }),
	huggingface: (cfg, mc) => new HuggingFaceHandler({ onRetryAttempt: cfg.onRetryAttempt, huggingFaceApiKey: cfg.huggingFaceApiKey, huggingFaceModelId: mc.huggingFaceModelId, huggingFaceModelInfo: mc.huggingFaceModelInfo }),
	nebius: (cfg, mc) => new NebiusHandler({ onRetryAttempt: cfg.onRetryAttempt, nebiusApiKey: cfg.nebiusApiKey, apiModelId: mc.apiModelId }),
	xai: (cfg, mc) => new XAIHandler({ onRetryAttempt: cfg.onRetryAttempt, xaiApiKey: cfg.xaiApiKey, reasoningEffort: mc.reasoningEffort, apiModelId: mc.apiModelId }),
	sambanova: (cfg, mc) => new SambanovaHandler({ onRetryAttempt: cfg.onRetryAttempt, sambanovaApiKey: cfg.sambanovaApiKey, apiModelId: mc.apiModelId }),
	cerebras: (cfg, mc) => new CerebrasHandler({ onRetryAttempt: cfg.onRetryAttempt, cerebrasApiKey: cfg.cerebrasApiKey, apiModelId: mc.apiModelId }),
	groq: (cfg, mc) => new GroqHandler({ onRetryAttempt: cfg.onRetryAttempt, groqApiKey: cfg.groqApiKey, groqModelId: mc.groqModelId, groqModelInfo: mc.groqModelInfo, apiModelId: mc.apiModelId }),
	baseten: (cfg, mc) => new BasetenHandler({ onRetryAttempt: cfg.onRetryAttempt, basetenApiKey: cfg.basetenApiKey, basetenModelId: mc.basetenModelId, basetenModelInfo: mc.basetenModelInfo, apiModelId: mc.apiModelId }),
	"claude-code": (cfg, mc) => new ClaudeCodeHandler({ onRetryAttempt: cfg.onRetryAttempt, claudeCodePath: cfg.claudeCodePath, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens }),
	"huawei-cloud-maas": (cfg, mc) => new HuaweiCloudMaaSHandler({ onRetryAttempt: cfg.onRetryAttempt, huaweiCloudMaasApiKey: cfg.huaweiCloudMaasApiKey, huaweiCloudMaasModelId: mc.huaweiCloudMaasModelId, huaweiCloudMaasModelInfo: mc.huaweiCloudMaasModelInfo }),
	dify: (cfg) => new DifyHandler({ difyApiKey: cfg.difyApiKey, difyBaseUrl: cfg.difyBaseUrl }),
	"vercel-ai-gateway": (cfg, mc) => new VercelAIGatewayHandler({ onRetryAttempt: cfg.onRetryAttempt, vercelAiGatewayApiKey: cfg.vercelAiGatewayApiKey, openRouterModelId: mc.vercelAiGatewayModelId, openRouterModelInfo: mc.vercelAiGatewayModelInfo, reasoningEffort: mc.reasoningEffort, thinkingBudgetTokens: mc.thinkingBudgetTokens }),
	zai: (cfg, mc) => new ZAiHandler({ onRetryAttempt: cfg.onRetryAttempt, zaiApiLine: cfg.zaiApiLine, zaiApiKey: cfg.zaiApiKey, thinkingBudgetTokens: mc.thinkingBudgetTokens, apiModelId: mc.apiModelId }),
	aihubmix: (cfg, mc) => new AIhubmixHandler({ onRetryAttempt: cfg.onRetryAttempt, apiKey: cfg.aihubmixApiKey, baseURL: cfg.aihubmixBaseUrl, appCode: cfg.aihubmixAppCode, modelId: mc.aihubmixModelId, modelInfo: mc.aihubmixModelInfo }),
	minimax: (cfg, mc) => new MinimaxHandler({ onRetryAttempt: cfg.onRetryAttempt, minimaxApiKey: cfg.minimaxApiKey, minimaxApiLine: cfg.minimaxApiLine, apiModelId: mc.apiModelId, thinkingBudgetTokens: mc.thinkingBudgetTokens }),
	nousResearch: (cfg, mc) => new NousResearchHandler({ onRetryAttempt: cfg.onRetryAttempt, nousResearchApiKey: cfg.nousResearchApiKey, apiModelId: mc.nousResearchModelId }),
	wandb: (cfg, mc) => new WandbHandler({ onRetryAttempt: cfg.onRetryAttempt, wandbApiKey: cfg.wandbApiKey, apiModelId: mc.apiModelId }),
}

export function createRegistryHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const m = resolveModeConfig(configuration, mode)
	const factory = PROVIDER_REGISTRY[configuration.apiProvider ?? ""] || null
	if (!factory) {
		return new AnthropicHandler({ onRetryAttempt: configuration.onRetryAttempt, apiKey: configuration.apiKey, anthropicBaseUrl: configuration.anthropicBaseUrl, apiModelId: m.apiModelId, thinkingBudgetTokens: m.thinkingBudgetTokens })
	}
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
	const { planModeApiProvider, actModeApiProvider, ...options } = configuration
	const apiProvider = mode === "plan" ? planModeApiProvider : actModeApiProvider

	// Validate thinking budget tokens against model's maxTokens to prevent API errors
	try {
		const { thinkingBudgetTokens } = resolveModeConfig(options, mode)
		if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
			const handler = createHandlerForProvider(apiProvider, options, mode)
			const modelInfo = handler.getModel().info
			if (modelInfo?.maxTokens && modelInfo.maxTokens > 0 && thinkingBudgetTokens > modelInfo.maxTokens) {
				const clippedValue = modelInfo.maxTokens - 1
				// Mutate the field in the correct mode slot so rebuild picks it up
				if (mode === "plan") options.planModeThinkingBudgetTokens = clippedValue
				else options.actModeThinkingBudgetTokens = clippedValue
			} else {
				return handler // no clip needed — return early
			}
		}
	} catch (error) {
		Logger.error("buildApiHandler error:", error)
	}

	return createHandlerForProvider(apiProvider, options, mode)
}
