import { TooltipContent, TooltipTrigger } from "@radix-ui/react-tooltip"
import { type ApiConfiguration, azureOpenAiDefaultApiVersion, ModelInfo, OpenAiCompatibleProfile, openAiModelInfoSaneDefaults } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { PlusIcon, RefreshCwIcon, TrashIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import {
	getModeSpecificFields,
	normalizeApiConfiguration,
	supportsReasoningEffortForModelId,
} from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND } from "@/shared/lib/vscStyles"
import { Tooltip } from "@/shared/ui/tooltip"
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
	intent?: "setup" | "activate"
}

/**
 * The OpenAI Compatible provider configuration component
 */
export const OpenAICompatibleProvider = ({ showModelOptions, isPopup, currentMode, intent = "activate" }: OpenAICompatibleProviderProps) => {
	const savedConfiguration = useSettingsStore((state) => state.apiConfiguration)
	const remoteConfigSettings = useSettingsStore((state) => state.remoteConfigSettings)
	const openAiModels = useSettingsStore((state) => state.openAiModels)
	const refreshOpenAiModels = useSettingsStore((state) => state.refreshOpenAiModels)
	const { handleFieldsChange: persistFields, handleModeFieldChange: persistModeField, handleModeFieldsChange: persistModeFields } = useApiConfigurationHandlers()
	const profiles: OpenAiCompatibleProfile[] = savedConfiguration?.openAiCompatibleProfiles || []
	const selectedProfileName = currentMode === "plan" ? savedConfiguration?.planModeOpenAiProfileName : savedConfiguration?.actModeOpenAiProfileName
	const hasLegacySetup = !!(savedConfiguration?.openAiBaseUrl || savedConfiguration?.openAiApiKey)
	const [editingLegacy, setEditingLegacy] = useState(intent === "setup" && hasLegacySetup)
	const initialProfile = intent === "setup" && hasLegacySetup ? undefined : profiles.find((profile) => profile.name === selectedProfileName)
	const [currentProfileName, setCurrentProfileName] = useState(initialProfile?.name)
	const [profileNameInput, setProfileNameInput] = useState(initialProfile?.name || "")
	const [profileError, setProfileError] = useState<string>()
	const [modelConfigurationSelected, setModelConfigurationSelected] = useState(false)
	const [isRefreshingModels, setIsRefreshingModels] = useState(false)
	const profileConfiguration = (profile?: OpenAiCompatibleProfile): ApiConfiguration => ({
		openAiBaseUrl: profile?.baseUrl || "",
		openAiApiKey: profile?.apiKey,
		openAiHeaders: profile?.headers,
		azureApiVersion: profile?.azureApiVersion,
		planModeApiProvider: "openai",
		actModeApiProvider: "openai",
		planModeOpenAiModelId: profile?.modelId || "",
		actModeOpenAiModelId: profile?.modelId || "",
		planModeOpenAiModelInfo: structuredClone(profile?.modelInfo || openAiModelInfoSaneDefaults),
		actModeOpenAiModelInfo: structuredClone(profile?.modelInfo || openAiModelInfoSaneDefaults),
	})
	const [apiConfiguration, setDraft] = useState<ApiConfiguration>(() => initialProfile
		? profileConfiguration(initialProfile)
		: { ...structuredClone(savedConfiguration), planModeApiProvider: "openai", actModeApiProvider: "openai" })
	// Keep rows while names are incomplete or duplicated instead of collapsing them into an object.
	const [headerEntries, setHeaderEntries] = useState<[string, string][]>(() => Object.entries(apiConfiguration.openAiHeaders ?? {}))
	const headerNames = headerEntries.map(([name]) => name.toLowerCase())
	const headerError = headerEntries.some(([name]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
		? "Each custom header needs a valid, non-empty name."
		: new Set(headerNames).size !== headerNames.length
			? "Custom header names must be unique (case-insensitive)."
			: undefined
	const currentProfile = profiles.find((profile) => profile.name === currentProfileName)
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId, selectedModelInfo)
	const { openAiModelInfo } = getModeSpecificFields(apiConfiguration, currentMode)
	const handleFieldChange = (field: keyof ApiConfiguration, value: unknown) => setDraft((draft) => ({ ...draft, [field]: value }))
	const handleModeFieldChange = (pair: { plan: keyof ApiConfiguration; act: keyof ApiConfiguration }, value: ApiConfiguration[keyof ApiConfiguration], mode: Mode) => {
		if (intent === "activate" || showModelOptions) void persistModeField(pair, value, mode)
		setDraft((draft) => ({ ...draft, [pair.plan]: value, [pair.act]: value }))
	}
	const handleModeFieldsChange = (pairs: Record<string, { plan: keyof ApiConfiguration; act: keyof ApiConfiguration }>, values: Record<string, unknown>, mode: Mode) => {
		if (intent === "activate" || showModelOptions) void persistModeFields(pairs, values, mode)
		setDraft((draft) => {
			const next = { ...draft }
			for (const [key, pair] of Object.entries(pairs)) {
				Object.assign(next, { [pair.plan]: values[key], [pair.act]: values[key] })
			}
			return next
		})
	}
	const endpointHeadersKey = JSON.stringify([...headerEntries].sort(([a], [b]) => a.localeCompare(b)))
	// Input edits update the draft immediately; only endpoint discovery is debounced.
	useEffect(() => {
		if (headerError) return
		const timer = setTimeout(() => {
			void refreshOpenAiModels(apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey, Object.fromEntries(JSON.parse(endpointHeadersKey)))
		}, 250)
		return () => clearTimeout(timer)
	}, [apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey, endpointHeadersKey, headerError, refreshOpenAiModels])
	const handleProfileChange = async (event: { target: EventTarget | null }) => {
		const name = (event.target as HTMLSelectElement).value
		const profile = profiles.find((candidate) => candidate.name === name)
		if (!profile) { handleNewProfile(); return }
		setCurrentProfileName(profile.name)
		setEditingLegacy(false)
		setProfileNameInput(profile.name)
		setDraft(profileConfiguration(profile))
		setHeaderEntries(Object.entries(profile.headers ?? {}))
		setProfileError(undefined)
		if (intent === "activate") {
			await persistFields({
				[currentMode === "plan" ? "planModeOpenAiProfileName" : "actModeOpenAiProfileName"]: profile.name,
				[currentMode === "plan" ? "planModeOpenAiModelId" : "actModeOpenAiModelId"]: profile.modelId,
				[currentMode === "plan" ? "planModeOpenAiModelInfo" : "actModeOpenAiModelInfo"]: profile.modelInfo,
			})
		}
	}
	const handleNewProfile = () => {
		setEditingLegacy(false)
		setCurrentProfileName(undefined)
		setProfileNameInput("")
		setDraft(profileConfiguration())
		setHeaderEntries([])
		setProfileError(undefined)
	}
	const editLegacySetup = () => {
		setEditingLegacy(true)
		setCurrentProfileName(undefined)
		setProfileNameInput("")
		setDraft({ ...structuredClone(savedConfiguration), planModeApiProvider: "openai", actModeApiProvider: "openai" })
		setHeaderEntries(Object.entries(savedConfiguration.openAiHeaders ?? {}))
		setProfileError(undefined)
	}
	const saveLegacySetup = async () => {
		if (headerError) return
		await persistFields({
			openAiBaseUrl: apiConfiguration.openAiBaseUrl ?? "", openAiApiKey: apiConfiguration.openAiApiKey ?? "",
			openAiHeaders: Object.fromEntries(headerEntries), azureApiVersion: apiConfiguration.azureApiVersion ?? "",
		}, "openai")
	}
	const handleSaveProfile = async () => {
		if (headerError) return
		const name = profileNameInput.trim()
		if (!name) { setProfileError("A configuration name is required."); return }
		if (profiles.some((profile) => profile.name === name && profile.name !== currentProfileName)) {
			setProfileError("A configuration with this name already exists.")
			return
		}
		// Endpoint names are stable references; rename is not implicit activation or retargeting.
		if (currentProfileName && name !== currentProfileName) {
			setProfileError("Create a new configuration to use a different name.")
			return
		}
		const profile: OpenAiCompatibleProfile = {
			name, baseUrl: apiConfiguration.openAiBaseUrl || "", apiKey: apiConfiguration.openAiApiKey,
			modelId: getModeSpecificFields(apiConfiguration, currentMode).openAiModelId || "", modelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			headers: Object.fromEntries(headerEntries), azureApiVersion: apiConfiguration.azureApiVersion,
		}
		const next = currentProfileName ? profiles.map((entry) => entry.name === currentProfileName ? profile : entry) : [...profiles, profile]
		if (await persistFields({ openAiCompatibleProfiles: next })) {
			setCurrentProfileName(name)
			setProfileError(undefined)
		}
	}
	const handleDeleteProfile = async () => {
		if (!currentProfileName) { handleNewProfile(); return }
		if (await persistFields({ openAiCompatibleProfiles: profiles.filter((profile) => profile.name !== currentProfileName) })) handleNewProfile()
	}
	const onRefreshModels = async () => {
		if (headerError) return
		setIsRefreshingModels(true)
		try { await refreshOpenAiModels(apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey, Object.fromEntries(headerEntries)) }
		finally { setIsRefreshingModels(false) }
	}

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
			{intent === "setup" && hasLegacySetup && <VSCodeButton onClick={editLegacySetup}>Edit legacy endpoint</VSCodeButton>}

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
							<VSCodeTextField
								disabled={remoteConfigSettings?.openAiBaseUrl !== undefined}
								value={apiConfiguration?.openAiBaseUrl || ""}
								onInput={(event) => handleFieldChange("openAiBaseUrl", (event.target as HTMLInputElement).value)}
								placeholder="Enter base URL..."
								style={{ width: "100%" }}
								type="text">
								<div slot="helper-text" className="text-xs text-description">The base URL of the OpenAI-compatible API. Note: Do not include /chat/completions at the end.</div>
							</VSCodeTextField>
						</div>
					</TooltipTrigger>
					<TooltipContent hidden={remoteConfigSettings?.openAiBaseUrl === undefined}>
						This setting is managed by your organization's remote configuration
					</TooltipContent>
				</Tooltip>

				<div>
					<VSCodeTextField
						value={apiConfiguration?.openAiApiKey || ""}
						onInput={(event) => handleFieldChange("openAiApiKey", (event.target as HTMLInputElement).value)}
						placeholder="Enter API Key..."
						required
						type="password"
						style={{ width: "100%" }}>
						<span style={{ fontWeight: 500 }}>OpenAI Compatible API Key</span>
					</VSCodeTextField>
					<p className="mt-1 text-xs text-description">This key is stored locally and only used to make API requests from this extension.</p>
				</div>

				{showModelOptions && <>
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
				</>}

				{/* Custom Headers */}
				{headerError && <p role="alert" className="text-xs text-error">{headerError}</p>}
				{(() => {

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
										setHeaderEntries((entries) => [...entries, ["", ""]])
									}}>
									Add Header
								</VSCodeButton>
							</div>

							<div className="flex flex-col gap-2">
								{headerEntries.map(([key, value], index) => (
									<div className="flex gap-2" key={index}>
										<VSCodeTextField
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											value={key}
											onInput={(event) => {
												const newValue = (event.target as HTMLInputElement).value
												setHeaderEntries((entries) => entries.map((entry, i) => i === index ? [newValue, entry[1]] : entry))
											}}
											placeholder="Header name"
											style={{ flex: 1 }}
										/>
										<VSCodeTextField
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											value={value}
											onInput={(event) => {
												const newValue = (event.target as HTMLInputElement).value
												setHeaderEntries((entries) => entries.map((entry, i) => i === index ? [entry[0], newValue] : entry))
											}}
											placeholder="Header value"
											style={{ flex: 1 }}
										/>
										<VSCodeButton
											appearance="secondary"
											disabled={remoteConfigSettings?.openAiHeaders !== undefined}
											onClick={() => {
												setHeaderEntries((entries) => entries.filter((_, i) => i !== index))
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
					<VSCodeTextField
						disabled={remoteConfigSettings?.azureApiVersion !== undefined}
						value={apiConfiguration?.azureApiVersion || ""}
						onInput={(event) => handleFieldChange("azureApiVersion", (event.target as HTMLInputElement).value)}
						placeholder={`Default: ${azureOpenAiDefaultApiVersion}`}
						style={{ width: "100%" }}
						type="text"
					/>
				</div>

				{showModelOptions && <>
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
				</>}

				{showModelOptions && modelConfigurationSelected && (
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

			{profileError && <p role="alert">{profileError}</p>}
			{/* Save Configuration Section */}
			{editingLegacy ? <VSCodeButton onClick={saveLegacySetup}>Save legacy endpoint</VSCodeButton> : <div className="mt-2 p-3 border border-vscode-widget-border rounded-md bg-vscode-sideBar-background">
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
						appearance="secondary"
						className="w-full"
						disabled={!profileNameInput.trim()}
						onClick={handleSaveProfile}>
						Save Configuration
					</VSCodeButton>
				</div>
			</div>}
		</div>
	)
}
