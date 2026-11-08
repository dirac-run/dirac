import type { StateManager } from "@core/storage/StateManager"
import type { Controller } from "@core/controller"
import { applyApiConfigurationTransaction } from "@core/controller/models/apiConfigurationTransaction"
import { persistApiConfigurationPatch } from "@core/controller/models/apiConfigurationPersistence"
import type { ApiConfiguration, ApiProvider, ModelInfo, ModelProviderPreset, OpenAiCompatibleProfile } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { modelProviderSelectionUpdates } from "@core/api/modelProviderSelection"

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
		return profilesByName.has(preset.openAiProfileName)
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

function modeUpdates(
	configuration: ApiConfiguration,
	mode: Mode,
	preset: ModelProviderPreset,
	profile?: OpenAiCompatibleProfile,
): Partial<ApiConfiguration> {
	const inferenceSpeed = mode === "plan" ? configuration.planModeInferenceSpeed : configuration.actModeInferenceSpeed
	const updates: Record<string, unknown> = {
		...modelProviderSelectionUpdates(mode, preset, inferenceSpeed),
	}
	// Recent presets select identity only; unlike independent selections, they do not own reasoning.
	const prefix = mode === "plan" ? "planMode" : "actMode"
	delete updates[`${prefix}ReasoningEffort`]
	delete updates[`${prefix}ThinkingBudgetTokens`]
	delete updates[`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`]
	if (preset.provider === "openai" && profile) {
		updates.openAiBaseUrl = profile.baseUrl
		updates.openAiApiKey = profile.apiKey
		updates.openAiHeaders = profile.headers
		updates.azureApiVersion = profile.azureApiVersion
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
		? modeUpdates(configuration, currentMode, preset, profile)
		: {
			...modeUpdates(configuration, "plan", preset, profile),
			...modeUpdates(configuration, "act", preset, profile),
		}
	const candidateConfiguration = { ...configuration, ...updates }
	await applyApiConfigurationTransaction(controller, candidateConfiguration, () =>
		persistApiConfigurationPatch(controller.stateManager, updates),
	)
	upsertPreset(controller.stateManager, { ...preset, lastUsedAt: Date.now() })
	await controller.postStateToWebview()
}
