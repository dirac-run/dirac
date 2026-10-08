import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { ModelProviderPreset, ModelProviderSelection } from "@shared/api"
import { getAutoCondenseContextLimit } from "@shared/context-management"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { getProviderModelIdKey, isSettingsKey, type UtilityModelUseCases } from "@shared/storage"
import type { OpenaiReasoningEffort } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { normalizeUserApprovedCommands, type UserApprovedCommand } from "@shared/UserApprovedCommand"
import { Box, Text, useInput } from "ink"
import React, { useCallback, useMemo, useState } from "react"
import { StateManager } from "@/core/storage/StateManager"
import { signOutUnbiasedKey } from "@/core/controller/models/signOutUnbiased"
import { getUnbiasedOAuthWorkloadName } from "@/integrations/unbiased/oauth-account"
import type { TaskWorkingConfigurationPatch } from "@/core/task/runtime/TaskWorkingConfiguration"
import { ToolRegistry } from "@/core/task/tools/registry/ToolRegistry"
import { Logger } from "@/shared/services/Logger"
import { TerminalColorMode, terminalColorMode, theme } from "../../constants/theme"
import { useStdinContext } from "../../context/StdinContext"
import { useTerminalSize } from "../../hooks/useTerminalSize"
import { OpenAiCodexAuthView } from "../OpenAiCodexAuthView"
import { UnbiasedAuthView } from "../UnbiasedAuthView"
import { shouldIgnoreTerminalInput } from "../../utils/input"
import { usesOpenRouterModels } from "../../utils/openrouter-models"
import type { ObjectEditorState } from "../ConfigViewComponents"
import { Panel } from "../Panel"
import { CLI_SETTINGS_DESTINATIONS, FEATURE_SETTINGS, type FeatureKey } from "./constants"
import { useAuthStatus } from "./hooks/useAuthStatus"
import { useSettingsActions } from "./hooks/useSettingsActions"
import { createSettingsSearchResults, useSettingsItems, type UseSettingsItemsProps } from "./hooks/useSettingsItems"
import { getFirstSelectableSettingsIndex, isSelectableSettingsItem } from "./navigation"
import { SettingsHomeView } from "./SettingsHomeView"
import { SettingsListView } from "./SettingsListView"
import { SettingsSearchView } from "./SettingsSearchView"
import { commitInteractiveSetting, persistInteractiveSettingWithRollback } from "./settingsTransaction"
import { GithubAuthPage } from "./subpages/AuthPages"
import { ApiKeyInputPage, EditValuePage, ObjectEditorPage } from "./subpages/EditPages"
import { OpenRouterRoutingPage } from "./subpages/OpenRouterRoutingPage"
import { LanguagePickerPage, ModelPickerPage, ProviderPickerPage, UtilityModelPresetPickerPage } from "./subpages/PickerPages"
import { BedrockCustomFlowPage, BedrockSetupPage } from "./subpages/SetupPages"
import {
	SettingsNavigationDirection,
	type ListItem,
	type SettingsPanelContentProps,
	type SettingsSearchResult,
	SettingsItemType,
	SettingsTab,
} from "./types"
import { UserApprovedCommandsPage } from "./UserApprovedCommandsPage"
import { normalizeReasoningEffort } from "./utils"
export const SettingsPanelContent: React.FC<SettingsPanelContentProps> = ({
	onClose,
	controller,
	initialMode,
	initialModelKey,
}) => {
	const { isRawModeSupported } = useStdinContext()
	const { rows: terminalRows } = useTerminalSize()
	const settingsMaxRows = Math.max(3, terminalRows - 8)
	const stateManager = StateManager.get()

	// UI state
	const [currentTab, setCurrentTab] = useState<SettingsTab>(SettingsTab.MODELS_API)
	const [isAtHome, setIsAtHome] = useState(!initialMode)
	const [homeSelectedIndex, setHomeSelectedIndex] = useState(0)
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [isSearching, setIsSearching] = useState(false)
	const [helpItem, setHelpItem] = useState<ListItem | null>(null)
	const [isEditingApprovedCommands, setIsEditingApprovedCommands] = useState(false)
	const [isEditing, setIsEditing] = useState(false)
	const [isPickingModel, setIsPickingModel] = useState(initialMode === "model-picker")
	const [pickingModelKey, setPickingModelKey] = useState<"actModelId" | "planModelId" | null>(
		initialMode ? (initialModelKey ?? "actModelId") : null,
	)
	const [isPickingProvider, setIsPickingProvider] = useState(initialMode === "provider-picker")
	const [isPickingLanguage, setIsPickingLanguage] = useState(false)
	const [isPickingUtilityModel, setIsPickingUtilityModel] = useState(false)
	const [isEnteringApiKey, setIsEnteringApiKey] = useState(false)
	const [pendingProvider, setPendingProvider] = useState<string | null>(null)
	const [isConfiguringBedrock, setIsConfiguringBedrock] = useState(false)
	const [isWaitingForCodexAuth, setIsWaitingForCodexAuth] = useState(false)
	const [isWaitingForUnbiasedAuth, setIsWaitingForUnbiasedAuth] = useState(false)
	const [isWaitingForGithubAuth, setIsWaitingForGithubAuth] = useState(false)
	const [githubAuthData, setGithubAuthData] = useState<any>(null)
	const [apiKeyValue, setApiKeyValue] = useState("")
	const [editValue, setEditValue] = useState("")
	const [isBedrockCustomFlow, setIsBedrockCustomFlow] = useState(false)
	const [objectEditor, setObjectEditor] = useState<ObjectEditorState | null>(null)
	const [openRouterRoutingModelId, setOpenRouterRoutingModelId] = useState<string | null>(null)
	const [settingsError, setSettingsError] = useState<string | null>(null)
	const [isApplyingSetting, setIsApplyingSetting] = useState(false)
	const actionInProgressRef = React.useRef(false)

	const runSettingsAction = useCallback(async (context: string, action: () => void | Promise<void>): Promise<boolean> => {
		if (actionInProgressRef.current) return false
		actionInProgressRef.current = true
		setIsApplyingSetting(true)
		setSettingsError(null)
		try {
			await action()
			return true
		} catch (error) {
			Logger.error(`Settings ${context} failed:`, error)
			setSettingsError(error instanceof Error ? error.message : String(error))
			return false
		} finally {
			actionInProgressRef.current = false
			setIsApplyingSetting(false)
		}
	}, [])

	// Tool toggle state
	const [availableTools] = useState<ToolMetadata[]>(() => {
		const registry = ToolRegistry.getInstance()
		return registry.getConfigurableTools(controller?.task?.taskId).map((t) => ({
			id: t.id,
			name: t.name,
			description: t.spec.description,
			source: t.source,
			modulePath: t.modulePath,
		}))
	})
	const [toolToggles, setToolToggles] = useState<Record<string, boolean>>(() => ToolRegistry.getInstance().getToggles())

	// Settings state
	const [features, setFeatures] = useState<Record<FeatureKey, boolean>>(() => {
		const initial: Record<string, boolean> = {}
		for (const [key, config] of Object.entries(FEATURE_SETTINGS)) {
			if (isSettingsKey(config.stateKey)) {
				initial[key] = stateManager.getGlobalSettingsKey(config.stateKey)
			} else {
				initial[key] = stateManager.getGlobalStateKey(config.stateKey)
			}
		}
		return initial as Record<FeatureKey, boolean>
	})
	const [utilityModelUseCases, setUtilityModelUseCases] = useState<UtilityModelUseCases>(() => ({
		condense: stateManager.getGlobalSettingsKey("utilityModelUseCondense"),
		newTask: stateManager.getGlobalSettingsKey("utilityModelUseNewTask"),
		generateCommitMessage: stateManager.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage"),
		permissionHandling: stateManager.getGlobalSettingsKey("utilityModelUsePermissionHandling"),
	}))
	const [utilityModelSelection, setUtilityModelSelection] = useState<ModelProviderSelection | undefined>(() =>
		stateManager.getGlobalSettingsKey("utilityModelSelection"),
	)
	const [utilityPermissionPolicy, setUtilityPermissionPolicy] = useState<string>(() =>
		stateManager.getGlobalSettingsKey("utilityModelPermissionPolicy"),
	)
	const [modelProviderPresets] = useState<ModelProviderPreset[]>(
		() => stateManager.getGlobalSettingsKey("modelProviderPresets") ?? [],
	)

	const [lightTerminalTheme, setLightTerminalTheme] = useState<boolean>(() => {
		const savedPreference = stateManager.getGlobalSettingsKey("cliTerminalColorMode")
		return savedPreference ? savedPreference === "light" : terminalColorMode === TerminalColorMode.LIGHT
	})
	const [separateModels, setSeparateModels] = useState<boolean>(
		() => stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ?? false,
	)
	const [actThinkingEnabled, setActThinkingEnabled] = useState<boolean>(
		() => (stateManager.getGlobalSettingsKey("actModeThinkingBudgetTokens") ?? 0) > 0,
	)
	const [planThinkingEnabled, setPlanThinkingEnabled] = useState<boolean>(
		() => (stateManager.getGlobalSettingsKey("planModeThinkingBudgetTokens") ?? 0) > 0,
	)
	const [actReasoningEffort, setActReasoningEffort] = useState<OpenaiReasoningEffort>(() =>
		normalizeReasoningEffort(stateManager.getGlobalSettingsKey("actModeReasoningEffort")),
	)
	const [planReasoningEffort, setPlanReasoningEffort] = useState<OpenaiReasoningEffort>(() =>
		normalizeReasoningEffort(stateManager.getGlobalSettingsKey("planModeReasoningEffort")),
	)
	const [autoApproveSettings, setAutoApproveSettings] = useState<AutoApprovalSettings>(() => {
		return stateManager.getGlobalSettingsKey("autoApprovalSettings") ?? DEFAULT_AUTO_APPROVAL_SETTINGS
	})
	const [autoApproveAllToggled, setAutoApproveAllToggled] = useState<boolean>(
		() => stateManager.getGlobalSettingsKey("autoApproveAllToggled") ?? false,
	)
	const [userApprovedCommands, setUserApprovedCommands] = useState<UserApprovedCommand[]>(() =>
		stateManager.getGlobalSettingsKey("userApprovedCommands"),
	)
	const [preferredLanguage, setPreferredLanguage] = useState<string>(
		() => stateManager.getGlobalSettingsKey("preferredLanguage") || "English",
	)
	const [telemetry, setTelemetry] = useState<TelemetrySetting>(
		() => stateManager.getGlobalSettingsKey("telemetrySetting") || "unset",
	)
	const [provider, setProvider] = useState<string>(
		() =>
			stateManager.getApiConfiguration().actModeApiProvider ||
			stateManager.getApiConfiguration().planModeApiProvider ||
			"not configured",
	)
	const [openAiHeaders, setOpenAiHeaders] = useState<Record<string, string>>(
		() => stateManager.getGlobalSettingsKey("openAiHeaders") ?? {},
	)
	const [autoCondenseContextLimit, setAutoCondenseContextLimit] = useState(() =>
		getAutoCondenseContextLimit(stateManager.getGlobalSettingsKey("autoCondenseContextLimits"), provider),
	)
	React.useEffect(() => {
		setAutoCondenseContextLimit(
			getAutoCondenseContextLimit(stateManager.getGlobalSettingsKey("autoCondenseContextLimits"), provider),
		)
	}, [provider, stateManager])
	const [openRouterPinnedProviders, setOpenRouterPinnedProviders] = useState<Record<string, string[]>>(
		() => stateManager.getGlobalSettingsKey("openRouterPinnedProviders") ?? {},
	)
	const [openRouterProviderSorting, setOpenRouterProviderSorting] = useState<string | undefined>(() =>
		stateManager.getGlobalSettingsKey("openRouterProviderSorting"),
	)
	const [openRouterPreventFallbacks, setOpenRouterPreventFallbacks] = useState(
		() => stateManager.getGlobalSettingsKey("openRouterPreventFallbacks") ?? false,
	)

	const [modelRefreshKey, setModelRefreshKey] = useState(0)
	const [openRouterModels, setOpenRouterModels] = useState<string[]>([])
	React.useEffect(() => {
		if (!usesOpenRouterModels(provider) || !controller) {
			setOpenRouterModels([])
			return
		}
		let cancelled = false
		controller
			.readOpenRouterModels()
			.then((models) => {
				if (!cancelled) setOpenRouterModels(models ? Object.keys(models) : [])
			})
			.catch((error) => {
				Logger.error("Failed to load OpenRouter models for settings:", error)
				if (!cancelled) {
					setOpenRouterModels([])
					setSettingsError(error instanceof Error ? error.message : String(error))
				}
			})
		return () => {
			cancelled = true
		}
	}, [provider, controller, modelRefreshKey])
	const refreshModelIds = useCallback(() => setModelRefreshKey((k) => k + 1), [])

	const { actModelId, planModelId } = useMemo(() => {
		const apiConfig = stateManager.getApiConfiguration()
		const actProvider = apiConfig.actModeApiProvider
		const planProvider = apiConfig.planModeApiProvider || actProvider
		if (!actProvider && !planProvider) {
			return { actModelId: "", planModelId: "" }
		}
		const actKey = actProvider ? getProviderModelIdKey(actProvider, "act") : null
		const planKey = planProvider ? getProviderModelIdKey(planProvider, "plan") : null
		return {
			actModelId: actKey ? (stateManager.getGlobalSettingsKey(actKey) as string) || "" : "",
			planModelId: planKey ? (stateManager.getGlobalSettingsKey(planKey) as string) || "" : "",
		}
	}, [modelRefreshKey, stateManager])

	const rebuildTaskApi = useCallback(
		async (patch: TaskWorkingConfigurationPatch, persist: () => void | Promise<void>) => {
			await commitInteractiveSetting(controller, patch, persist)
		},
		[controller],
	)

	const { openAiCodexIsAuthenticated, openAiCodexEmail, githubIsAuthenticated, githubEmail, authStatusError } = useAuthStatus(
		provider,
		isWaitingForCodexAuth,
		isWaitingForGithubAuth,
	)

	const settingsItemsProps: UseSettingsItemsProps = {
		currentTab,
		provider,
		actModelId,
		planModelId,
		separateModels,
		actThinkingEnabled,
		planThinkingEnabled,
		actReasoningEffort,
		planReasoningEffort,
		autoApproveSettings,
		autoApproveAllToggled,
		features,
		utilityModelUseCases,
		utilityModelSelection,
		utilityPermissionPolicy,
		lightTerminalTheme,
		preferredLanguage,
		telemetry,
		openAiHeaders,
		autoCondenseContextLimit,
		openAiCodexIsAuthenticated,
		unbiasedIsAuthenticated: !!stateManager.getApiConfiguration().unbiasedApiKey,
		unbiasedWorkloadName: getUnbiasedOAuthWorkloadName(stateManager),
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		openRouterModels,
		openRouterPinnedProviders,
		openRouterProviderSorting,
		openRouterPreventFallbacks,
		availableTools,
		toolToggles,
	}
	const items = useSettingsItems(settingsItemsProps)
	const settingsSearchResults = createSettingsSearchResults(
		settingsItemsProps,
		CLI_SETTINGS_DESTINATIONS.map((destination) => destination.key),
	)

	React.useEffect(() => {
		setSelectedIndex((currentIndex) =>
			isSelectableSettingsItem(items[currentIndex]) ? currentIndex : getFirstSelectableSettingsIndex(items),
		)
	}, [items])

	const {
		handleAction,
		handleSave,
		handleProviderSelect,
		handleModelSelect,
		handleApiKeySubmit,
		handleBedrockComplete,
		handleBedrockCustomFlowComplete,
		handleLanguageSelect,
		handleUtilityModelPresetSelect,
		completeCodexAuth,
		cancelGithubAuth,
		navigateItems,
	} = useSettingsActions({
		items,
		selectedIndex,
		setSelectedIndex,
		provider,
		setProvider,
		actModelId,
		planModelId,
		openRouterProviderSorting,
		setOpenRouterProviderSorting,
		setOpenRouterPreventFallbacks,
		setOpenRouterRoutingModelId,
		actReasoningEffort,
		setActReasoningEffort,
		planReasoningEffort,
		setPlanReasoningEffort,
		separateModels,
		setSeparateModels,
		actThinkingEnabled,
		setActThinkingEnabled,
		planThinkingEnabled,
		setPlanThinkingEnabled,
		autoApproveSettings,
		setAutoApproveSettings,
		autoApproveAllToggled,
		setAutoApproveAllToggled,
		features,
		utilityModelUseCases,
		setUtilityModelUseCases,
		setUtilityPermissionPolicy,
		setFeatures,
		setLightTerminalTheme,
		preferredLanguage,
		setPreferredLanguage,
		telemetry,
		setTelemetry,
		openAiHeaders,
		setOpenAiHeaders,
		setAutoCondenseContextLimit,
		setIsPickingProvider,
		setIsPickingModel,
		pickingModelKey,
		setPickingModelKey,
		setIsPickingLanguage,
		setIsPickingUtilityModel,
		setUtilityModelSelection,
		setIsEnteringApiKey,
		pendingProvider,
		setPendingProvider,
		setApiKeyValue,
		setIsEditing,
		setEditValue,
		setObjectEditor,
		setIsWaitingForCodexAuth,
		setIsWaitingForGithubAuth,
		setGithubAuthData,
		setIsBedrockCustomFlow,
		setIsConfiguringBedrock,
		controller,
		stateManager,
		rebuildTaskApi,
		refreshModelIds,
		onClose,
		initialMode,
		availableTools,
		setToolToggles,
	})

	const updateUserApprovedCommands = useCallback(
		(commands: UserApprovedCommand[]) =>
			runSettingsAction("approved command update", async () => {
				const normalizedCommands = normalizeUserApprovedCommands(commands)
				const previousCommands = structuredClone(stateManager.getGlobalSettingsKey("userApprovedCommands"))
				await commitInteractiveSetting(controller, { settings: { userApprovedCommands: normalizedCommands } }, () =>
					persistInteractiveSettingWithRollback(
						async () => {
							stateManager.setGlobalState("userApprovedCommands", normalizedCommands)
							await stateManager.flushPendingState()
						},
						async () => {
							stateManager.setGlobalState("userApprovedCommands", previousCommands)
							await stateManager.flushPendingState()
						},
					),
				)
				setUserApprovedCommands(normalizedCommands)
			}),
		[controller, runSettingsAction, stateManager],
	)
	const openDestination = useCallback((destination: SettingsTab, itemIndex = 0) => {
		setSettingsError(null)
		setCurrentTab(destination)
		setIsAtHome(false)
		setSelectedIndex(itemIndex)
		setIsEditing(false)
		setIsPickingModel(false)
		setPickingModelKey(null)
		setIsPickingProvider(false)
		setIsPickingLanguage(false)
		setIsPickingUtilityModel(false)
		setIsEnteringApiKey(false)
		setPendingProvider(null)
		setApiKeyValue("")
		setOpenRouterRoutingModelId(null)
		setIsEditingApprovedCommands(false)
		setHelpItem(null)
	}, [])

	const returnHome = useCallback(() => {
		setIsAtHome(true)
		setIsEditingApprovedCommands(false)
		setHelpItem(null)
		setSelectedIndex(0)
		const destinationIndex = CLI_SETTINGS_DESTINATIONS.findIndex((destination) => destination.key === currentTab)
		setHomeSelectedIndex(Math.max(0, destinationIndex))
	}, [currentTab])

	const activateSettingsItem = useCallback(() => {
		const item = items[selectedIndex]
		if (!item) return
		if (item.key === "approvedCommandRules") {
			setIsEditingApprovedCommands(true)
			return
		}
		if (item.key === "utilityApprovalsStatus") {
			openDestination(SettingsTab.UTILITY_MODEL)
			return
		}
		if (item.key === "advancedConfiguration") {
			setHelpItem(item)
			return
		}
		if (item.key === "unbiasedSignIn") {
			setIsWaitingForUnbiasedAuth(true)
			return
		}
		if (item.key === "unbiasedSignOut") {
			void runSettingsAction("Unbiased sign-out", async () => {
				await signOutUnbiasedKey(stateManager, controller?.task)
				await controller?.postStateToWebview()
				refreshModelIds()
			})
			return
		}
		void runSettingsAction("update", handleAction)
	}, [handleAction, items, openDestination, runSettingsAction, selectedIndex, stateManager, controller, refreshModelIds])

	const selectSearchResult = useCallback(
		(result: SettingsSearchResult) => {
			setIsSearching(false)
			openDestination(result.destination, result.itemIndex)
		},
		[openDestination],
	)
	const showSearchResultHelp = useCallback((result: SettingsSearchResult) => {
		setHelpItem(result.item)
	}, [])

	useInput(
		(input, key) => {
			if (objectEditor || openRouterRoutingModelId || isEditingApprovedCommands || isSearching) return
			if (shouldIgnoreTerminalInput(input, key)) return
			if (helpItem) {
				if (key.escape || input === "?") setHelpItem(null)
				return
			}

			if (isPickingProvider) {
				if (key.escape) {
					setIsPickingProvider(false)
					if (initialMode) onClose()
				}
				return
			}
			if (isPickingModel) {
				if (key.escape) {
					setIsPickingModel(false)
					setPickingModelKey(null)
					setPendingProvider(null)
					if (initialMode) onClose()
				}
				return
			}
			if (isPickingUtilityModel) {
				if (key.escape) setIsPickingUtilityModel(false)
				return
			}
			if (isPickingLanguage) {
				if (key.escape) setIsPickingLanguage(false)
				return
			}
			if (isWaitingForCodexAuth) return
			if (isWaitingForUnbiasedAuth) return
			if (isWaitingForGithubAuth) {
				if (key.escape) cancelGithubAuth()
				return
			}
			if (isBedrockCustomFlow) return
			if (isEditing) {
				if (key.escape) setIsEditing(false)
				else if (key.return) void runSettingsAction("save", () => handleSave(editValue))
				else if (key.backspace || key.delete) setEditValue((previous) => previous.slice(0, -1))
				else if (input && !key.ctrl && !key.meta) setEditValue((previous) => previous + input)
				return
			}

			if (key.escape) {
				if (isAtHome) onClose()
				else returnHome()
				return
			}
			if (input === "/") {
				setIsSearching(true)
				return
			}
			if (isAtHome) {
				if (key.upArrow) setHomeSelectedIndex((current) => Math.max(0, current - 1))
				else if (key.downArrow)
					setHomeSelectedIndex((current) => Math.min(CLI_SETTINGS_DESTINATIONS.length - 1, current + 1))
				else if (key.return) {
					const destination = CLI_SETTINGS_DESTINATIONS[homeSelectedIndex]
					if (destination) openDestination(destination.key)
				} else if (/^[1-9]$/.test(input)) {
					const destination = CLI_SETTINGS_DESTINATIONS[Number(input) - 1]
					if (destination) openDestination(destination.key)
				}
				return
			}
			if (key.upArrow) navigateItems(SettingsNavigationDirection.UP)
			else if (key.downArrow) navigateItems(SettingsNavigationDirection.DOWN)
			else if (input === "?") {
				const item = items[selectedIndex]
				if (item) setHelpItem(item)
			} else if (key.return || key.tab) activateSettingsItem()
			else if (input === " " && items[selectedIndex]?.type === SettingsItemType.CHECKBOX) activateSettingsItem()
		},
		{
			isActive: isRawModeSupported && !isEnteringApiKey && !isConfiguringBedrock,
		},
	)

	const renderContent = () => {
		if (isSearching) {
			return (
				<SettingsSearchView
					helpItem={helpItem}
					isActive={isRawModeSupported}
					maxRows={settingsMaxRows}
					onCancel={() => {
						setIsSearching(false)
						setHelpItem(null)
					}}
					onCloseHelp={() => setHelpItem(null)}
					onHelp={showSearchResultHelp}
					onSelect={selectSearchResult}
					results={settingsSearchResults}
				/>
			)
		}
		if (helpItem) {
			return (
				<Box flexDirection="column">
					<Text bold color={theme.strongText}>
						{helpItem.label || "Setting help"}
					</Text>
					{helpItem.description && <Text color={theme.text}>{helpItem.description}</Text>}
					{helpItem.value !== "" && !helpItem.description && <Text color={theme.text}>{String(helpItem.value)}</Text>}
					{helpItem.expandedHelp && <Text color={theme.muted}>{helpItem.expandedHelp}</Text>}
					{helpItem.persistentHelp && (
						<Text color={helpItem.helpTone === "error" ? theme.error : theme.warning}>{helpItem.persistentHelp}</Text>
					)}
				</Box>
			)
		}
		if (isAtHome)
			return (
				<SettingsHomeView
					destinations={CLI_SETTINGS_DESTINATIONS}
					maxRows={settingsMaxRows}
					selectedIndex={homeSelectedIndex}
				/>
			)
		if (isEditingApprovedCommands) {
			return (
				<UserApprovedCommandsPage
					commands={userApprovedCommands}
					isActive={isRawModeSupported && !isApplyingSetting}
					maxRows={settingsMaxRows}
					onChange={updateUserApprovedCommands}
					onClose={() => setIsEditingApprovedCommands(false)}
				/>
			)
		}
		if (openRouterRoutingModelId) {
			return (
				<OpenRouterRoutingPage
					isActive={!isApplyingSetting}
					modelId={openRouterRoutingModelId}
					onCancel={() => setOpenRouterRoutingModelId(null)}
					onSave={(providers) => {
						const nextPinnedProviders = { ...openRouterPinnedProviders }
						if (providers.length > 0) nextPinnedProviders[openRouterRoutingModelId] = providers
						else delete nextPinnedProviders[openRouterRoutingModelId]
						const persistedValue = Object.keys(nextPinnedProviders).length > 0 ? nextPinnedProviders : undefined
						runSettingsAction("routing update", async () => {
							await rebuildTaskApi({ settings: { openRouterPinnedProviders: persistedValue } }, () =>
								stateManager.setGlobalState("openRouterPinnedProviders", persistedValue),
							)
							setOpenRouterPinnedProviders(nextPinnedProviders)
							setOpenRouterRoutingModelId(null)
						})
					}}
					savedProviders={openRouterPinnedProviders[openRouterRoutingModelId] || []}
				/>
			)
		}
		if (isPickingProvider) {
			return (
				<ProviderPickerPage
					isActive={isPickingProvider && !isApplyingSetting}
					onSelect={(providerId) => runSettingsAction("provider update", () => handleProviderSelect(providerId))}
				/>
			)
		}
		if (isEnteringApiKey && pendingProvider) {
			return (
				<ApiKeyInputPage
					apiKeyValue={apiKeyValue}
					isActive={isEnteringApiKey && !isApplyingSetting}
					onCancel={() => {
						setIsEnteringApiKey(false)
						setPendingProvider(null)
						setApiKeyValue("")
					}}
					onChange={setApiKeyValue}
					onSubmit={(value) => runSettingsAction("API key update", () => handleApiKeySubmit(value))}
					pendingProvider={pendingProvider}
				/>
			)
		}
		if (isConfiguringBedrock) {
			return (
				<BedrockSetupPage
					isActive={isConfiguringBedrock && !isApplyingSetting}
					onCancel={() => {
						setIsConfiguringBedrock(false)
						setPendingProvider(null)
					}}
					onComplete={(config) => runSettingsAction("Bedrock setup", () => handleBedrockComplete(config))}
				/>
			)
		}
		if (isWaitingForUnbiasedAuth) return (
			<UnbiasedAuthView controller={controller} onCancel={() => setIsWaitingForUnbiasedAuth(false)} onComplete={() => {
				setProvider("unbiased")
				refreshModelIds()
				setIsWaitingForUnbiasedAuth(false)
			}} />
		)
		if (isWaitingForCodexAuth) return (
			<OpenAiCodexAuthView onCancel={() => setIsWaitingForCodexAuth(false)} onComplete={completeCodexAuth} />
		)
		if (isWaitingForGithubAuth && githubAuthData) return <GithubAuthPage githubAuthData={githubAuthData} />
		if (isPickingModel && pickingModelKey) {
			const apiConfiguration = controller?.task?.getWorkingConfiguration().apiConfiguration ?? stateManager.getApiConfiguration()
			const selectedProvider = pickingModelKey === "actModelId"
				? apiConfiguration.actModeApiProvider
				: apiConfiguration.planModeApiProvider || apiConfiguration.actModeApiProvider
			const label = pickingModelKey === "actModelId" ? "Model ID (Act)" : "Model ID (Plan)"
			return (
				<ModelPickerPage
					controller={controller}
					isActive={isPickingModel && !isApplyingSetting}
					label={label}
					onSelect={(modelId) => runSettingsAction("model update", () => handleModelSelect(modelId))}
					provider={pendingProvider || selectedProvider || provider}
				/>
			)
		}
		if (isPickingUtilityModel) {
			return (
				<UtilityModelPresetPickerPage
					isActive={isPickingUtilityModel && !isApplyingSetting}
					onSelect={(preset) =>
						runSettingsAction("utility model selection", () => handleUtilityModelPresetSelect(preset))
					}
					presets={modelProviderPresets}
				/>
			)
		}
		if (isPickingLanguage) {
			return (
				<LanguagePickerPage
					isActive={isPickingLanguage && !isApplyingSetting}
					onSelect={(language) => runSettingsAction("language update", () => handleLanguageSelect(language))}
				/>
			)
		}
		if (isBedrockCustomFlow) {
			return (
				<BedrockCustomFlowPage
					isActive={isBedrockCustomFlow && !isApplyingSetting}
					onCancel={() => {
						setIsBedrockCustomFlow(false)
						setIsPickingModel(true)
					}}
					onComplete={(arn, modelId) =>
						runSettingsAction("custom Bedrock model update", () => handleBedrockCustomFlowComplete(arn, modelId))
					}
				/>
			)
		}
		if (isEditing) {
			const item = items[selectedIndex]
			return <EditValuePage label={item?.label} value={editValue} />
		}
		if (objectEditor) {
			return (
				<ObjectEditorPage
					objectEditor={objectEditor}
					onPersist={(nextObject) => {
						if (objectEditor.key === "openAiHeaders") {
							const headers = nextObject as Record<string, string>
							runSettingsAction("custom header update", async () => {
								await rebuildTaskApi({ settings: { openAiHeaders: headers } }, () =>
									stateManager.setGlobalState("openAiHeaders", headers),
								)
								setOpenAiHeaders(headers)
							})
						}
					}}
					setObjectEditor={setObjectEditor}
				/>
			)
		}

		return <SettingsListView items={items} maxRows={settingsMaxRows} selectedIndex={selectedIndex} />
	}

	const hasNestedPage =
		isPickingProvider ||
		isPickingModel ||
		isPickingLanguage ||
		isPickingUtilityModel ||
		isEnteringApiKey ||
		isConfiguringBedrock ||
		isWaitingForCodexAuth ||
		isWaitingForUnbiasedAuth ||
		isBedrockCustomFlow ||
		isWaitingForGithubAuth ||
		isEditing ||
		isEditingApprovedCommands ||
		isSearching ||
		!!helpItem ||
		!!objectEditor ||
		!!openRouterRoutingModelId
	const activeDestination = CLI_SETTINGS_DESTINATIONS.find((destination) => destination.key === currentTab)
	const panelLabel = isSearching ? "Settings / Search" : isAtHome ? "Settings" : `Settings / ${activeDestination?.label ?? ""}`
	const footer = isSearching
		? helpItem
			? "? or Esc Back to search"
			: "Type to search · ↑/↓ Navigate · Enter Open · ? Help · Esc Back"
		: helpItem
			? "? or Esc Back"
			: isAtHome
				? "/ Search settings · ↑/↓ Navigate · Enter Open · Esc Close"
				: isEditingApprovedCommands
					? "↑/↓ Select · Enter Edit · a Add · d Delete · Esc Back"
					: "↑/↓ Navigate · Enter Edit · Space Toggle · / Search · ? Help · Esc Back"

	return (
		<Panel footer={footer} isSubpage={hasNestedPage || !isAtHome} label={panelLabel}>
			{(settingsError || authStatusError) && (
				<Text color={theme.error}>Settings error: {settingsError || authStatusError}</Text>
			)}
			{isApplyingSetting && <Text color={theme.muted}>Applying change…</Text>}
			{renderContent()}
		</Panel>
	)
}
