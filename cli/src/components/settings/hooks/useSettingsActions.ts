import { useCallback } from "react"
import { StateManager } from "@/core/storage/StateManager"
import { getProviderModelIdKey, ProviderToApiKeyMap } from "@shared/storage"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { applyProviderConfig, applyBedrockConfig } from "../../../utils/provider-config"
import { normalizeReasoningEffort, nextReasoningEffort } from "../utils"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import { hasModelPicker, CUSTOM_MODEL_ID } from "../../ModelPicker"
import { usesOpenRouterModels } from "../../../utils/openrouter-models"
import { openExternal } from "@/utils/env"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "@/core/controller"
import type { ListItem, SettingsTab } from "../types"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { OpenaiReasoningEffort } from "@shared/storage/types"
import type { ApiProvider, ModelInfo } from "@shared/api"
import type { ObjectEditorState } from "../../ConfigViewComponents"
import type { BedrockConfig } from "../../BedrockSetup"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { ToolRegistry } from "@/core/task/tools/registry/ToolRegistry"

interface UseSettingsActionsProps {
    items: ListItem[]
    selectedIndex: number
    setSelectedIndex: (index: number | ((i: number) => number)) => void
    currentTab: SettingsTab
    setCurrentTab: (tab: SettingsTab) => void
    provider: string
    setProvider: (provider: string) => void
    actReasoningEffort: OpenaiReasoningEffort
    setActReasoningEffort: (effort: OpenaiReasoningEffort) => void
    planReasoningEffort: OpenaiReasoningEffort
    setPlanReasoningEffort: (effort: OpenaiReasoningEffort) => void
    separateModels: boolean
    setSeparateModels: (value: boolean) => void
    actThinkingEnabled: boolean
    setActThinkingEnabled: (value: boolean) => void
    planThinkingEnabled: boolean
    setPlanThinkingEnabled: (value: boolean) => void
    autoApproveSettings: AutoApprovalSettings
    setAutoApproveSettings: (settings: AutoApprovalSettings) => void
    features: Record<FeatureKey, boolean>
    setFeatures: (features: Record<FeatureKey, boolean> | ((prev: Record<FeatureKey, boolean>) => Record<FeatureKey, boolean>)) => void
    preferredLanguage: string
    setPreferredLanguage: (language: string) => void
    telemetry: TelemetrySetting
    setTelemetry: (telemetry: TelemetrySetting) => void
    openAiHeaders: Record<string, string>
    setOpenAiHeaders: (headers: Record<string, string>) => void
    setIsPickingProvider: (value: boolean) => void
    setIsPickingModel: (value: boolean) => void
    pickingModelKey: "actModelId" | "planModelId" | null
    setPickingModelKey: (key: "actModelId" | "planModelId" | null) => void
    setIsPickingLanguage: (value: boolean) => void
    setIsEnteringApiKey: (value: boolean) => void
    pendingProvider: string | null
    setPendingProvider: (provider: string | null) => void
    setApiKeyValue: (value: string) => void
    setIsEditing: (value: boolean) => void
    setEditValue: (value: string) => void
    setObjectEditor: (state: ObjectEditorState | null) => void
    setIsWaitingForCodexAuth: (value: boolean) => void
    setIsWaitingForGithubAuth: (value: boolean) => void
    setCodexAuthError: (error: string | null) => void
    setCodexAuthUrl: (url: string | null) => void
    setGithubAuthData: (data: any) => void
    setIsBedrockCustomFlow: (value: boolean) => void
    setIsConfiguringBedrock: (value: boolean) => void
    controller?: Controller
    stateManager: StateManager
    rebuildTaskApi: () => void
    refreshModelIds: () => void
    onClose: () => void
    initialMode?: string
    availableTools: ToolMetadata[]
    setToolToggles: (toggles: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void

}

export function useSettingsActions({
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
}: UseSettingsActionsProps) {
    const toggleFeature = useCallback(
        (key: FeatureKey) => {
            const config = FEATURE_SETTINGS[key]
            const newValue = !features[key]
            setFeatures((prev) => ({ ...prev, [key]: newValue }))
            stateManager.setGlobalState(config.stateKey, newValue)

            rebuildTaskApi()
        },
        [features, stateManager, setFeatures, rebuildTaskApi],
    )

    const setReasoningEffortForMode = useCallback(
        (mode: "act" | "plan", effort: OpenaiReasoningEffort) => {
            if (mode === "act") {
                setActReasoningEffort(effort)
                stateManager.setGlobalState("actModeReasoningEffort", effort)
                if (!separateModels) {
                    setPlanReasoningEffort(effort)
                    stateManager.setGlobalState("planModeReasoningEffort", effort)
                }
            } else {
                setPlanReasoningEffort(effort)
                stateManager.setGlobalState("planModeReasoningEffort", effort)
            }
            rebuildTaskApi()
        },
        [separateModels, rebuildTaskApi, stateManager, setActReasoningEffort, setPlanReasoningEffort],
    )

    const startCodexAuth = useCallback(async () => {
        try {
            setIsWaitingForCodexAuth(true)
            setCodexAuthError(null)
            const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()
            setCodexAuthUrl(authUrl)
            await openExternal(authUrl)
            await openAiCodexOAuthManager.waitForCallback()
            await applyProviderConfig({ providerId: "openai-codex", controller })
            setProvider("openai-codex")
            refreshModelIds()
            setIsWaitingForCodexAuth(false)
            setCodexAuthUrl(null)
        } catch (error) {
            openAiCodexOAuthManager.cancelAuthorizationFlow()
            setCodexAuthError(error instanceof Error ? error.message : String(error))
            setIsWaitingForCodexAuth(false)
            setCodexAuthUrl(null)
        }
    }, [controller, setIsWaitingForCodexAuth, setCodexAuthError, setCodexAuthUrl, setProvider, refreshModelIds])

    const startGithubAuth = useCallback(async () => {
        try {
            setIsWaitingForGithubAuth(true)
            const data = await githubCopilotAuthManager.initiateDeviceFlow()
            setGithubAuthData(data)
            await openExternal(data.verification_uri)
            await githubCopilotAuthManager.pollForToken(data.device_code, data.interval)
            await applyProviderConfig({ providerId: "github-copilot", controller })
            setProvider("github-copilot")
            refreshModelIds()
            setIsWaitingForGithubAuth(false)
            setGithubAuthData(null)
        } catch (error) {
            setIsWaitingForGithubAuth(false)
            setGithubAuthData(null)
            Logger.error("[github-copilot-auth] Auth failed:", error)
        }
    }, [controller, setIsWaitingForGithubAuth, setGithubAuthData, setProvider, refreshModelIds])

    const handleAction = useCallback(() => {
        const item = items[selectedIndex]
        if (!item || item.type === "readonly" || item.type === "separator" || item.type === "header" || item.type === "spacer")
            return

        if (item.type === "action") {
            if (item.key === "codexSignOut") {
                openAiCodexOAuthManager.clearCredentials().then(() => {
                    rebuildTaskApi()
                })
                return
            }
            if (item.key === "githubSignOut") {
                githubCopilotAuthManager.clearCredentials().then(() => {
                    rebuildTaskApi()
                })
                return
            }
            if (item.key === "githubSignIn") {
                startGithubAuth()
                return
            }
            return
        }

        if (item.type === "object") {
            setObjectEditor({
                source: "global",
                key: item.key,
                path: [],
                value: item.value as Record<string, unknown>,
                selectedIndex: 0,
                isEditingValue: false,
                isAddingKey: false,
                editValue: "",
            })
            return
        }

        if (item.type === "cycle") {
            const targetMode = item.key === "actReasoningEffort" ? "act" : item.key === "planReasoningEffort" ? "plan" : undefined
            if (targetMode) {
                const currentEffort = targetMode === "act" ? actReasoningEffort : planReasoningEffort
                setReasoningEffortForMode(targetMode, nextReasoningEffort(currentEffort))
            }
            return
        }

        if (item.type === "editable") {
            if (item.key === "provider") {
                setIsPickingProvider(true)
                return
            }
            if ((item.key === "actModelId" || item.key === "planModelId") && hasModelPicker(provider)) {
                setPickingModelKey(item.key as "actModelId" | "planModelId")
                setIsPickingModel(true)
                return
            }
            if (item.key === "language") {
                setIsPickingLanguage(true)
                return
            }
            setEditValue(typeof item.value === "string" ? item.value : "")
            setIsEditing(true)
            return
        }

        // Checkbox handling
        const newValue = !item.value

        if (item.key in FEATURE_SETTINGS) {
            toggleFeature(item.key as FeatureKey)
            return
        }

        // Tool toggle handling
        const isTool = availableTools.some((t) => t.id === item.key)
        if (isTool) {
            const toolId = item.key
            ToolRegistry.getInstance().toggleAndPersist(toolId, newValue)
            setToolToggles((prev) => ({ ...prev, [toolId]: newValue }))
            rebuildTaskApi()
            return
        }

        if (item.key === "separateModels") {
            setSeparateModels(newValue)
            stateManager.setGlobalState("planActSeparateModelsSetting", newValue)
            if (!newValue) {
                const apiConfig = stateManager.getApiConfiguration()
                const actProvider = apiConfig.actModeApiProvider
                const planProvider = apiConfig.planModeApiProvider || actProvider
                if (actProvider) {
                    const actKey = getProviderModelIdKey(actProvider, "act")
                    const planKey = planProvider ? getProviderModelIdKey(planProvider, "plan") : null
                    const actModel = stateManager.getGlobalSettingsKey(actKey)
                    if (planKey) stateManager.setGlobalState(planKey, actModel)
                }
                const actThinkingBudget = stateManager.getGlobalSettingsKey("actModeThinkingBudgetTokens") ?? 0
                stateManager.setGlobalState("planModeThinkingBudgetTokens", actThinkingBudget)
                setPlanThinkingEnabled(actThinkingBudget > 0)

                const actEffort = normalizeReasoningEffort(stateManager.getGlobalSettingsKey("actModeReasoningEffort"))
                stateManager.setGlobalState("planModeReasoningEffort", actEffort)
                setPlanReasoningEffort(actEffort)
            }
            rebuildTaskApi()
            return
        }

        if (item.key === "actThinkingEnabled") {
            setActThinkingEnabled(newValue)
            stateManager.setGlobalState("actModeThinkingBudgetTokens", newValue ? 1024 : 0)
            if (!separateModels) {
                setPlanThinkingEnabled(newValue)
                stateManager.setGlobalState("planModeThinkingBudgetTokens", newValue ? 1024 : 0)
            }
            rebuildTaskApi()
            return
        }

        if (item.key === "planThinkingEnabled") {
            setPlanThinkingEnabled(newValue)
            stateManager.setGlobalState("planModeThinkingBudgetTokens", newValue ? 1024 : 0)
            rebuildTaskApi()
            return
        }

        if (item.key === "telemetry") {
            const newTelemetry: TelemetrySetting = newValue ? "enabled" : "disabled"
            setTelemetry(newTelemetry)
            stateManager.setGlobalState("telemetrySetting", newTelemetry)
            void stateManager.flushPendingState().then(() => {
                controller?.updateTelemetrySetting(newTelemetry)
            })
            return
        }

        if (item.key === "enableNotifications") {
            const newSettings = {
                ...autoApproveSettings,
                version: (autoApproveSettings.version ?? 1) + 1,
                enableNotifications: newValue,
            }
            setAutoApproveSettings(newSettings)
            stateManager.setGlobalState("autoApprovalSettings", newSettings)
            rebuildTaskApi()
            return
        }

        const actionKey = item.key as keyof AutoApprovalSettings["actions"]
        const newActions = { ...autoApproveSettings.actions, [actionKey]: newValue }
        if (!newValue) {
            if (actionKey === "readFiles") newActions.readFilesExternally = false
            if (actionKey === "editFiles") newActions.editFilesExternally = false
        }
        if (newValue && item.parentKey) {
            newActions[item.parentKey as keyof typeof newActions] = true
        }
        const newSettings = { ...autoApproveSettings, version: (autoApproveSettings.version ?? 1) + 1, actions: newActions }
        setAutoApproveSettings(newSettings)
        stateManager.setGlobalState("autoApprovalSettings", newSettings)
        rebuildTaskApi()
    }, [
        items,
        selectedIndex,
        stateManager,
        autoApproveSettings,
        toggleFeature,
        separateModels,
        actReasoningEffort,
        planReasoningEffort,
        rebuildTaskApi,
        setReasoningEffortForMode,
        startGithubAuth,
        setObjectEditor,
        setIsPickingProvider,
        setIsPickingModel,
        setPickingModelKey,
        setIsPickingLanguage,
        setEditValue,
        setIsEditing,
        setSeparateModels,
        setPlanThinkingEnabled,
        setPlanReasoningEffort,
        setActThinkingEnabled,
        setTelemetry,
        setAutoApproveSettings,
        provider,
        availableTools,
    ])

    const handleSave = useCallback(
        async (editValue: string) => {
            const item = items[selectedIndex]
            if (!item) return

            switch (item.key) {
                case "baseUrl": {
                    await applyProviderConfig({
                        providerId: provider,
                        baseUrl: editValue,
                        controller,
                    })
                    break
                }
                case "actModelId":
                case "planModelId":
                case "actCustomModelId":
                case "planCustomModelId": {
                    const apiConfig = stateManager.getApiConfiguration()
                    const actProvider = apiConfig.actModeApiProvider
                    const planProvider = apiConfig.planModeApiProvider || actProvider
                    if (!actProvider && !planProvider) break
                    const actKey = actProvider ? getProviderModelIdKey(actProvider, "act") : null
                    const planKey = planProvider ? getProviderModelIdKey(planProvider, "plan") : null

                    if (separateModels) {
                        const stateKey = item.key === "actModelId" || item.key === "actCustomModelId" ? actKey : planKey
                        if (stateKey) stateManager.setGlobalState(stateKey, editValue || undefined)
                    } else {
                        if (actKey) stateManager.setGlobalState(actKey, editValue || undefined)
                        if (planKey) stateManager.setGlobalState(planKey, editValue || undefined)
                    }
                    break
                }
                case "language":
                    setPreferredLanguage(editValue)
                    stateManager.setGlobalState("preferredLanguage", editValue)
                    break
            }

            await rebuildTaskApi()
            refreshModelIds()

            setIsEditing(false)
        },
        [
            items,
            selectedIndex,
            separateModels,
            stateManager,
            setPreferredLanguage,
            setIsEditing,
            rebuildTaskApi,
            provider,
            controller,
            refreshModelIds,
        ],
    )

    const handleProviderSelect = useCallback(
        async (providerId: string) => {
            const keyField = ProviderToApiKeyMap[providerId as ApiProvider]
            const apiConfig = stateManager.getApiConfiguration()
            const fieldName = keyField ? (Array.isArray(keyField) ? keyField[0] : keyField) : null
            const existingKey = fieldName ? (apiConfig as Record<string, string>)[fieldName] || "" : ""

            if (initialMode === "provider-picker" && (existingKey || !keyField) && providerId !== "bedrock") {
                let canSwitchDirectly = true
                if (providerId === "openai-codex") {
                    canSwitchDirectly = await openAiCodexOAuthManager.isAuthenticated()
                } else if (providerId === "github-copilot") {
                    canSwitchDirectly = await githubCopilotAuthManager.isAuthenticated()
                }
                if (canSwitchDirectly) {
                    await applyProviderConfig({ providerId, controller })
                    setProvider(providerId)
                    refreshModelIds()
                    setIsPickingProvider(false)
                    onClose()
                    return
                }
            }

            if (providerId === "bedrock") {
                const isConfigured = !!(apiConfig.awsRegion && (apiConfig.awsUseProfile || (apiConfig.awsAccessKey && apiConfig.awsSecretKey)))
                if (initialMode === "provider-picker" && isConfigured) {
                    await applyProviderConfig({ providerId, controller })
                    setProvider(providerId)
                    refreshModelIds()
                    setIsPickingProvider(false)
                    onClose()
                    return
                }
                setPendingProvider(providerId)
                setIsPickingProvider(false)
                setIsConfiguringBedrock(true)
                return
            }

            if (providerId === "github-copilot") {
                setIsPickingProvider(false)
                const isAuthenticated = await githubCopilotAuthManager.isAuthenticated()
                if (!isAuthenticated) {
                    startGithubAuth()
                } else {
                    await applyProviderConfig({ providerId, controller })
                    setProvider(providerId)
                    refreshModelIds()
                }
                return
            }

            if (providerId === "dirac") {
                setIsPickingProvider(false)
                await applyProviderConfig({ providerId: "dirac", controller })
                setProvider("dirac")
                refreshModelIds()
                return
            }

            if (providerId === "openai-codex") {
                setIsPickingProvider(false)
                startCodexAuth()
                return
            }

            if (keyField) {
                setPendingProvider(providerId)
                setApiKeyValue(existingKey)
                setIsPickingProvider(false)
                setIsEnteringApiKey(true)
            } else {
                await applyProviderConfig({ providerId, controller })
                setProvider(providerId)
                refreshModelIds()
                setIsPickingProvider(false)
            }
        },
        [stateManager, startCodexAuth, controller, refreshModelIds, initialMode, onClose, setProvider, setIsPickingProvider, setIsConfiguringBedrock, setPendingProvider, startGithubAuth, setApiKeyValue, setIsEnteringApiKey],
    )

    const handleModelSelect = useCallback(
        async (modelId: string) => {
            if (!pickingModelKey) return
            if (modelId === CUSTOM_MODEL_ID) {
                if (provider === "bedrock") {
                    setIsPickingModel(false)
                    setIsBedrockCustomFlow(true)
                    return
                }
                if (usesOpenRouterModels(provider)) {
                    // For OpenRouter, selecting "Custom" just sets the model ID to __custom__
                    // which triggers the third line to appear in the settings list.
                }
            }

            const apiConfig = stateManager.getApiConfiguration()
            const actProvider = apiConfig.actModeApiProvider
            const planProvider = apiConfig.planModeApiProvider || actProvider
            const providerForSelection = separateModels ? (pickingModelKey === "actModelId" ? actProvider : planProvider) : actProvider || planProvider
            if (!providerForSelection) return

            const actKey = actProvider ? getProviderModelIdKey(actProvider, "act") : null
            const planKey = planProvider ? getProviderModelIdKey(planProvider, "plan") : null

            let modelInfo: ModelInfo | undefined
            if (providerForSelection === "dirac" || providerForSelection === "openrouter") {
                const openRouterModels = await controller?.readOpenRouterModels()
                modelInfo = openRouterModels?.[modelId]
            }

            if (separateModels) {
                const stateKey = pickingModelKey === "actModelId" ? actKey : planKey
                if (stateKey) stateManager.setGlobalState(stateKey, modelId)
                if (modelInfo) {
                    const infoKey = pickingModelKey === "actModelId" ? "actModeOpenRouterModelInfo" : "planModeOpenRouterModelInfo"
                    stateManager.setGlobalState(infoKey, modelInfo)
                }
            } else {
                if (actKey) stateManager.setGlobalState(actKey, modelId)
                if (planKey) stateManager.setGlobalState(planKey, modelId)
                if (modelInfo) {
                    stateManager.setGlobalState("actModeOpenRouterModelInfo", modelInfo)
                    stateManager.setGlobalState("planModeOpenRouterModelInfo", modelInfo)
                }
            }

            await stateManager.flushPendingState()
            await rebuildTaskApi()
            refreshModelIds()
            setIsPickingModel(false)
            setPickingModelKey(null)
            if (initialMode) onClose()
        },
        [pickingModelKey, separateModels, stateManager, controller, provider, refreshModelIds, initialMode, onClose, setIsPickingModel, setIsBedrockCustomFlow, setPickingModelKey, rebuildTaskApi],
    )

    const handleApiKeySubmit = useCallback(
        async (submittedValue: string) => {
            if (!pendingProvider || !submittedValue.trim()) return
            await applyProviderConfig({ providerId: pendingProvider, apiKey: submittedValue.trim(), controller })
            setProvider(pendingProvider)
            refreshModelIds()
            setIsEnteringApiKey(false)
            setPendingProvider(null)
            setApiKeyValue("")
            if (initialMode) onClose()
        },
        [pendingProvider, controller, refreshModelIds, initialMode, onClose, setProvider, setIsEnteringApiKey, setPendingProvider, setApiKeyValue],
    )

    const handleBedrockComplete = useCallback(
        (bedrockConfig: BedrockConfig) => {
            setProvider("bedrock")
            refreshModelIds()
            setIsConfiguringBedrock(false)
            setPendingProvider(null)
            applyBedrockConfig({ bedrockConfig, controller })
            if (initialMode) onClose()
        },
        [controller, refreshModelIds, initialMode, onClose, setProvider, setIsConfiguringBedrock, setPendingProvider],
    )

    const handleBedrockCustomFlowComplete = useCallback(
        async (arn: string, baseModelId: string) => {
            if (!pickingModelKey) return
            const apiConfig = stateManager.getApiConfiguration()
            const bedrockConfig: BedrockConfig = {
                awsRegion: apiConfig.awsRegion ?? "us-east-1",
                awsAuthentication: apiConfig.awsUseProfile ? "profile" : "credentials",
                awsUseCrossRegionInference: Boolean(apiConfig.awsUseCrossRegionInference),
            }
            await applyBedrockConfig({ bedrockConfig, modelId: arn, customModelBaseId: baseModelId, controller })
            await stateManager.flushPendingState()
            rebuildTaskApi()
            refreshModelIds()
            setIsBedrockCustomFlow(false)
            setPickingModelKey(null)
            if (initialMode) onClose()
        },
        [pickingModelKey, stateManager, controller, rebuildTaskApi, refreshModelIds, initialMode, onClose, setIsBedrockCustomFlow, setPickingModelKey],
    )

    const handleLanguageSelect = useCallback(
        (language: string) => {
            setPreferredLanguage(language)
            stateManager.setGlobalState("preferredLanguage", language)
            setIsPickingLanguage(false)

            rebuildTaskApi()

        },
        [stateManager, setPreferredLanguage, setIsPickingLanguage, rebuildTaskApi],
    )

    const navigateItems = useCallback(
        (direction: "up" | "down") => {
            setSelectedIndex((i) => {
                let next = direction === "up" ? (i > 0 ? i - 1 : items.length - 1) : i < items.length - 1 ? i + 1 : 0
                const skipTypes = ["separator", "header", "spacer"]
                while (skipTypes.includes(items[next]?.type) && next !== i) {
                    next = direction === "up" ? (next > 0 ? next - 1 : items.length - 1) : next < items.length - 1 ? next + 1 : 0
                }
                return next
            })
        },
        [items, setSelectedIndex],
    )

    return {
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
        toggleFeature,
        setReasoningEffortForMode,
    }
}
