import { TooltipContent, TooltipTrigger } from "@radix-ui/react-tooltip"
import { azureOpenAiDefaultApiVersion, openAiModelInfoSaneDefaults, OpenAiCompatibleProfile, ModelInfo } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { PlusIcon, RefreshCwIcon, TrashIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	getModeSpecificFields,
	normalizeApiConfiguration,
	supportsReasoningEffortForModelId,
} from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND } from "@/shared/lib/vscStyles"
import { Tooltip } from "@/shared/ui/tooltip"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { parsePrice } from "../utils/pricingUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the OpenAICompatibleProvider component
 */
interface OpenAICompatibleProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The OpenAI Compatible provider configuration component
 */
export const OpenAICompatibleProvider = ({ showModelOptions, isPopup, currentMode }: OpenAICompatibleProviderProps) => {
	const { apiConfiguration, remoteConfigSettings, openAiModels, refreshOpenAiModels } = useSettingsStore()
	const { handleFieldChange, handleModeFieldChange, handleModeFieldsChange, handleFieldsChange } = useApiConfigurationHandlers()

	const [modelConfigurationSelected, setModelConfigurationSelected] = useState(false)
	const [isRefreshingModels, setIsRefreshingModels] = useState(false)
	const [profileNameInput, setProfileNameInput] = useState("")
	const previousProfileNameRef = useRef<string | undefined>(undefined)

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId, selectedModelInfo)

	// Get mode-specific fields
	const { openAiModelInfo } = getModeSpecificFields(apiConfiguration, currentMode)

	// Debounced function to refresh OpenAI models (prevents excessive API calls while typing)
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}
		}
	}, [])

	const currentProfileName =
		currentMode === "plan" ? apiConfiguration?.planModeOpenAiProfileName : apiConfiguration?.actModeOpenAiProfileName
	const profiles = apiConfiguration?.openAiCompatibleProfiles || []
	const currentProfile = profiles.find((p: OpenAiCompatibleProfile) => p.name === currentProfileName)

	const handleProfileChange = async (e: any) => {
		const name = e.target.value
		if (name === "manual" || name === "new") {
			await handleNewProfile()
			return
		}

		const profile = profiles.find((p: OpenAiCompatibleProfile) => p.name === name)
		if (profile) {
			previousProfileNameRef.current = name
			// Copy profile values to active fields
			await handleFieldsChange({
				openAiBaseUrl: profile.baseUrl,
				openAiApiKey: profile.apiKey,
				openAiHeaders: profile.headers,
				azureApiVersion: profile.azureApiVersion,
				...(currentMode === "plan"
					? { planModeOpenAiModelId: profile.modelId, planModeOpenAiModelInfo: profile.modelInfo }
					: { actModeOpenAiModelId: profile.modelId, actModeOpenAiModelInfo: profile.modelInfo }),
				[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: name,
			})
			setProfileNameInput(name)
		}
	}

	const handleNewProfile = async () => {
		previousProfileNameRef.current = currentProfileName
		setProfileNameInput("")
		await handleFieldsChange({
			[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: undefined,
		})
	}

	const handleSaveProfile = async () => {
		const nameToSave = profileNameInput.trim()
		if (!nameToSave) return

		const newProfile: OpenAiCompatibleProfile = {
			name: nameToSave,
			baseUrl: apiConfiguration?.openAiBaseUrl || "",
			apiKey: apiConfiguration?.openAiApiKey,
			modelId: selectedModelId || "",
			modelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			headers: apiConfiguration?.openAiHeaders,
			azureApiVersion: apiConfiguration?.azureApiVersion,
		}

		const updatedProfiles = [...profiles]
		const existingIndex = updatedProfiles.findIndex((p) => p.name === newProfile.name)
		if (existingIndex !== -1) {
			updatedProfiles[existingIndex] = newProfile
		} else {
			updatedProfiles.push(newProfile)
		}

		await handleFieldsChange({
			openAiCompatibleProfiles: updatedProfiles,
			[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: newProfile.name,
		})
		previousProfileNameRef.current = newProfile.name
	}

	const handleDeleteProfile = async () => {
		if (!currentProfileName) {
			// Cancel "New" mode and revert to previous profile
			if (previousProfileNameRef.current) {
				const prevProfile = profiles.find((p: OpenAiCompatibleProfile) => p.name === previousProfileNameRef.current)
				if (prevProfile) {
					await handleFieldsChange({
						openAiBaseUrl: prevProfile.baseUrl,
						openAiApiKey: prevProfile.apiKey,
						openAiHeaders: prevProfile.headers,
						azureApiVersion: prevProfile.azureApiVersion,
						...(currentMode === "plan"
							? { planModeOpenAiModelId: prevProfile.modelId, planModeOpenAiModelInfo: prevProfile.modelInfo }
							: { actModeOpenAiModelId: prevProfile.modelId, actModeOpenAiModelInfo: prevProfile.modelInfo }),
						[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]:
							previousProfileNameRef.current,
					})
					setProfileNameInput(previousProfileNameRef.current)
				} else {
					// Fallback if previous profile is gone
					await handleFieldsChange({
						[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: undefined,
					})
				}
			}
			return
		}

		const updatedProfiles = profiles.filter((p: OpenAiCompatibleProfile) => p.name !== currentProfileName)
		await handleFieldsChange({
			openAiCompatibleProfiles: updatedProfiles,
			[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: undefined,
		})
		setProfileNameInput("")
		previousProfileNameRef.current = undefined
	}

	const onRefreshModels = async () => {
		if (apiConfiguration?.openAiBaseUrl) {
			setIsRefreshingModels(true)
			try {
				await refreshOpenAiModels(apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey)
			} finally {
				setIsRefreshingModels(false)
			}
		}
	}

	const debouncedRefreshOpenAiModels = useCallback(
		(baseUrl?: string, apiKey?: string) => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}

			if (baseUrl && apiKey) {
				debounceTimerRef.current = setTimeout(() => {
					refreshOpenAiModels(baseUrl, apiKey)
				}, 500)
			}
		},
		[refreshOpenAiModels],
	)

	return (
		<div className="flex flex-col gap-4">
			{/* Profile Selection Section */}
			<div className="flex flex-col gap-2 p-3 border border-vscode-widget-border rounded-md bg-vscode-sideBar-background">
				<span style={{ fontWeight: 600, fontSize: "11px", textTransform: "uppercase", opacity: 0.8 }}>
					Saved Configurations
				</span>
				<div className="flex gap-2">
					<VSCodeDropdown
						className="flex-1"
						onChange={handleProfileChange}
						value={currentProfileName || (profiles.length === 0 ? "manual" : "new")}>
						<VSCodeOption value={profiles.length === 0 ? "manual" : "new"}>
							{profiles.length === 0 ? "Manual Configuration" : "New Configuration..."}
						</VSCodeOption>
						{profiles.map((p: OpenAiCompatibleProfile) => (
							<VSCodeOption key={p.name} value={p.name}>
								{p.name}
							</VSCodeOption>
						))}
					</VSCodeDropdown>
					<VSCodeButton appearance="icon" onClick={handleNewProfile} title="New Configuration">
						<PlusIcon size={16} />
					</VSCodeButton>
					{(currentProfile || currentProfileName === undefined) && (
						<VSCodeButton
							appearance="icon"
							onClick={handleDeleteProfile}
							title={currentProfile ? "Delete Profile" : "Cancel"}>
							{currentProfile ? <TrashIcon size={16} /> : <XIcon size={16} />}
						</VSCodeButton>
					)}
				</div>
			</div>

			{/* Settings Section */}
			<div className="flex flex-col gap-3">
				<Tooltip>
					<TooltipTrigger>
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<span style={{ fontWeight: 500 }}>Base URL</span>
								{remoteConfigSettings?.openAiBaseUrl !== undefined && (
									<i className="codicon codicon-lock text-description text-sm" />
								)}
							</div>
							<DebouncedTextField
								disabled={remoteConfigSettings?.openAiBaseUrl !== undefined}
								helpText="The base URL of the OpenAI-compatible API. Note: Do not include /chat/completions at the end."
								initialValue={apiConfiguration?.openAiBaseUrl || ""}
								onChange={(value: string) => {
									handleFieldChange("openAiBaseUrl", value)
									debouncedRefreshOpenAiModels(value, apiConfiguration?.openAiApiKey)
								}}
								placeholder={"Enter base URL..."}
								style={{ width: "100%" }}
								type="text"
							/>
						</div>
					</TooltipTrigger>
					<TooltipContent hidden={remoteConfigSettings?.openAiBaseUrl === undefined}>
						This setting is managed by your organization's remote configuration
					</TooltipContent>
				</Tooltip>

				<ApiKeyField
					initialValue={apiConfiguration?.openAiApiKey || ""}
					onChange={(value: string) => {
						handleFieldChange("openAiApiKey", value)
						debouncedRefreshOpenAiModels(apiConfiguration?.openAiBaseUrl, value)
					}}
					providerName="OpenAI Compatible"
				/>

				<div className="flex flex-col gap-2">
					<ModelAutocomplete
						label="Model ID"
						models={openAiModels}
						onChange={(newModelId: string, modelInfo: ModelInfo | undefined) => {
							handleModeFieldsChange(
								{
									openAiModelId: { plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" },
									openAiModelInfo: { plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
								},
								{
									openAiModelId: newModelId,
									openAiModelInfo: modelInfo || openAiModelInfoSaneDefaults,
								},
								currentMode,
							)
						}}
						placeholder="Enter or select Model ID..."
						selectedModelId={selectedModelId}
					/>
					<VSCodeButton
						className={`self-start ${isRefreshingModels ? "animate-pulse" : ""}`}
						disabled={isRefreshingModels || !apiConfiguration?.openAiBaseUrl}
						onClick={onRefreshModels}>
						{isRefreshingModels ? (
							"Refreshing..."
						) : (
							<>
								Refresh Models <RefreshCwIcon className="ml-1" size={14} />
							</>
						)}
					</VSCodeButton>
				</div>

				{/* Custom Headers */}
				{(() => {
					const headerEntries = Object.entries(apiConfiguration?.openAiHeaders ?? {}) as [string, string][]

					return (
						<div className="flex flex-col gap-2">
							<div className="flex justify-between items-center">
								<Tooltip>
									<TooltipTrigger>
										<div className="flex items-center gap-2">
											<span style={{ fontWeight: 500 }}>Custom Headers</span>
											{remoteConfigSettings?.openAiHeaders !== undefined && (
												<i className="codicon codicon-lock text-description text-sm" />
											)}
										</div>
									</TooltipTrigger>
									<TooltipContent hidden={remoteConfigSettings?.openAiHeaders === undefined}>
										This setting is managed by your organization's remote configuration
									</TooltipContent>
								</Tooltip>
								<VSCodeButton
									disabled={remoteConfigSettings?.openAiHeaders !== undefined}
									onClick={() => {
										const currentHeaders = { ...(apiConfiguration?.openAiHeaders || {}) }
										const headerCount = Object.keys(currentHeaders).length
										const newKey = `header${headerCount + 1}`
										currentHeaders[newKey] = ""
										handleFieldChange("openAiHeaders", currentHeaders)
									}}>
									Add Header
								</VSCodeButton>
							</div>

							<div className="flex flex-col gap-2">
								{headerEntries.map(([key, value], index) => (
									<div key={index} className="flex gap-2">
										<DebouncedTextField
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											initialValue={key}
											onChange={(newValue: string) => {
												const currentHeaders = apiConfiguration?.openAiHeaders ?? {}
												if (newValue && newValue !== key) {
													const { [key]: _, ...rest } = currentHeaders
													handleFieldChange("openAiHeaders", {
														...rest,
														[newValue]: value,
													})
												}
											}}
											placeholder="Header name"
											style={{ flex: 1 }}
										/>
										<DebouncedTextField
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											initialValue={value as string}
											onChange={(newValue: string) => {
												handleFieldChange("openAiHeaders", {
													...(apiConfiguration?.openAiHeaders ?? {}),
													[key]: newValue,
												})
											}}
											placeholder="Header value"
											style={{ flex: 1 }}
										/>
										<VSCodeButton
											appearance="secondary"
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											onClick={() => {
												const { [key]: _, ...rest } = apiConfiguration?.openAiHeaders ?? {}
												handleFieldChange("openAiHeaders", rest)
											}}>
											Remove
										</VSCodeButton>
									</div>
								))}
							</div>
						</div>
					)
				})()}

				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<span style={{ fontWeight: 500 }}>Azure API Version</span>
						{remoteConfigSettings?.azureApiVersion !== undefined && (
							<i className="codicon codicon-lock text-description text-sm" />
						)}
					</div>
					<DebouncedTextField
						disabled={remoteConfigSettings?.azureApiVersion !== undefined}
						initialValue={apiConfiguration?.azureApiVersion || ""}
						onChange={(value: string) => handleFieldChange("azureApiVersion", value)}
						placeholder={`Default: ${azureOpenAiDefaultApiVersion}`}
						style={{ width: "100%" }}
						type="text"
					/>
				</div>

				<div
					onClick={() => setModelConfigurationSelected((val) => !val)}
					style={{
						color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
						display: "flex",
						margin: "8px 0",
						cursor: "pointer",
						alignItems: "center",
					}}>
					<span
						className={`codicon ${modelConfigurationSelected ? "codicon-chevron-down" : "codicon-chevron-right"}`}
						style={{ marginRight: "4px" }}
					/>
					<span style={{ fontWeight: 700, textTransform: "uppercase", fontSize: "11px" }}>Model Configuration</span>
				</div>

				{modelConfigurationSelected && (
					<div className="flex flex-col gap-3 pl-2 border-l-2 border-vscode-widget-border">
						<VSCodeCheckbox
							checked={!!openAiModelInfo?.supportsImages}
							onChange={(e: any) => {
								const isChecked = (e.target as HTMLInputElement).checked === true
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.supportsImages = isChecked
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}>
							Supports Images
						</VSCodeCheckbox>

						<VSCodeCheckbox
							checked={!!openAiModelInfo?.isR1FormatRequired}
							onChange={(e: any) => {
								const isChecked = (e.target as HTMLInputElement).checked === true
								let modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo = { ...modelInfo, isR1FormatRequired: isChecked }
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}>
							Enable R1 messages format
						</VSCodeCheckbox>

						<div className="flex gap-2">
							<DebouncedTextField
								initialValue={
									openAiModelInfo?.contextWindow
										? openAiModelInfo.contextWindow.toString()
										: (openAiModelInfoSaneDefaults.contextWindow?.toString() ?? "")
								}
								onChange={(value: string) => {
									const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
									modelInfo.contextWindow = Number(value)
									handleModeFieldChange(
										{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
										modelInfo,
										currentMode,
									)
								}}
								style={{ flex: 1 }}>
								<span style={{ fontWeight: 500 }}>Context Window</span>
							</DebouncedTextField>

							<DebouncedTextField
								initialValue={
									openAiModelInfo?.maxTokens
										? openAiModelInfo.maxTokens.toString()
										: (openAiModelInfoSaneDefaults.maxTokens?.toString() ?? "")
								}
								onChange={(value: string) => {
									const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
									modelInfo.maxTokens = Number(value)
									handleModeFieldChange(
										{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
										modelInfo,
										currentMode,
									)
								}}
								style={{ flex: 1 }}>
								<span style={{ fontWeight: 500 }}>Max Output</span>
							</DebouncedTextField>
						</div>

						<div className="flex gap-2">
							<DebouncedTextField
								initialValue={
									openAiModelInfo?.inputPrice
										? openAiModelInfo.inputPrice.toString()
										: (openAiModelInfoSaneDefaults.inputPrice?.toString() ?? "")
								}
								onChange={(value: string) => {
									const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
									modelInfo.inputPrice = parsePrice(value, openAiModelInfoSaneDefaults.inputPrice ?? 0)
									handleModeFieldChange(
										{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
										modelInfo,
										currentMode,
									)
								}}
								style={{ flex: 1 }}>
								<span style={{ fontWeight: 500 }}>Input Price / 1M</span>
							</DebouncedTextField>

							<DebouncedTextField
								initialValue={
									openAiModelInfo?.outputPrice
										? openAiModelInfo.outputPrice.toString()
										: (openAiModelInfoSaneDefaults.outputPrice?.toString() ?? "")
								}
								onChange={(value: string) => {
									const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
									modelInfo.outputPrice = parsePrice(value, openAiModelInfoSaneDefaults.outputPrice ?? 0)
									handleModeFieldChange(
										{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
										modelInfo,
										currentMode,
									)
								}}
								style={{ flex: 1 }}>
								<span style={{ fontWeight: 500 }}>Output Price / 1M</span>
							</DebouncedTextField>
						</div>

						<div className="flex gap-2">
							<DebouncedTextField
								initialValue={
									openAiModelInfo?.temperature
										? openAiModelInfo.temperature.toString()
										: (openAiModelInfoSaneDefaults.temperature?.toString() ?? "")
								}
								onChange={(value: string) => {
									const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
									modelInfo.temperature = parsePrice(value, openAiModelInfoSaneDefaults.temperature ?? 0)
									handleModeFieldChange(
										{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
										modelInfo,
										currentMode,
									)
								}}
								style={{ flex: 1 }}>
								<span style={{ fontWeight: 500 }}>Temperature</span>
							</DebouncedTextField>
						</div>
					</div>
				)}

				<p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
					<span style={{ color: "var(--vscode-errorForeground)" }}>
						<span style={{ fontWeight: 500 }}>Note:</span> Dirac uses complex prompts and works best with Claude
						models. Less capable models may not work as expected.
					</span>
				</p>

				{showModelOptions && (
					<div className="flex flex-col gap-3">
						{showReasoningEffort && <ReasoningEffortSelector currentMode={currentMode} />}
						<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
					</div>
				)}
			</div>

			{/* Save Configuration Section */}
			<div className="mt-2 p-3 border border-vscode-widget-border rounded-md bg-vscode-sideBar-background">
				<span style={{ fontWeight: 600, fontSize: "11px", textTransform: "uppercase", opacity: 0.8 }}>
					Save Configuration
				</span>
				<div className="flex flex-col gap-2 mt-2">
					<VSCodeTextField
						className="w-full"
						onInput={(e: any) => setProfileNameInput(e.target.value)}
						placeholder="Configuration name..."
						value={profileNameInput}
					/>
					<VSCodeButton
						className="w-full"
						disabled={!profileNameInput.trim()}
						onClick={handleSaveProfile}
						appearance="secondary">
						Save Configuration
					</VSCodeButton>
				</div>
			</div>
		</div>
	)
}
