import type { ApiConfiguration, ModelInfo } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import PROVIDERS from "@shared/providers/providers.json"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { ChevronDown } from "lucide-react"
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "./OpenRouterModelPicker"
import { AIhubmixProvider } from "./providers/AihubmixProvider"
import { AnthropicProvider } from "./providers/AnthropicProvider"
import { BasetenProvider } from "./providers/BasetenProvider"
import { GithubCopilotProvider } from "./providers/GithubCopilotProvider"
import { BedrockProvider } from "./providers/BedrockProvider"
import { CerebrasProvider } from "./providers/CerebrasProvider"
import { ClaudeCodeProvider } from "./providers/ClaudeCodeProvider"
import { DeepSeekProvider } from "./providers/DeepSeekProvider"
import { UnbiasedProvider } from "./providers/UnbiasedProvider"
import { DifyProvider } from "./providers/DifyProvider"
import { DoubaoProvider } from "./providers/DoubaoProvider"
import { FireworksProvider } from "./providers/FireworksProvider"
import { GeminiProvider } from "./providers/GeminiProvider"
import { GroqProvider } from "./providers/GroqProvider"
import { HuaweiCloudMaasProvider } from "./providers/HuaweiCloudMaasProvider"
import { HuggingFaceProvider } from "./providers/HuggingFaceProvider"
import { LiteLlmProvider } from "./providers/LiteLlmProvider"
import { LMStudioProvider } from "./providers/LMStudioProvider"
import { MinimaxProvider } from "./providers/MiniMaxProvider"
import { MistralProvider } from "./providers/MistralProvider"
import { MoonshotProvider } from "./providers/MoonshotProvider"
import { NebiusProvider } from "./providers/NebiusProvider"
import { NousResearchProvider } from "./providers/NousresearchProvider"
import { OpenAICompatibleProvider } from "./providers/OpenAICompatible"
import { OpenAINativeProvider } from "./providers/OpenAINative"
import { OpenAiCodexProvider } from "./providers/OpenAiCodexProvider"
import { OpenRouterProvider } from "./providers/OpenRouterProvider"
import { QwenCodeProvider } from "./providers/QwenCodeProvider"
import { QwenProvider } from "./providers/QwenProvider"
import { RequestyProvider } from "./providers/RequestyProvider"
import { SambanovaProvider } from "./providers/SambanovaProvider"
import { TogetherProvider } from "./providers/TogetherProvider"
import { VercelAIGatewayProvider } from "./providers/VercelAIGatewayProvider"
import { VertexProvider } from "./providers/VertexProvider"
import { VSCodeLmProvider } from "./providers/VSCodeLmProvider"
import { WandbProvider } from "./providers/WandbProvider"
import { XaiProvider } from "./providers/XaiProvider"
import { ZAiProvider } from "./providers/ZAiProvider"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"
import { ProviderSetupContext } from "./utils/ProviderSetupContext"

interface ApiOptionsProps {
	showModelOptions: boolean
	apiErrorMessage?: string
	modelIdErrorMessage?: string
	isPopup?: boolean
	currentMode: Mode
	intent?: "setup" | "activate"
	initialSetupProvider?: string
}

// This is necessary to ensure dropdown opens downward, important for when this is used in popup
export const DROPDOWN_Z_INDEX = OPENROUTER_MODEL_PICKER_Z_INDEX + 2 // Higher than the OpenRouterModelPicker's and ModelSelectorTooltip's z-index

export const DropdownContainer = styled.div<{ zIndex?: number }>`
	position: relative;
	z-index: ${(props) => props.zIndex || DROPDOWN_Z_INDEX};

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

declare module "vscode" {
	interface LanguageModelChatSelector {
		vendor?: string
		family?: string
		version?: string
		id?: string
	}
}

const ApiOptions = ({ showModelOptions, apiErrorMessage, modelIdErrorMessage, isPopup, currentMode, intent = "activate", initialSetupProvider }: ApiOptionsProps) => {
	const apiConfiguration = useSettingsStore((state) => state.apiConfiguration)
	const remoteConfigSettings = useSettingsStore((state) => state.remoteConfigSettings)
	const apiConfigurationError = useSettingsStore((state) => state.apiConfigurationError)
	const planActSeparateModelsSetting = useSettingsStore((state) => state.planActSeparateModelsSetting)
	const { selectedProvider: configuredProvider } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const [setupProvider, setSetupProvider] = useState<string | undefined>(initialSetupProvider)
	const selectedProvider = intent === "setup" ? setupProvider ?? "" : configuredProvider
	const configuredApiProviders = useSettingsStore((state) => state.configuredApiProviders)
	const [isAddingProvider, setIsAddingProvider] = useState(false)
	const [addedProvider, setAddedProvider] = useState<string>()
	const isEditingSetup = intent === "setup" && initialSetupProvider !== undefined
	const providerListId = useId()
	const modeFields = getModeSpecificFields(apiConfiguration, currentMode)
	const { handleFieldsChange, handleModeFieldsChange } = useApiConfigurationHandlers()

	// Provider search state
	const [searchTerm, setSearchTerm] = useState("")
	const [isDropdownVisible, setIsDropdownVisible] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const [pendingProvider, setPendingProvider] = useState<string>()
	const dropdownRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const dropdownListRef = useRef<HTMLDivElement>(null)
	const activeProvider = pendingProvider || selectedProvider
	const isProviderAdded = configuredApiProviders.some((provider) => provider === activeProvider) || addedProvider === activeProvider
	const selectedModeProvider = modeFields.apiProvider || selectedProvider
	const isSwitchingToOpenRouter = pendingProvider === "openrouter" && selectedModeProvider !== "openrouter"

	const providerOptions = useMemo(() => {
		let providers = PROVIDERS.list
		// Filter by platform
		if (PLATFORM_CONFIG.type !== PlatformType.VSCODE) {
			// Don't include VS Code LM API for non-VSCode platforms
			providers = providers.filter((option) => option.value !== "vscode-lm")
		} else {
			// Don't include native GitHub Copilot for VSCode (use vscode-lm instead)
			providers = providers.filter((option) => option.value !== "github-copilot")
		}

		// Filter by remote config if remoteConfiguredProviders is set
		const remoteProviders: string[] = remoteConfigSettings?.remoteConfiguredProviders || []
		if (remoteProviders.length > 0) {
			providers = providers.filter((option) => remoteProviders.includes(option.value))
		}

		return providers
	}, [remoteConfigSettings])

	const currentProviderLabel = useMemo(() => {
		return providerOptions.find((option) => option.value === activeProvider)?.label || activeProvider
	}, [providerOptions, activeProvider])

	// Sync search term with current provider when not searching
	useEffect(() => {
		if (!isDropdownVisible) {
			setSearchTerm(currentProviderLabel)
		}
	}, [currentProviderLabel, isDropdownVisible])

	const searchableItems = useMemo(() => {
		return providerOptions.map((option) => ({
			value: option.value,
			html: option.label,
		}))
	}, [providerOptions])

	const fuse = useMemo(() => {
		return new Fuse(searchableItems, {
			keys: ["html"],
			threshold: 0.3,
			shouldSort: true,
			isCaseSensitive: false,
			ignoreLocation: false,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [searchableItems])

	const providerSearchResults = useMemo(() => {
		return searchTerm && searchTerm !== currentProviderLabel ? fuse.search(searchTerm)?.map((r) => r.item) : searchableItems
	}, [searchableItems, searchTerm, fuse, currentProviderLabel])

	const handleProviderChange = (newProvider: string) => {
		setIsDropdownVisible(false)
		setSelectedIndex(-1)
		if (intent === "setup") {
			setSetupProvider(newProvider)
			return
		}
		if (newProvider === "openrouter" && !modeFields.openRouterModelId && selectedModeProvider !== "openrouter") {
			setSearchTerm("OpenRouter")
			setPendingProvider(newProvider)
			return
		}
		setPendingProvider(undefined)
		void handleModeFieldsChange(
			{
				apiProvider: { plan: "planModeApiProvider", act: "actModeApiProvider" },
				inferenceSpeed: { plan: "planModeInferenceSpeed", act: "actModeInferenceSpeed" },
			},
			{ apiProvider: newProvider, inferenceSpeed: "default" },
			currentMode,
		)
	}

	const addProvider = async () => {
		setIsAddingProvider(true)
		try {
			if (await handleFieldsChange({}, activeProvider)) setAddedProvider(activeProvider)
		} finally {
			setIsAddingProvider(false)
		}
	}

	const handlePendingOpenRouterModelSelected = async (modelId: string, modelInfo: ModelInfo | undefined): Promise<boolean> => {
		const updates: Partial<ApiConfiguration> = planActSeparateModelsSetting
			? currentMode === "plan"
				? {
					planModeApiProvider: "openrouter",
					planModeOpenRouterModelId: modelId,
					planModeOpenRouterModelInfo: modelInfo,
					planModeInferenceSpeed: "default",
				}
				: {
					actModeApiProvider: "openrouter",
					actModeOpenRouterModelId: modelId,
					actModeOpenRouterModelInfo: modelInfo,
					actModeInferenceSpeed: "default",
				}
			: {
				planModeApiProvider: "openrouter",
				actModeApiProvider: "openrouter",
				planModeOpenRouterModelId: modelId,
				actModeOpenRouterModelId: modelId,
				planModeOpenRouterModelInfo: modelInfo,
				actModeOpenRouterModelInfo: modelInfo,
				planModeInferenceSpeed: "default",
				actModeInferenceSpeed: "default",
			}
		const saved = await handleFieldsChange(updates)
		if (saved) setPendingProvider(undefined)
		return saved
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!isDropdownVisible) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault()
				setIsDropdownVisible(true)
				setSelectedIndex(0)
			}
			return
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setSelectedIndex((prev) => (prev < providerSearchResults.length - 1 ? prev + 1 : prev))
				break
			case "ArrowUp":
				event.preventDefault()
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
				break
			case "Enter":
				event.preventDefault()
				if (selectedIndex >= 0 && selectedIndex < providerSearchResults.length) {
					handleProviderChange(providerSearchResults[selectedIndex].value)
				}
				break
			case "Escape":
				event.preventDefault()
				event.stopPropagation()
				setIsDropdownVisible(false)
				setSelectedIndex(-1)
				setSearchTerm(currentProviderLabel)
				break
		}
	}

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownVisible(false)
				setSearchTerm(currentProviderLabel)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [currentProviderLabel])

	// Reset selection when search term changes
	useEffect(() => {
		setSelectedIndex(-1)
		if (dropdownListRef.current) {
			dropdownListRef.current.scrollTop = 0
		}
	}, [searchTerm])

	// Scroll selected item into view
	useEffect(() => {
		if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			})
		}
	}, [selectedIndex])

	/*
	VSCodeDropdown has an open bug where dynamically rendered options don't auto select the provided value prop. You can see this for yourself by comparing it with normal select/option elements, which work as expected.

	In our case, when the user switches between providers, we recalculate the selectedModelId depending on the provider, the default model for that provider, and a modelId that the user may have selected. Unfortunately, the VSCodeDropdown component wouldn't select this calculated value, and would default to the first "Select a model..." option instead, which makes it seem like the model was cleared out when it wasn't.

	As a workaround, we create separate instances of the dropdown for each provider, and then conditionally render the one that matches the current provider.
	*/

	return (
		<ProviderSetupContext.Provider value={activeProvider}>
			<div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: isPopup ? -10 : 0 }}>
				<style>
					{`
				.provider-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
				</style>
				{!isEditingSetup && (
					<DropdownContainer className="dropdown-container">
						{remoteConfigSettings?.remoteConfiguredProviders && remoteConfigSettings.remoteConfiguredProviders.length > 0 ? (
							<Tooltip>
								<TooltipTrigger>
									<div className="flex items-center gap-2 mb-1">
										<label htmlFor="api-provider">
											<span style={{ fontWeight: 500 }}>{intent === "setup" ? "Choose a provider" : "API Provider"}</span>
										</label>
										<i className="codicon codicon-lock text-description text-sm" />
									</div>
								</TooltipTrigger>
								<TooltipContent>Provider options are managed by your organization's remote configuration</TooltipContent>
							</Tooltip>
						) : (
							<label htmlFor="api-provider">
								<span style={{ fontWeight: 500 }}>{intent === "setup" ? "Choose a provider" : "API Provider"}</span>
							</label>
						)}
						<ProviderDropdownWrapper
							ref={dropdownRef}
							onBlur={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget)) {
									setIsDropdownVisible(false)
									setSelectedIndex(-1)
								}
							}}>
							<VSCodeTextField
								data-testid="provider-selector-input"
								id="api-provider"
								disabled={isAddingProvider}
								aria-label={intent === "setup" ? "Choose a provider" : "API Provider"}
								aria-expanded={isDropdownVisible}
								aria-controls={providerListId}
								aria-autocomplete="list"
								aria-activedescendant={isDropdownVisible && selectedIndex >= 0 ? `${providerListId}-${selectedIndex}` : undefined}
								onClick={() => {
									if (!isDropdownVisible) {
										setSearchTerm("")
										setIsDropdownVisible(true)
									}
								}}
								onFocus={() => {
									setIsDropdownVisible(true)
									setSearchTerm("")
								}}
								onInput={(e) => {
									setSearchTerm((e.target as HTMLInputElement)?.value || "")
									setIsDropdownVisible(true)
								}}
								onKeyDown={handleKeyDown}
								placeholder="Search and select provider..."
								role="combobox"
								style={{
									width: "100%",
									zIndex: DROPDOWN_Z_INDEX,
									position: "relative",
									minWidth: 130,
								}}
								value={searchTerm}>
								<span slot="end" className="pointer-events-none flex items-center px-1" aria-hidden="true">
									<ChevronDown size={14} />
								</span>
							</VSCodeTextField>
							{isDropdownVisible && (
								<ProviderDropdownList ref={dropdownListRef} id={providerListId} role="listbox" aria-label="API providers">
									{providerSearchResults.length === 0 && <div className="p-2 text-description" role="status">No providers found.</div>}
									{providerSearchResults.map((item, index) => (
										<ProviderDropdownItem
											data-testid={`provider-option-${item.value}`}
											id={`${providerListId}-${index}`}
											aria-selected={item.value === activeProvider}
											onMouseDown={(event) => event.preventDefault()}
											$isSelected={index === selectedIndex}
											key={item.value}
											onClick={() => handleProviderChange(item.value)}
											onMouseEnter={() => setSelectedIndex(index)}
											ref={(el) => {
												itemRefs.current[index] = el
											}}
											role="option">
											<span>{item.html}</span>
										</ProviderDropdownItem>
									))}
								</ProviderDropdownList>
							)}
						</ProviderDropdownWrapper>
					</DropdownContainer>
				)}

				{intent === "setup" && activeProvider && (
					<div className="my-2 text-xs text-description">
						{!isEditingSetup && isProviderAdded && <p className="m-0 mb-1" role="status">This provider is added. You can edit its setup below.</p>}
						<p className="m-0">
							{activeProvider === "openai"
								? "Use the save button below to save your endpoint configuration."
								: "Credential and connection settings save automatically. Complete any sign-in steps below if required."}
						</p>
					</div>
				)}

				{apiConfiguration && selectedProvider === "anthropic" && (
					<AnthropicProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "claude-code" && (
					<ClaudeCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "openai-native" && (
					<OpenAINativeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "openai-codex" && (
					<OpenAiCodexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "qwen" && (
					<QwenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "qwen-code" && (
					<QwenCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "doubao" && (
					<DoubaoProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "mistral" && (
					<MistralProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && activeProvider === "openrouter" && (
					<OpenRouterProvider
						currentMode={currentMode}
						isPendingProviderSelection={isSwitchingToOpenRouter}
						isPopup={isPopup}
						onCancelProviderSelection={() => setPendingProvider(undefined)}
						onModelSelected={isSwitchingToOpenRouter ? handlePendingOpenRouterModelSelected : undefined}
						showModelOptions={showModelOptions}
					/>
				)}

				{apiConfiguration && selectedProvider === "deepseek" && (
					<DeepSeekProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "unbiased" && (
					<UnbiasedProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "together" && (
					<TogetherProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "openai" && (
					<OpenAICompatibleProvider currentMode={currentMode} intent={intent} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "vercel-ai-gateway" && (
					<VercelAIGatewayProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "sambanova" && (
					<SambanovaProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "bedrock" && (
					<BedrockProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "vertex" && (
					<VertexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "gemini" && (
					<GeminiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "requesty" && (
					<RequestyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "fireworks" && (
					<FireworksProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "github-copilot" && (
					<GithubCopilotProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "vscode-lm" && (showModelOptions ? <VSCodeLmProvider currentMode={currentMode} /> : <p>Use your installed VS Code language model provider. Select its model in Model configurations.</p>)}

				{apiConfiguration && selectedProvider === "groq" && (
					<GroqProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}
				{apiConfiguration && selectedProvider === "baseten" && (
					<BasetenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}
				{apiConfiguration && selectedProvider === "litellm" && (
					<LiteLlmProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "lmstudio" && (
					<LMStudioProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "moonshot" && (
					<MoonshotProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "huggingface" && (
					<HuggingFaceProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "nebius" && (
					<NebiusProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "wandb" && (
					<WandbProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "xai" && (
					<XaiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "cerebras" && (
					<CerebrasProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "huawei-cloud-maas" && (
					<HuaweiCloudMaasProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "dify" && (
					<DifyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "zai" && (
					<ZAiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "minimax" && (
					<MinimaxProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "nousResearch" && (
					<NousResearchProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{apiConfiguration && selectedProvider === "aihubmix" && (
					<AIhubmixProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
				)}

				{intent === "setup" && activeProvider && activeProvider !== "openai" && !isEditingSetup && !isProviderAdded && (
					<div className="mt-3 flex flex-col items-start gap-2">
						<Button type="button" disabled={isAddingProvider} onClick={() => void addProvider()}>
							{isAddingProvider ? "Adding provider…" : "Add provider"}
						</Button>
						<p className="m-0 text-xs text-description">You can also add a provider without saved credentials, such as a local service. Adding it does not verify connectivity.</p>
					</div>
				)}

				{apiConfigurationError && (
					<p aria-live="polite" className="m-0 text-xs text-error">
						Could not save API configuration: {apiConfigurationError}
					</p>
				)}

				{apiErrorMessage && (
					<p
						style={{
							margin: "-10px 0 4px 0",
							fontSize: 12,
							color: "var(--vscode-errorForeground)",
						}}>
						{apiErrorMessage}
					</p>
				)}
				{modelIdErrorMessage && (
					<p
						style={{
							margin: "-10px 0 4px 0",
							fontSize: 12,
							color: "var(--vscode-errorForeground)",
						}}>
						{modelIdErrorMessage}
					</p>
				)}
			</div>
		</ProviderSetupContext.Provider>
	)
}

export default ApiOptions

const ProviderDropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

const ProviderDropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	z-index: ${DROPDOWN_Z_INDEX - 1};
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const ProviderDropdownItem = styled.div<{ $isSelected: boolean }>`
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ $isSelected }) => ($isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
	}
`
