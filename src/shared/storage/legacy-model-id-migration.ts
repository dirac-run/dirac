import type { ModelProviderPreset } from "@shared/api"
import type { GlobalStateAndSettings, SettingsKey } from "./state-keys"

const LEGACY_MODEL_ID_SETTINGS = [
	"planModeApiModelId",
	"actModeApiModelId",
	"planModeAwsBedrockCustomModelBaseId",
	"actModeAwsBedrockCustomModelBaseId",
	"planModeOpenRouterModelId",
	"actModeOpenRouterModelId",
	"planModeVercelAiGatewayModelId",
	"actModeVercelAiGatewayModelId",
] as const satisfies readonly SettingsKey[]

const RETIRED_DEEPSEEK_MODEL_IDS = new Set([
	"deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp",
	"deepseek-v4-pro",
	"deepseek-chat",
	"deepseek-reasoner",
])

export function normalizeRetiredDeepSeekModelId(modelId: string): string {
	return RETIRED_DEEPSEEK_MODEL_IDS.has(modelId) ? "deepseek-flash" : modelId
}

/**
 * Removes Dirac's retired `:1m` model-id segment while preserving real suffixes
 * such as Anthropic fast mode and OpenRouter presets.
 */
export function normalizeLegacySynthetic1mModelId(modelId: string): string {
	const presetMarker = "@preset/"
	const presetIndex = modelId.indexOf(presetMarker)
	const modelPart = presetIndex === -1 ? modelId : modelId.slice(0, presetIndex)
	const presetPart = presetIndex === -1 ? "" : modelId.slice(presetIndex)
	const normalizedModelPart = modelPart.replace(/:1m(?=:fast$|$)/, "")
	return `${normalizedModelPart}${presetPart}`
}

const SUPPORTED_ANTHROPIC_FAST_MODE_MODELS = new Set(["claude-opus-4-8", "claude-opus-5"])

function normalizeLegacyAnthropicFastModeModelId(modelId: string): string {
	return modelId.startsWith("claude-") && modelId.endsWith(":fast") ? modelId.slice(0, -":fast".length) : modelId
}

export function buildLegacyAnthropicFastModeStateUpdates(
	state: Partial<GlobalStateAndSettings>,
): Partial<GlobalStateAndSettings> {
	const updates: Partial<GlobalStateAndSettings> = {}
	for (const mode of ["plan", "act"] as const) {
		const modelKey = `${mode}ModeApiModelId` as const
		const speedKey = `${mode}ModeInferenceSpeed` as const
		const modelId = state[modelKey]
		if (!modelId?.startsWith("claude-") || !modelId.endsWith(":fast")) continue
		const baseModelId = modelId.slice(0, -":fast".length)
		updates[modelKey] = baseModelId
		updates[speedKey] = SUPPORTED_ANTHROPIC_FAST_MODE_MODELS.has(baseModelId) ? "fast" : "standard"
	}
	return updates
}

export function buildLegacyModelIdStateUpdates(
	state: Partial<GlobalStateAndSettings>,
): Partial<GlobalStateAndSettings> {
	const synthetic1mUpdates = buildLegacySynthetic1mStateUpdates(state)
	const normalizedState = { ...state, ...synthetic1mUpdates }
	return {
		...synthetic1mUpdates,
		...buildRetiredDeepSeekModelStateUpdates(normalizedState),
		...buildLegacyAnthropicFastModeStateUpdates(normalizedState),
	}
}
export function buildRetiredDeepSeekModelStateUpdates(
	state: Partial<GlobalStateAndSettings>,
): Partial<GlobalStateAndSettings> {
	const updates: Partial<GlobalStateAndSettings> = {}
	for (const mode of ["plan", "act"] as const) {
		const providerKey = `${mode}ModeApiProvider` as const
		const modelKey = `${mode}ModeApiModelId` as const
		if (state[providerKey] !== "deepseek") continue
		const modelId = state[modelKey]
		if (!modelId) continue
		const normalizedModelId = normalizeRetiredDeepSeekModelId(modelId)
		if (normalizedModelId !== modelId) updates[modelKey] = normalizedModelId
	}
	const utilitySelection = state.utilityModelSelection
	if (utilitySelection?.provider === "deepseek") {
		const normalizedModelId = normalizeRetiredDeepSeekModelId(utilitySelection.modelId)
		if (normalizedModelId !== utilitySelection.modelId) {
			updates.utilityModelSelection = {
				...utilitySelection,
				modelId: normalizedModelId,
				modelInfo: undefined,
			}
		}
	}
	return updates
}
export function normalizeLegacyOpenRouterPinMap(
	pins: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
	if (!pins) return undefined

	const normalized: Record<string, string[]> = {}
	const keys = Object.keys(pins)
	const canonicalKeys = keys.filter((key) => normalizeLegacySynthetic1mModelId(key) === key).sort()
	const legacyKeys = keys.filter((key) => normalizeLegacySynthetic1mModelId(key) !== key).sort()

	for (const key of [...canonicalKeys, ...legacyKeys]) {
		const normalizedKey = normalizeLegacySynthetic1mModelId(key)
		const mergedTags = [...(normalized[normalizedKey] || []), ...(pins[key] || [])]
		normalized[normalizedKey] = [...new Set(mergedTags)]
	}

	return normalized
}

export function removeLegacySynthetic1mModelEntries<T>(models: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(models).filter(([modelId]) => normalizeLegacySynthetic1mModelId(modelId) === modelId),
	)
}

export function buildLegacySynthetic1mStateUpdates(
	state: Partial<GlobalStateAndSettings>,
): Partial<GlobalStateAndSettings> {
	const updates: Partial<GlobalStateAndSettings> = {}

	for (const key of LEGACY_MODEL_ID_SETTINGS) {
		const value = state[key]
		if (!value) continue
		const normalized = normalizeLegacySynthetic1mModelId(value)
		if (normalized !== value) updates[key] = normalized as never
	}

	const pins = state.openRouterPinnedProviders
	const normalizedPins = normalizeLegacyOpenRouterPinMap(pins)
	if (pins && JSON.stringify(normalizedPins) !== JSON.stringify(pins)) {
		updates.openRouterPinnedProviders = normalizedPins
	}

	const presets = state.modelProviderPresets
	if (presets) {
		const normalizedPresets = normalizeLegacyModelProviderPresets(presets)
		if (JSON.stringify(normalizedPresets) !== JSON.stringify(presets)) {
			updates.modelProviderPresets = normalizedPresets
		}
	}

	return updates
}

export function normalizeLegacyModelProviderPresets(presets: ModelProviderPreset[]): ModelProviderPreset[] {
	const normalizedPresets: ModelProviderPreset[] = []
	const presetIndexesById = new Map<string, number>()
	for (const preset of presets.map(normalizeLegacyModelProviderPreset)) {
		const existingIndex = presetIndexesById.get(preset.id)
		if (existingIndex === undefined) {
			presetIndexesById.set(preset.id, normalizedPresets.length)
			normalizedPresets.push(preset)
			continue
		}
		if (preset.lastUsedAt > normalizedPresets[existingIndex].lastUsedAt) {
			normalizedPresets[existingIndex] = preset
		}
	}
	return normalizedPresets
}

function normalizeLegacyModelProviderPreset(preset: ModelProviderPreset): ModelProviderPreset {
	const legacyModelId = normalizeLegacyAnthropicFastModeModelId(normalizeLegacySynthetic1mModelId(preset.modelId))
	const modelId = preset.provider === "deepseek" ? normalizeRetiredDeepSeekModelId(legacyModelId) : legacyModelId
	const awsBedrockCustomModelBaseId = preset.awsBedrockCustomModelBaseId
		? normalizeLegacySynthetic1mModelId(preset.awsBedrockCustomModelBaseId)
		: undefined

	if (modelId === preset.modelId && awsBedrockCustomModelBaseId === preset.awsBedrockCustomModelBaseId) {
		return preset
	}

	return {
		...preset,
		id: [preset.provider, preset.openAiProfileName || "", modelId].map(encodeURIComponent).join(":"),
		modelId,
		modelInfo: modelId === preset.modelId ? preset.modelInfo : undefined,
		awsBedrockCustomModelBaseId,
	}
}
