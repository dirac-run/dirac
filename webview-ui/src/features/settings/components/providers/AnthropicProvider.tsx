import { anthropicModels, modelSupportsInferenceSpeed } from "@shared/api"
import type { Mode } from "@shared/ExtensionMessage"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import AdaptiveThinkingToggle from "../AdaptiveThinkingToggle"
import { ApiKeyField } from "../common/ApiKeyField"
import InferenceSpeedSelector from "../InferenceSpeedSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { BaseUrlField } from "../common/BaseUrlField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import ThinkingBudgetSlider from "../ThinkingBudgetSlider"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

// Retained for compatibility with imports in existing UI tests.
export const SUPPORTED_ANTHROPIC_THINKING_MODELS = Object.entries(anthropicModels)
	.filter(([, info]) => info.supportsReasoning)
	.map(([modelId]) => modelId)

/**
 * Props for the AnthropicProvider component
 */
interface AnthropicProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Anthropic provider configuration component
 */
export const AnthropicProvider = ({ showModelOptions, isPopup, currentMode }: AnthropicProviderProps) => {
	const { apiConfiguration, remoteConfigSettings } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange, handleModeFieldsChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const configuredInferenceSpeed = getModeSpecificFields(apiConfiguration, currentMode).inferenceSpeed
	const isBaseUrlManaged = remoteConfigSettings?.anthropicBaseUrl !== undefined
	const setSelectedModel = (modelId: string) => {
		if (modelSupportsInferenceSpeed("anthropic", modelId) || configuredInferenceSpeed !== "fast") {
			return handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, modelId, currentMode)
		}
		return handleModeFieldsChange(
			{
				apiModelId: { plan: "planModeApiModelId", act: "actModeApiModelId" },
				inferenceSpeed: { plan: "planModeInferenceSpeed", act: "actModeInferenceSpeed" },
			},
			{ apiModelId: modelId, inferenceSpeed: "default" },
			currentMode,
		)
	}

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.apiKey || ""}
				onChange={(value: string) => handleFieldChange("apiKey", value)}
				providerName="Anthropic"
				signupUrl="https://console.anthropic.com/settings/keys"
			/>

			<RemotelyConfiguredInputWrapper hidden={!isBaseUrlManaged}>
				<BaseUrlField
					disabled={isBaseUrlManaged}
					initialValue={apiConfiguration?.anthropicBaseUrl}
					label="Use custom base URL"
					onChange={(value: string) => handleFieldChange("anthropicBaseUrl", value)}
					placeholder="Default: https://api.anthropic.com"
					showLockIcon={isBaseUrlManaged}
				/>
			</RemotelyConfiguredInputWrapper>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={anthropicModels}
						onChange={(event: any) => setSelectedModel(event.target.value)}
						selectedModelId={selectedModelId}
					/>

					{selectedModelInfo.supportsReasoningEffort && !selectedModelInfo.thinkingAlwaysOn && (
						<AdaptiveThinkingToggle currentMode={currentMode} supportsBetweenToolsThinking={selectedModelInfo.supportsBetweenToolsThinking} />
					)}
					{selectedModelInfo.supportsReasoningEffort ? (
						<ReasoningEffortSelector
							allowedEfforts={selectedModelInfo.reasoningEffortOptions}
							currentMode={currentMode}
							defaultEffort={selectedModelInfo.defaultReasoningEffort || "medium"}
							description="Effort controls thinking depth, latency, and cost."
						/>
					) : SUPPORTED_ANTHROPIC_THINKING_MODELS.includes(selectedModelId) ? (
						<ThinkingBudgetSlider currentMode={currentMode} maxBudget={selectedModelInfo.thinkingConfig?.maxBudget} />
					) : null}

					<InferenceSpeedSelector
						currentMode={currentMode}
						description="Fast increases Anthropic output speed at 2x token pricing and requires account access."
						supportsFastMode={selectedModelInfo.supportsFastMode === true}
					/>

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo as any} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
