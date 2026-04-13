import { geminiModels } from "@shared/api"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { Mode } from "@shared/ExtensionMessage"
import { normalizeApiConfiguration, supportsReasoningEffortForModelId } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the GeminiProvider component
 */
interface GeminiProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Gemini provider configuration component
 */
export const GeminiProvider = ({ showModelOptions, isPopup, currentMode }: GeminiProviderProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId)

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.geminiApiKey || ""}
				onChange={(value: string) => handleFieldChange("geminiApiKey", value)}
				providerName="Gemini"
				signupUrl="https://aistudio.google.com/apikey"
			/>

			<BaseUrlField
				initialValue={apiConfiguration?.geminiBaseUrl}
				label="Use custom base URL"
				onChange={(value: string) => handleFieldChange("geminiBaseUrl", value)}
				placeholder="Default: https://generativelanguage.googleapis.com"
			/>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={geminiModels}
						onChange={(e: any) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								e.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
					/>

					{showReasoningEffort && <ReasoningEffortSelector currentMode={currentMode} />}

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />

					<div className="flex items-center gap-2 mt-2">
						<VSCodeCheckbox
							checked={apiConfiguration?.geminiSearchEnabled || false}
							onChange={(e: any) => handleFieldChange("geminiSearchEnabled", e.target.checked)}>
							<span style={{ fontWeight: 500 }}>Grounding with Google Search</span>
						</VSCodeCheckbox>
					</div>
					<p
						style={{
							fontSize: "12px",
							marginTop: "5px",
							color: "var(--vscode-descriptionForeground)",
						}}>
						Connects the Gemini model to real-time web content. Each search query is billed separately.
					</p>

				</>
			)}
		</div>
	)
}
