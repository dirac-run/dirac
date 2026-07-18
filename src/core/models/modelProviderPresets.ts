import { buildApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { Controller } from "@core/controller"
import type { ApiConfiguration, ApiProvider, ModelInfo, ModelProviderPreset, OpenAiCompatibleProfile } from "@shared/api"
import type { Mode } from "@shared/storage/types"

const MAX_MODEL_PROVIDER_PRESETS = 20

function presetId(provider: ApiProvider, modelId: string, openAiProfileName?: string): string {
	return [provider, openAiProfileName || "", modelId].map(encodeURIComponent).join(":")
}

function openAiProfileName(baseUrl: string, modelId: string): string {
	let endpoint = baseUrl
	try {
		endpoint = new URL(baseUrl).host
	} catch { }
	return `${endpoint || "OpenAI Compatible"} · ${modelId}`
}

function uniqueOpenAiProfileName(profiles: OpenAiCompatibleProfile[], baseName: string): string {
	if (!profiles.some((profile) => profile.name === baseName)) return baseName
	let suffix = 2
	while (profiles.some((profile) => profile.name === `${baseName} (${suffix})`)) suffix++
	return `${baseName} (${suffix})`
}

function upsertPreset(stateManager: StateManager, preset: ModelProviderPreset): void {
	const existing = stateManager.getGlobalSettingsKey("modelProviderPresets")
	const withoutPreset = existing.filter((candidate) => candidate.id !== preset.id)
	stateManager.setGlobalState("modelProviderPresets", [preset, ...withoutPreset].slice(0, MAX_MODEL_PROVIDER_PRESETS))
}

function resolveOpenAiProfile(
	stateManager: StateManager,
	configuration: ApiConfiguration,
	mode: Mode,
	modelId: string,
	modelInfo: ModelInfo,
): string | undefined {
	const selectedName = mode === "plan" ? configuration.planModeOpenAiProfileName : configuration.actModeOpenAiProfileName
	const profiles = configuration.openAiCompatibleProfiles || []
	if (selectedName && profiles.some((profile) => profile.name === selectedName)) return selectedName
	if (!configuration.openAiBaseUrl) return undefined

	const matchingProfile = profiles.find(
		(profile) => profile.baseUrl === configuration.openAiBaseUrl && profile.modelId === modelId,
	)
	if (matchingProfile) return matchingProfile.name

	const name = uniqueOpenAiProfileName(profiles, openAiProfileName(configuration.openAiBaseUrl, modelId))
	const profile: OpenAiCompatibleProfile = {
		name,
		baseUrl: configuration.openAiBaseUrl,
		apiKey: configuration.openAiApiKey,
		modelId,
		modelInfo,
		headers: configuration.openAiHeaders,
		azureApiVersion: configuration.azureApiVersion,
	}
	stateManager.setApiConfiguration({
		openAiCompatibleProfiles: [...profiles, profile],
		[mode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: name,
	})
	return name
}

export function recordSuccessfulModelProviderPreset(
	stateManager: StateManager,
	provider: ApiProvider,
	modelId: string,
	modelInfo: ModelInfo,
	mode: Mode,
): void {
	if (!modelId) return
	const configuration = stateManager.getApiConfiguration()
	const openAiProfileName =
		provider === "openai" ? resolveOpenAiProfile(stateManager, configuration, mode, modelId, modelInfo) : undefined
	const vsCodeLmModelSelector =
		provider === "vscode-lm"
			? mode === "plan"
				? configuration.planModeVsCodeLmModelSelector
				: configuration.actModeVsCodeLmModelSelector
			: undefined
	const awsBedrockCustomSelected =
		provider === "bedrock"
			? mode === "plan"
				? configuration.planModeAwsBedrockCustomSelected
				: configuration.actModeAwsBedrockCustomSelected
			: undefined
	const awsBedrockCustomModelBaseId =
		provider === "bedrock"
			? mode === "plan"
				? configuration.planModeAwsBedrockCustomModelBaseId
				: configuration.actModeAwsBedrockCustomModelBaseId
			: undefined

	upsertPreset(stateManager, {
		id: presetId(provider, modelId, openAiProfileName),
		provider,
		modelId,
		modelInfo,
		openAiProfileName,
		vsCodeLmModelSelector,
		awsBedrockCustomSelected,
		awsBedrockCustomModelBaseId,
		lastUsedAt: Date.now(),
	})
}

export function recordSavedOpenAiCompatibleProfileChanges(
	stateManager: StateManager,
	previousProfiles: OpenAiCompatibleProfile[],
): void {
	const configuration = stateManager.getApiConfiguration()
	const profiles = configuration.openAiCompatibleProfiles || []
	const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]))
	const presets = stateManager.getGlobalSettingsKey("modelProviderPresets")
	const reconciledPresets = presets.filter((preset) => {
		if (preset.provider !== "openai" || !preset.openAiProfileName) return true
		return profilesByName.get(preset.openAiProfileName)?.modelId === preset.modelId
	})
	if (reconciledPresets.length !== presets.length) {
		stateManager.setGlobalState("modelProviderPresets", reconciledPresets)
	}

	const selectedNames = new Set(
		[configuration.planModeOpenAiProfileName, configuration.actModeOpenAiProfileName].filter(
			(name): name is string => !!name,
		),
	)
	for (const profile of profiles) {
		if (!profile.modelId || !selectedNames.has(profile.name)) continue
		const previousProfile = previousProfiles.find((candidate) => candidate.name === profile.name)
		if (previousProfile && JSON.stringify(previousProfile) === JSON.stringify(profile)) continue
		upsertPreset(stateManager, {
			id: presetId("openai", profile.modelId, profile.name),
			provider: "openai",
			modelId: profile.modelId,
			modelInfo: profile.modelInfo,
			openAiProfileName: profile.name,
			lastUsedAt: Date.now(),
		})
	}
}

function modeUpdates(mode: Mode, preset: ModelProviderPreset, profile?: OpenAiCompatibleProfile): Partial<ApiConfiguration> {
	const prefix = mode === "plan" ? "planMode" : "actMode"
	const updates: Record<string, unknown> = {
		[`${prefix}ApiProvider`]: preset.provider,
		[`${prefix}ApiModelId`]: preset.modelId,
	}

	const providerFields: Partial<Record<ApiProvider, string>> = {
		openrouter: "OpenRouter",
		dirac: "Dirac",
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
	const providerField = providerFields[preset.provider]
	if (providerField) {
		updates[`${prefix}${providerField}ModelId`] = preset.modelId
		if (
			preset.modelInfo &&
			!["lmstudio", "together", "fireworks", "github-copilot", "nousResearch"].includes(preset.provider)
		) {
			updates[`${prefix}${providerField}ModelInfo`] = preset.modelInfo
		}
	}

	if (preset.provider === "vscode-lm") updates[`${prefix}VsCodeLmModelSelector`] = preset.vsCodeLmModelSelector
	if (preset.provider === "bedrock") {
		updates[`${prefix}AwsBedrockCustomSelected`] = preset.awsBedrockCustomSelected
		updates[`${prefix}AwsBedrockCustomModelBaseId`] = preset.awsBedrockCustomModelBaseId
	}
	if (preset.provider === "openai") {
		updates[`${prefix}OpenAiProfileName`] = preset.openAiProfileName
		if (profile) {
			updates.openAiBaseUrl = profile.baseUrl
			updates.openAiApiKey = profile.apiKey
			updates.openAiHeaders = profile.headers
			updates.azureApiVersion = profile.azureApiVersion
		}
	}
	return updates as Partial<ApiConfiguration>
}

export async function activateModelProviderPreset(controller: Controller, presetIdToActivate: string): Promise<void> {
	const presets = controller.stateManager.getGlobalSettingsKey("modelProviderPresets")
	const preset = presets.find((candidate) => candidate.id === presetIdToActivate)
	if (!preset) throw new Error("Model/provider preset not found")

	const configuration = controller.stateManager.getApiConfiguration()
	const profile = preset.openAiProfileName
		? configuration.openAiCompatibleProfiles?.find((candidate) => candidate.name === preset.openAiProfileName)
		: undefined
	if (preset.provider === "openai" && preset.openAiProfileName && !profile) {
		throw new Error("Saved OpenAI-compatible configuration not found")
	}

	const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
	const updates = controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
		? modeUpdates(currentMode, preset, profile)
		: { ...modeUpdates("plan", preset, profile), ...modeUpdates("act", preset, profile) }
	controller.stateManager.setApiConfiguration(updates)
	upsertPreset(controller.stateManager, { ...preset, lastUsedAt: Date.now() })

	if (controller.task) {
		controller.task.api = buildApiHandler(
			{ ...controller.stateManager.getApiConfiguration(), ulid: controller.task.ulid },
			currentMode,
		)
	}
	await controller.postStateToWebview()
}
