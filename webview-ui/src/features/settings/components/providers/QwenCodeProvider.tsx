import { type ModelInfo, qwenCodeModels } from "@shared/api"
import { StringRequest } from "@shared/proto/dirac/common"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { Mode } from "@shared/ExtensionMessage"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the QwenCodeProvider component
 */
interface QwenCodeProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Qwen Code provider configuration component
 */
export const QwenCodeProvider = ({ showModelOptions, isPopup, currentMode }: QwenCodeProviderProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleFieldChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const [models, setModels] = useState<Record<string, ModelInfo>>(qwenCodeModels)
	const [catalogError, setCatalogError] = useState(false)
	const credentialPath = apiConfiguration?.qwenCodeOauthPath || ""
	useEffect(() => {
		let cancelled = false
		setModels(qwenCodeModels)
		setCatalogError(false)
		ModelsServiceClient.getQwenCodeModels(StringRequest.create({ value: credentialPath })).then(
			(response) => { if (!cancelled) setModels(fromProtobufModels(response.models)) },
			() => { if (!cancelled) setCatalogError(true) },
		)
		return () => { cancelled = true }
	}, [credentialPath])

	return (
		<div>
			<h3 style={{ color: "var(--vscode-foreground)", margin: "8px 0" }}>Qwen Code Subscription</h3>
			<VSCodeTextField
				onInput={(event) => handleFieldChange("qwenCodeOauthPath", (event.currentTarget as HTMLInputElement).value)}
				placeholder="~/.qwen/subscription_credentials.json"
				style={{ width: "100%" }}
				value={apiConfiguration?.qwenCodeOauthPath || ""}>
				Subscription Credentials Path (optional)
			</VSCodeTextField>
			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "4px" }}>
				Leave blank to use subscription_credentials.json under QWEN_HOME, or ~/.qwen when QWEN_HOME is unset.
				A custom file path overrides both defaults; ~/ is supported.
			</div>

			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "12px" }}>
				Sign in through the official Qwen Code CLI with a Qwen Code Plus or Pro subscription. This provider uses
				that CLI's cached subscription credentials, not a DashScope API key.
			</div>

			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "8px" }}>
				To get started:
				<br />
				1. Install and launch the official Qwen Code CLI (qwen).
				<br />
				2. Run /auth and select Qwen Code subscription sign-in for your Plus or Pro account.
				<br />
				3. Return to Dirac after sign-in creates subscription_credentials.json.
			</div>

			<VSCodeLink
				href="https://github.com/QwenLM/qwen-code/blob/main/README.md"
				style={{
					color: "var(--vscode-textLink-foreground)",
					marginTop: "8px",
					display: "inline-block",
					fontSize: "12px",
				}}>
				Setup Instructions
			</VSCodeLink>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={models}
						onChange={(modelId: string) => {
							const fieldName = currentMode === "plan" ? "planModeApiModelId" : "actModeApiModelId"
							handleFieldChange(fieldName, modelId)
						}}
						selectedModelId={selectedModelId}
					/>

					<VSCodeTextField
						value={selectedModelId}
						onInput={(event) => handleFieldChange(currentMode === "plan" ? "planModeApiModelId" : "actModeApiModelId", (event.currentTarget as HTMLInputElement).value)}
						style={{ width: "100%", marginTop: "8px" }}>
						Account Model ID
					</VSCodeTextField>
					<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "4px" }}>
						{catalogError ? "Cached account models could not be read; showing fallback IDs. " : "Models are read from the local Qwen Code cache. "}
						You can enter a model ID available to your subscription. Account availability and limits apply.
					</div>
					<ModelInfoView isPopup={isPopup} modelInfo={models[selectedModelId] ?? selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
