import { fireworksModels } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the FireworksProvider component
 */
interface FireworksProviderProps {
	currentMode: Mode
	isPopup?: boolean
	showModelOptions: boolean
}

/**
 * The Fireworks provider configuration component
 */
export const FireworksProvider = ({ currentMode, isPopup, showModelOptions }: FireworksProviderProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleModeFieldChange, handleFieldChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.fireworksApiKey || ""}
				onChange={(value: string) => handleFieldChange("fireworksApiKey", value)}
				providerName="Fireworks"
				signupUrl="https://fireworks.ai/"
			/>
			{showModelOptions && <>
				<ModelSelector
					label="Model"
					models={fireworksModels}
					onChange={(e: { target: EventTarget | null }) => {
						handleModeFieldChange(
							{
								plan: "planModeFireworksModelId",
								act: "actModeFireworksModelId",
							},
							(e.target as HTMLSelectElement).value,
							currentMode,
						)
					}}
					selectedModelId={selectedModelId}
				/>

				<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
			</>}
		</div>
	)
}
