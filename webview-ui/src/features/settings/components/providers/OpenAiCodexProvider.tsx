import { openAiCodexModels } from "@shared/api"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { Mode } from "@shared/ExtensionMessage"
import { normalizeApiConfiguration, supportsReasoningEffortForModelId } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { useState } from "react"

interface OpenAiCodexProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * OpenAI Codex (ChatGPT Plus/Pro) provider configuration component.
 * Uses OAuth authentication instead of API keys.
 */
export const OpenAiCodexProvider = ({ showModelOptions, isPopup, currentMode }: OpenAiCodexProviderProps) => {
	const { apiConfiguration, openAiCodexIsAuthenticated, openAiCodexEmail } = useSettingsStore()
	const [isAuthenticating, setIsAuthenticating] = useState(false)

	const handleSignIn = async () => {
		setIsAuthenticating(true)
		try {
			await ModelsServiceClient.authenticateOpenAiCodex(EmptyRequest.create({}))
		} catch (error) {
			console.error("Authentication failed:", error)
		} finally {
			setIsAuthenticating(false)
		}
	}

	const handleSignOut = async () => {
		try {
			await ModelsServiceClient.signOutOpenAiCodex(EmptyRequest.create({}))
		} catch (error) {
			console.error("Sign out failed:", error)
		}
	}
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId, selectedModelInfo)

	return (
		<div>
			<div style={{ marginBottom: "15px" }}>
				<p
					style={{
						fontSize: "12px",
						color: "var(--vscode-descriptionForeground)",
						marginBottom: "10px",
					}}>
					OpenAI Codex (ChatGPT Plus/Pro) provider configuration.
				</p>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
				{openAiCodexIsAuthenticated ? (
					<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
						<span style={{ fontSize: "12px" }}>
							Authenticated as <strong>{openAiCodexEmail || "ChatGPT User"}</strong>
						</span>
						<VSCodeButton appearance="secondary" onClick={handleSignOut} style={{ height: "24px" }}>
							Sign Out
						</VSCodeButton>
					</div>
				) : (
					<VSCodeButton disabled={isAuthenticating} onClick={handleSignIn}>
						{isAuthenticating ? "Authenticating..." : "Sign in with ChatGPT"}
					</VSCodeButton>
				)}
			</div>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={openAiCodexModels}
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
				</>
			)}
		</div>
	)
}
