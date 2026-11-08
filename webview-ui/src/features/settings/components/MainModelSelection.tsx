import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import { supportsCustomModelId } from "@shared/customModelIds"
import { modelProviderSelectionUpdates } from "@shared/modelProviderSelection"
import { isOpenaiReasoningEffort, type Mode } from "@shared/storage/types"
import { useMemo } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelSelectionEditor } from "./ModelSelectionEditor"
import { getModeSpecificFields, normalizeApiConfiguration } from "./utils/providerUtils"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"
import InferenceSpeedSelector from "./InferenceSpeedSelector"
import { OpenRouterProviderSelector, OpenRouterRoutingControls } from "./OpenRouterRoutingControls"
import UseCustomPromptCheckbox from "./UseCustomPromptCheckbox"

export function MainModelSelection({ mode, label }: { mode: Mode; label: string }) {
	const apiConfiguration = useSettingsStore((state) => state.apiConfiguration)
	const planActSeparateModelsSetting = useSettingsStore((state) => state.planActSeparateModelsSetting)
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const selection = useMemo<ModelProviderSelection>(() => {
		const normalized = normalizeApiConfiguration(apiConfiguration, mode)
		const fields = getModeSpecificFields(apiConfiguration, mode)
		return {
			provider: normalized.selectedProvider,
			modelId: normalized.selectedModelId,
			modelInfo: normalized.selectedModelInfo,
			openAiProfileName: normalized.selectedProvider === "openai" ? fields.openAiProfileName : undefined,
			reasoningEffort: isOpenaiReasoningEffort(fields.reasoningEffort) ? fields.reasoningEffort : undefined,
			thinkingBudgetTokens: fields.thinkingBudgetTokens,
			geminiThinkingLevel:
				mode === "plan" ? apiConfiguration.geminiPlanModeThinkingLevel : apiConfiguration.geminiActModeThinkingLevel,
			vsCodeLmModelSelector: fields.vsCodeLmModelSelector,
			awsBedrockCustomSelected: normalized.selectedProvider === "bedrock" ? fields.awsBedrockCustomSelected : undefined,
			awsBedrockCustomModelBaseId:
				normalized.selectedProvider === "bedrock" ? fields.awsBedrockCustomModelBaseId : undefined,
		}
	}, [apiConfiguration, mode])
	const persist = (next: ModelProviderSelection) => {
		const modes: Mode[] = planActSeparateModelsSetting ? [mode] : ["plan", "act"]
		const patch: Partial<ApiConfiguration> = Object.assign(
			{},
			...modes.map((target) =>
				modelProviderSelectionUpdates(target, next, getModeSpecificFields(apiConfiguration, target).inferenceSpeed),
			),
		)
		void handleFieldsChange(patch)
	}
	return (
		<ModelSelectionEditor
			label={label}
			selection={selection}
			onChange={persist}
			allowCustomModelId={supportsCustomModelId}
			renderControls={(current) =>
				["anthropic", "openai-native", "openai-codex"].includes(current.provider) && (
					<InferenceSpeedSelector
						compact
						label={`${label} inference speed`}
						currentMode={mode}
						supportsFastMode={current.modelInfo?.supportsFastMode === true}
						description="Provider inference speed and associated pricing."
					/>
				)
			}
			renderOptions={(current) => {
				if (current.provider === "openrouter")
					return (
						<>
							<OpenRouterProviderSelector modelId={current.modelId} />
							<OpenRouterRoutingControls />
						</>
					)
				if (current.provider === "lmstudio") return <UseCustomPromptCheckbox providerId="lmstudio" />
				if (current.provider === "gemini")
					return (
						<label className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={apiConfiguration.geminiSearchEnabled ?? false}
								onChange={(event) => {
									void handleFieldsChange({ geminiSearchEnabled: event.target.checked })
								}}
							/>
							Grounding with Google Search
						</label>
					)
				if (current.provider === "bedrock")
					return (
						<label className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={apiConfiguration.awsBedrockUsePromptCache ?? false}
								onChange={(event) => {
									void handleFieldsChange({ awsBedrockUsePromptCache: event.target.checked })
								}}
							/>
							Prompt caching
						</label>
					)
				return null
			}}
		/>
	)
}
