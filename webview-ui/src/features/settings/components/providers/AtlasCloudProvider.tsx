import { atlascloudModels } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the AtlasCloudProvider component
 */
interface AtlasCloudProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Atlas Cloud provider configuration component
 */
export const AtlasCloudProvider = ({ showModelOptions, isPopup, currentMode }: AtlasCloudProviderProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	return (
		<div>
			<ApiKeyField
				helpText="This key is stored locally and only used to make API requests from this extension. (Note: Dirac uses complex prompts and works best with Claude models. Less capable models may not work as expected.)"
				initialValue={apiConfiguration?.atlascloudApiKey || ""}
				onChange={(value: string) => handleFieldChange("atlascloudApiKey", value)}
				providerName="Atlas Cloud"
				signupUrl="https://console.atlascloud.ai/api-keys"
			/>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={atlascloudModels}
						onChange={(e: any) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								e.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
					/>

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
