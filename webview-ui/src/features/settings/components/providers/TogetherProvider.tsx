import { Mode } from "@shared/ExtensionMessage"
import { getModeSpecificFields } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the TogetherProvider component
 */
interface TogetherProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Together provider configuration component
 */
export const TogetherProvider = ({ showModelOptions, isPopup, currentMode }: TogetherProviderProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	const { togetherModelId } = getModeSpecificFields(apiConfiguration, currentMode)

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.togetherApiKey || ""}
				onChange={(value: string) => handleFieldChange("togetherApiKey", value)}
				providerName="Together"
			/>
			{showModelOptions && <>
				<DebouncedTextField
					initialValue={togetherModelId || ""}
					onChange={(value: string) =>
						handleModeFieldChange({ plan: "planModeTogetherModelId", act: "actModeTogetherModelId" }, value, currentMode)
					}
					placeholder={"Enter Model ID..."}
					style={{ width: "100%" }}>
					<span style={{ fontWeight: 500 }}>Model ID</span>
				</DebouncedTextField>
			</>}
			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					color: "var(--vscode-descriptionForeground)",
				}}>
				<span style={{ color: "var(--vscode-errorForeground)" }}>
					(<span style={{ fontWeight: 500 }}>Note:</span> Dirac uses complex prompts and works best with Claude models.
					Less capable models may not work as expected.)
				</span>
			</p>
		</div>
	)
}
