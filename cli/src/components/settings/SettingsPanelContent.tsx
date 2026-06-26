import React, { useCallback, useMemo, useState } from "react"
import { useInput } from "ink"
import { StateManager } from "@/core/storage/StateManager"
import { buildApiHandler } from "@/core/api"
import { getProviderModelIdKey, isSettingsKey } from "@shared/storage"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { useStdinContext } from "../../context/StdinContext"
import { isMouseEscapeSequence } from "../../utils/input"
import { copyToClipboardNative } from "../../utils/clipboard"
import { Panel } from "../Panel"
import { TABS, FEATURE_SETTINGS, type FeatureKey } from "./constants"
import { normalizeReasoningEffort } from "./utils"
import { usesOpenRouterModels } from "../../utils/openrouter-models"
import { useAuthStatus } from "./hooks/useAuthStatus"
import { useSettingsItems } from "./hooks/useSettingsItems"
import { useSettingsActions } from "./hooks/useSettingsActions"
import { SettingsListView } from "./SettingsListView"
import { ProviderPickerPage, ModelPickerPage, LanguagePickerPage } from "./subpages/PickerPages"
import { ApiKeyInputPage, EditValuePage, ObjectEditorPage } from "./subpages/EditPages"
import { BedrockSetupPage, BedrockCustomFlowPage } from "./subpages/SetupPages"
import { CodexAuthPage, GithubAuthPage, AuthErrorPage } from "./subpages/AuthPages"
import type { SettingsPanelContentProps, SettingsTab } from "./types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { OpenaiReasoningEffort } from "@shared/storage/types"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { ObjectEditorState } from "../ConfigViewComponents"

import { ToolRegistry } from "@/core/task/tools/registry/ToolRegistry"
import type { ToolMetadata } from "@shared/ExtensionMessage"
export const SettingsPanelContent: React.FC<SettingsPanelContentProps> = ({
	onClose,
	controller,
	initialMode,
	initialModelKey,
}) => {
	const { isRawModeSupported } = useStdinContext()
	const stateManager = StateManager.get()

	// UI state
	const [currentTab, setCurrentTab] = useState<SettingsTab>("api")
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [isEditing, setIsEditing] = useState(false)
	const [isPickingModel, setIsPickingModel] = useState(initialMode === "model-picker")
	const [pickingModelKey, setPickingModelKey] = useState<"actModelId" | "planModelId" | null>(
		initialMode ? (initialModelKey ?? "actModelId") : null,
	)
	const [isPickingProvider, setIsPickingProvider] = useState(initialMode === "provider-picker")
	const [isPickingLanguage, setIsPickingLanguage] = useState(false)
	const [isEnteringApiKey, setIsEnteringApiKey] = useState(false)
	const [pendingProvider, setPendingProvider] = useState<string | null>(null)
	const [isConfiguringBedrock, setIsConfiguringBedrock] = useState(false)
	const [isWaitingForCodexAuth, setIsWaitingForCodexAuth] = useState(false)
	const [isWaitingForGithubAuth, setIsWaitingForGithubAuth] = useState(false)
	const [githubAuthData, setGithubAuthData] = useState<any>(null)
	const [codexAuthUrl, setCodexAuthUrl] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [codexAuthError, setCodexAuthError] = useState<string | null>(null)
	const [apiKeyValue, setApiKeyValue] = useState("")
	const [editValue, setEditValue] = useState("")
	const [isBedrockCustomFlow, setIsBedrockCustomFlow] = useState(false)
	const [objectEditor, setObjectEditor] = useState<ObjectEditorState | null>(null)

	// Tool toggle state
	const [availableTools] = useState<ToolMetadata[]>(() => {
		const registry = ToolRegistry.getInstance()
		return registry.getAllTools().map((t) => ({
			id: t.id,
			name: t.name,
			description: t.spec.description,
			source: t.source,
			modulePath: t.modulePath,
		}))
	})
	const [toolToggles, setToolToggles] = useState<Record<string, boolean>>(
		() => stateManager.getGlobalSettingsKey("toolToggles") || {},
	)

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

	const [modelRefreshKey, setModelRefreshKey] = useState(0)
	const [openRouterModels, setOpenRouterModels] = useState<string[]>([])
	React.useEffect(() => {
		if (usesOpenRouterModels(provider)) {
			controller?.readOpenRouterModels().then((models) => {
				if (models) {
					setOpenRouterModels(Object.keys(models))
				}
			})
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

	const rebuildTaskApi = useCallback(async () => {
		const currentMode = stateManager.getGlobalSettingsKey("mode")
		const apiConfig = stateManager.getApiConfiguration()
		if (controller?.task) {
			controller.task.api = buildApiHandler({ ...apiConfig, ulid: controller.task.ulid }, currentMode)
		}
		await controller?.postStateToWebview()
	}, [controller, stateManager])

	const {
		openAiCodexIsAuthenticated,
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		setOpenAiCodexIsAuthenticated,
		setOpenAiCodexEmail,
		setGithubIsAuthenticated,
		setGithubEmail,
	} = useAuthStatus(provider, isWaitingForCodexAuth, isWaitingForGithubAuth)

	const items = useSettingsItems({
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
		features,
		preferredLanguage,
		telemetry,
		openAiHeaders,
		openAiCodexIsAuthenticated,
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		openRouterModels,
		availableTools,
		toolToggles,
	})

	const {
		handleAction,
		handleSave,
		handleProviderSelect,
		handleModelSelect,
		handleApiKeySubmit,
		handleBedrockComplete,
		handleBedrockCustomFlowComplete,
		handleLanguageSelect,
		startCodexAuth,
		startGithubAuth,
		navigateItems,
	} = useSettingsActions({
		items,
		selectedIndex,
		setSelectedIndex,
		currentTab,
		setCurrentTab,
		provider,
		setProvider,
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
		features,
		setFeatures,
		preferredLanguage,
		setPreferredLanguage,
		telemetry,
		setTelemetry,
		openAiHeaders,
		setOpenAiHeaders,
		setIsPickingProvider,
		setIsPickingModel,
		pickingModelKey,
		setPickingModelKey,
		setIsPickingLanguage,
		setIsEnteringApiKey,
		pendingProvider,
		setPendingProvider,
		setApiKeyValue,
		setIsEditing,
		setEditValue,
		setObjectEditor,
		setIsWaitingForCodexAuth,
		setIsWaitingForGithubAuth,
		setCodexAuthError,
		setCodexAuthUrl,
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

	const handleTabChange = useCallback((tabKey: string) => {
		setCurrentTab(tabKey as SettingsTab)
		setSelectedIndex(0)
		setIsEditing(false)
		setIsPickingModel(false)
		setPickingModelKey(null)
		setIsPickingProvider(false)
		setIsPickingLanguage(false)
		setIsEnteringApiKey(false)
		setPendingProvider(null)
		setApiKeyValue("")
	}, [])

	const navigateTabs = useCallback(
		(direction: "left" | "right") => {
			const tabKeys = TABS.map((t) => t.key)
			const currentIdx = tabKeys.indexOf(currentTab)
			const newIdx =
				direction === "left"
					? currentIdx > 0
						? currentIdx - 1
						: tabKeys.length - 1
					: currentIdx < tabKeys.length - 1
						? currentIdx + 1
						: 0
			handleTabChange(tabKeys[newIdx])
		},
		[currentTab, handleTabChange],
	)

	useInput(
		(input, key) => {
			if (objectEditor) return
			if (isMouseEscapeSequence(input)) return

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
					if (initialMode) onClose()
				}
				return
			}

			if (isPickingLanguage) {
				if (key.escape) setIsPickingLanguage(false)
				return
			}

			if (isWaitingForCodexAuth) {
				if (input === "c" && codexAuthUrl) {
					const ok = copyToClipboardNative(codexAuthUrl)
					if (ok) {
						setCopied(true)
						setTimeout(() => setCopied(false), 2000)
					}
					return
				}
				if (key.escape) {
					openAiCodexOAuthManager.cancelAuthorizationFlow()
					setIsWaitingForCodexAuth(false)
				}
				return
			}

			if (isWaitingForGithubAuth) {
				if (key.escape) {
					setIsWaitingForGithubAuth(false)
					setGithubAuthData(null)
				}
				return
			}

			if (codexAuthError) {
				setCodexAuthError(null)
				return
			}

			if (isBedrockCustomFlow) return

			if (isEditing) {
				if (key.escape) {
					setIsEditing(false)
					return
				}
				if (key.return) {
					handleSave(editValue)
					return
				}
				if (key.backspace || key.delete) {
					setEditValue((prev) => prev.slice(0, -1))
					return
				}
				if (input && !key.ctrl && !key.meta) {
					setEditValue((prev) => prev + input)
				}
				return
			}

			if (key.escape) {
				onClose()
				return
			}
			if (key.leftArrow) {
				navigateTabs("left")
				return
			}
			if (key.rightArrow) {
				navigateTabs("right")
				return
			}
			if (key.upArrow) {
				navigateItems("up")
				return
			}
			if (key.downArrow) {
				navigateItems("down")
				return
			}
			if (key.tab || key.return || input === " ") {
				handleAction()
				return
			}
		},
		{ isActive: isRawModeSupported && !isEnteringApiKey && !isConfiguringBedrock },
	)

	const renderContent = () => {
		if (isPickingProvider) {
			return <ProviderPickerPage isActive={isPickingProvider} onSelect={handleProviderSelect} />
		}
		if (isEnteringApiKey && pendingProvider) {
			return (
				<ApiKeyInputPage
					isActive={isEnteringApiKey}
					onCancel={() => {
						setIsEnteringApiKey(false)
						setPendingProvider(null)
						setApiKeyValue("")
					}}
					onChange={setApiKeyValue}
					onSubmit={handleApiKeySubmit}
					pendingProvider={pendingProvider}
					apiKeyValue={apiKeyValue}
				/>
			)
		}
		if (isConfiguringBedrock) {
			return (
				<BedrockSetupPage
					isActive={isConfiguringBedrock}
					onCancel={() => {
						setIsConfiguringBedrock(false)
						setPendingProvider(null)
					}}
					onComplete={handleBedrockComplete}
				/>
			)
		}
		if (isWaitingForCodexAuth) {
			return <CodexAuthPage codexAuthUrl={codexAuthUrl} copied={copied} />
		}
		if (isWaitingForGithubAuth && githubAuthData) {
			return <GithubAuthPage githubAuthData={githubAuthData} />
		}
		if (codexAuthError) {
			return <AuthErrorPage error={codexAuthError} />
		}
		if (isPickingModel && pickingModelKey) {
			const label = pickingModelKey === "actModelId" ? "Model ID (Act)" : "Model ID (Plan)"
			return (
				<ModelPickerPage
					controller={controller}
					isActive={isPickingModel}
					onSelect={handleModelSelect}
					provider={provider}
					label={label}
				/>
			)
		}
		if (isPickingLanguage) {
			return <LanguagePickerPage isActive={isPickingLanguage} onSelect={handleLanguageSelect} />
		}
		if (isBedrockCustomFlow) {
			return (
				<BedrockCustomFlowPage
					isActive={isBedrockCustomFlow}
					onCancel={() => {
						setIsBedrockCustomFlow(false)
						setIsPickingModel(true)
					}}
					onComplete={handleBedrockCustomFlowComplete}
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
					setObjectEditor={setObjectEditor}
					onPersist={(nextObject) => {
						if (objectEditor.key === "openAiHeaders") {
							const headers = nextObject as Record<string, string>
							setOpenAiHeaders(headers)
							stateManager.setGlobalState("openAiHeaders", headers)
							rebuildTaskApi()
						}
					}}
				/>
			)
		}

		return <SettingsListView items={items} selectedIndex={selectedIndex} />
	}

	const isSubpage =
		isPickingProvider ||
		isPickingModel ||
		isPickingLanguage ||
		isEnteringApiKey ||
		isConfiguringBedrock ||
		isWaitingForCodexAuth ||
		!!codexAuthError ||
		isBedrockCustomFlow ||
		isWaitingForGithubAuth ||
		isEditing

	return (
		<Panel currentTab={currentTab} isSubpage={isSubpage} label="Settings" tabs={TABS}>
			{renderContent()}
		</Panel>
	)
}
