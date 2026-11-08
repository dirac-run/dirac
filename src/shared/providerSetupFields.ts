import { isSecretKey } from "./storage/state-keys"

// Provider access and transport only. Execution controls use validated activation.
const PROVIDER_SETUP_FIELDS = new Set<string>([
	"liteLlmBaseUrl", "openAiHeaders", "anthropicBaseUrl", "anthropicHeaders",
	"awsRegion", "awsUseCrossRegionInference", "awsUseGlobalInference", "awsAuthentication",
	"awsUseProfile", "awsProfile", "awsBedrockEndpoint", "claudeCodePath",
	"vertexProjectId", "vertexRegion", "openAiBaseUrl", "openAiCompatibleProfiles",
	"lmStudioBaseUrl", "geminiBaseUrl", "requestyBaseUrl", "qwenCodeOauthPath",
	"azureApiVersion", "qwenApiLine", "moonshotApiLine", "requestTimeoutMs",
	"difyBaseUrl", "zaiApiLine", "minimaxApiLine", "aihubmixBaseUrl", "aihubmixAppCode",
])

export function isProviderSetupField(field: string): boolean {
	return PROVIDER_SETUP_FIELDS.has(field) || isSecretKey(field)
}
