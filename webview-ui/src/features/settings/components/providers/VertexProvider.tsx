import { vertexGlobalModels, vertexModels } from "@shared/api"
import type { Mode } from "@shared/ExtensionMessage"
import VertexData from "@shared/providers/vertex.json"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeLink, VSCodeOption } from "@vscode/webview-ui-toolkit/react"

import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { DROPDOWN_Z_INDEX, DropdownContainer } from "../ApiOptions"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { LockIcon, RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import ThinkingBudgetSlider from "../ThinkingBudgetSlider"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the VertexProvider component
 */
interface VertexProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

// Vertex models that support thinking
const SUPPORTED_THINKING_MODELS = [
	"claude-opus-4-6",
	"claude-opus-4-6:1m",
	"claude-sonnet-4-6",
	"claude-sonnet-4-6:1m",
	"claude-haiku-4-5@20251001",
	"claude-sonnet-4-5@20250929",
	"claude-3-7-sonnet@20250219",
	"claude-sonnet-4@20250514",
	"claude-opus-4-5@20251101",
	"claude-opus-4@20250514",
	"claude-opus-4-1@20250805",
	"gemini-2.5-flash",
	"gemini-2.5-pro",
	"gemini-2.5-flash-lite-preview-06-17",
]

const REGIONS = VertexData.regions

/**
 * The GCP Vertex AI provider configuration component
 */
export const VertexProvider = ({ showModelOptions, isPopup, currentMode }: VertexProviderProps) => {
	const { apiConfiguration, remoteConfigSettings } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	const isGeminiModel = selectedModelId?.toLowerCase().includes("gemini")

	// Determine which models to use based on region
	const modelsToUse = apiConfiguration?.vertexRegion === "global" ? vertexGlobalModels : vertexModels

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 5,
			}}>
			<RemotelyConfiguredInputWrapper hidden={remoteConfigSettings?.vertexProjectId === undefined}>
				<DebouncedTextField
					disabled={remoteConfigSettings?.vertexProjectId !== undefined}
					initialValue={apiConfiguration?.vertexProjectId || ""}
					onChange={(value: string) => handleFieldChange("vertexProjectId", value)}
					placeholder="Enter Project ID..."
					style={{ width: "100%" }}>
					<div className="flex items-center gap-2 mb-1">
						<span style={{ fontWeight: 500 }}>Google Cloud Project ID</span>
						{remoteConfigSettings?.vertexProjectId !== undefined && <LockIcon />}
					</div>
				</DebouncedTextField>
			</RemotelyConfiguredInputWrapper>

			<RemotelyConfiguredInputWrapper hidden={remoteConfigSettings?.vertexRegion === undefined}>
				<DropdownContainer className="dropdown-container" zIndex={DROPDOWN_Z_INDEX - 1}>
					<div
						className="flex items-center gap-2 mb-1"
						style={{ opacity: remoteConfigSettings?.vertexRegion !== undefined ? 0.4 : 1 }}>
						<label htmlFor="vertex-region-dropdown">
							<span className="font-medium">Google Cloud Region</span>
						</label>
						{remoteConfigSettings?.vertexRegion !== undefined && <LockIcon />}
					</div>
					<VSCodeDropdown
						disabled={remoteConfigSettings?.vertexRegion !== undefined}
						id="vertex-region-dropdown"
						onChange={(e: any) => handleFieldChange("vertexRegion", e.target.value)}
						style={{ width: "100%" }}
						value={apiConfiguration?.vertexRegion || ""}>
						<VSCodeOption value="">Select a region...</VSCodeOption>
						{REGIONS.map((region) => (
							<VSCodeOption key={region} value={region}>
								{region}
							</VSCodeOption>
						))}
					</VSCodeDropdown>
				</DropdownContainer>
			</RemotelyConfiguredInputWrapper>

			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				To use Google Cloud Vertex AI, you need to
				<VSCodeLink
					href="https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#before_you_begin"
					style={{ display: "inline", fontSize: "inherit" }}>
					{"1) create a Google Cloud account › enable the Vertex AI API › enable the desired Claude models,"}
				</VSCodeLink>{" "}
				<VSCodeLink
					href="https://cloud.google.com/docs/authentication/provide-credentials-adc#google-idp"
					style={{ display: "inline", fontSize: "inherit" }}>
					{"2) install the Google Cloud CLI › configure Application Default Credentials."}
				</VSCodeLink>
			</p>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={modelsToUse}
						onChange={(e: any) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								e.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
						zIndex={DROPDOWN_Z_INDEX - 2}
					/>

					{SUPPORTED_THINKING_MODELS.includes(selectedModelId) && (
						<ThinkingBudgetSlider currentMode={currentMode} maxBudget={selectedModelInfo.thinkingConfig?.maxBudget} />
					)}

					{selectedModelInfo.thinkingConfig?.supportsThinkingLevel && (
						<ReasoningEffortSelector currentMode={currentMode} />
					)}

					{isGeminiModel && (
						<>
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

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
