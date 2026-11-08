import { readModeSelection } from "../modelSelectionBinding"
import { modelProviderSelectionUpdates } from "@shared/modelProviderSelection"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import {
	type ApiProvider,
	createModelProviderSelection,
	type ModelProviderPreset,
	type ModelProviderSelection,
} from "@shared/api"
import { isValidAutoCondenseContextLimit } from "@shared/context-management"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { ProviderToApiKeyMap, type UtilityModelUseCases } from "@shared/storage"
import { isOpenaiReasoningEffort, type OpenaiReasoningEffort } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { useCallback, useRef } from "react"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import type { TaskWorkingConfigurationPatch } from "@/core/task/runtime/TaskWorkingConfiguration"
import { ToolRegistry } from "@/core/task/tools/registry/ToolRegistry"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { openAiCodexUsageService } from "@/integrations/openai-codex/OpenAiCodexUsageService"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"
import { createModelSelectionPatch } from "../../../utils/model-selection"
import { applyBedrockConfig, applyProviderConfig, saveBedrockSetup, saveProviderSetup } from "../../../utils/provider-config"
import type { BedrockConfig } from "../../BedrockSetup"
import type { ObjectEditorState } from "../../ConfigViewComponents"
import { CUSTOM_MODEL_ID, hasModelPicker } from "../../ModelPicker"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import { getNextSelectableSettingsIndex } from "../navigation"
import { persistInteractiveSettingWithRollback } from "../settingsTransaction"
import { type ListItem, SettingsItemType, SettingsNavigationDirection } from "../types"
import { nextReasoningEffort, normalizeReasoningEffort } from "../utils"

const utilityModelUseCaseSettings = {
	utilityModelUseCondense: "condense",
	utilityModelUseGenerateCommitMessage: "generateCommitMessage",
	utilityModelUsePermissionHandling: "permissionHandling",
} as const

type UtilityModelUseCaseSetting = keyof typeof utilityModelUseCaseSettings

interface UseSettingsActionsProps {
	items: ListItem[]
	selectedIndex: number
	setSelectedIndex: (index: number | ((i: number) => number)) => void
	provider: string
	setProvider: (provider: string) => void
	actModelId: string
	planModelId: string
	openRouterProviderSorting?: string
	setOpenRouterProviderSorting: (sorting: string | undefined) => void
	setOpenRouterPreventFallbacks: (preventFallbacks: boolean) => void
	setOpenRouterRoutingModelId: (modelId: string | null) => void
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
	autoApproveAllToggled: boolean
	setAutoApproveAllToggled: (value: boolean) => void
	features: Record<FeatureKey, boolean>
	utilityModelUseCases: UtilityModelUseCases
	setUtilityModelUseCases: (useCases: UtilityModelUseCases | ((previous: UtilityModelUseCases) => UtilityModelUseCases)) => void
	setUtilityPermissionPolicy: (policy: string) => void
	setFeatures: (
		features: Record<FeatureKey, boolean> | ((prev: Record<FeatureKey, boolean>) => Record<FeatureKey, boolean>),
	) => void
	setLightTerminalTheme: (value: boolean) => void
	setVimModeEnabled: (value: boolean) => void
	preferredLanguage: string
	setPreferredLanguage: (language: string) => void
	telemetry: TelemetrySetting
	setTelemetry: (telemetry: TelemetrySetting) => void
	openAiHeaders: Record<string, string>
	setOpenAiHeaders: (headers: Record<string, string>) => void
	setAutoCondenseContextLimit: (limit: number) => void
	setIsPickingProvider: (value: boolean) => void
	setIsPickingModel: (value: boolean) => void
	pickingModelKey: "actModelId" | "planModelId" | null
	setPickingModelKey: (key: "actModelId" | "planModelId" | null) => void
	setIsPickingLanguage: (value: boolean) => void
	setIsPickingUtilityModel: (value: boolean) => void
	setUtilityModelSelection: (selection: ModelProviderSelection | undefined) => void
	setIsEnteringApiKey: (value: boolean) => void
	pendingProvider: string | null
	setPendingProvider: (provider: string | null) => void
	setApiKeyValue: (value: string) => void
	setIsEditing: (value: boolean) => void
	setEditValue: (value: string) => void
	setObjectEditor: (state: ObjectEditorState | null) => void
	setIsWaitingForCodexAuth: (value: boolean) => void
	setIsWaitingForGithubAuth: (value: boolean) => void
	setGithubAuthData: (data: any) => void
	setIsBedrockCustomFlow: (value: boolean) => void
	setIsConfiguringBedrock: (value: boolean) => void
	controller?: Controller
	stateManager: StateManager
	rebuildTaskApi: (patch: TaskWorkingConfigurationPatch, persist: () => void | Promise<void>) => Promise<void>
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
	setVimModeEnabled,
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
}: UseSettingsActionsProps) {
	const githubAuthAbortControllerRef = useRef<AbortController | null>(null)

	const commitSettings = useCallback(
		async (settings: Record<string, unknown>, flush = false) => {
			const previous = Object.fromEntries(
				Object.keys(settings).map((key) => [key, structuredClone(stateManager.getGlobalSettingsKey(key as any))]),
			)
			await rebuildTaskApi({ settings }, () =>
				persistInteractiveSettingWithRollback(
					async () => {
						for (const [key, value] of Object.entries(settings)) stateManager.setGlobalState(key as any, value as any)
						if (flush) await stateManager.flushPendingState()
					},
					async () => {
						for (const [key, value] of Object.entries(previous)) stateManager.setGlobalState(key as any, value as any)
						if (flush) await stateManager.flushPendingState()
					},
				),
			)
		},
		[rebuildTaskApi, stateManager],
	)

	const toggleFeature = useCallback(
		async (key: FeatureKey) => {
			const config = FEATURE_SETTINGS[key]
			const newValue = !features[key]
			await commitSettings({ [config.stateKey]: newValue })
			setFeatures((prev) => ({ ...prev, [key]: newValue }))
		},
		[features, setFeatures, commitSettings],
	)

	const handleUtilityModelPresetSelect = useCallback(
		async (preset: ModelProviderPreset) => {
			const selection = createModelProviderSelection(preset)
			await commitSettings({ utilityModelSelection: selection }, true)
			setUtilityModelSelection(selection)
			setIsPickingUtilityModel(false)
		},
		[commitSettings, setIsPickingUtilityModel, setUtilityModelSelection],
	)

	const setReasoningEffortForMode = useCallback(
		async (mode: "act" | "plan", effort: OpenaiReasoningEffort) => {
			const settingsPatch =
				mode === "act"
					? {
						actModeReasoningEffort: effort,
						...(!separateModels ? { planModeReasoningEffort: effort } : {}),
					}
					: { planModeReasoningEffort: effort }
			await commitSettings(settingsPatch)
			if (mode === "act") {
				setActReasoningEffort(effort)
				if (!separateModels) setPlanReasoningEffort(effort)
			} else {
				setPlanReasoningEffort(effort)
			}
		},
		[separateModels, commitSettings, setActReasoningEffort, setPlanReasoningEffort],
	)

	const startCodexAuth = useCallback(() => {
		setIsWaitingForCodexAuth(true)
	}, [setIsWaitingForCodexAuth])

	const activatePickedProvider = useCallback(async (providerId: string) => {
		if (initialMode !== "provider-picker") return
		await applyProviderConfig({ providerId, controller })
		setProvider(providerId)
		refreshModelIds()
	}, [initialMode, controller, setProvider, refreshModelIds])

	const completeCodexAuth = useCallback(async () => {
		await saveProviderSetup({ providerId: "openai-codex", controller })
		await activatePickedProvider("openai-codex")
		setIsWaitingForCodexAuth(false)
	}, [controller, activatePickedProvider, setIsWaitingForCodexAuth])

	const startGithubAuth = useCallback(async () => {
		const abortController = new AbortController()
		githubAuthAbortControllerRef.current?.abort()
		githubAuthAbortControllerRef.current = abortController
		try {
			setIsWaitingForGithubAuth(true)
			const data = await githubCopilotAuthManager.initiateDeviceFlow()
			setGithubAuthData(data)
			await openExternal(data.verification_uri)
			await githubCopilotAuthManager.pollForToken(data.device_code, data.interval, abortController.signal)
			if (abortController.signal.aborted) return
			await saveProviderSetup({ providerId: "github-copilot", controller })
			await activatePickedProvider("github-copilot")
			setIsWaitingForGithubAuth(false)
			setGithubAuthData(null)
		} catch (error) {
			if (abortController.signal.aborted) return
			setIsWaitingForGithubAuth(false)
			setGithubAuthData(null)
			Logger.error("[github-copilot-auth] Auth failed:", error)
			throw error
		} finally {
			if (githubAuthAbortControllerRef.current === abortController) githubAuthAbortControllerRef.current = null
		}
	}, [controller, setIsWaitingForGithubAuth, setGithubAuthData, activatePickedProvider])

	const cancelGithubAuth = useCallback(() => {
		githubAuthAbortControllerRef.current?.abort()
		githubAuthAbortControllerRef.current = null
		setIsWaitingForGithubAuth(false)
		setGithubAuthData(null)
	}, [setGithubAuthData, setIsWaitingForGithubAuth])

	const handleAction = useCallback(async (requestedItem?: ListItem) => {
		const item = requestedItem ?? items[selectedIndex]
		if (
			!item ||
			item.type === SettingsItemType.READONLY ||
			item.type === SettingsItemType.SEPARATOR ||
			item.type === SettingsItemType.HEADER ||
			item.type === SettingsItemType.SPACER
		)
			return

		const utilityModelUseCase = utilityModelUseCaseSettings[item.key as UtilityModelUseCaseSetting]
		if (utilityModelUseCase) {
			const newValue = !utilityModelUseCases[utilityModelUseCase]
			await commitSettings({ [item.key]: newValue }, true)
			setUtilityModelUseCases((previous) => ({ ...previous, [utilityModelUseCase]: newValue }))
			return
		}

		if (item.type === SettingsItemType.ACTION) {
			if (item.key === "utilityModelSelection") {
				setIsPickingUtilityModel(true)
				return
			}
			if (item.key === "documentation") {
				await openExternal("https://dirac.run/docs/")
				return
			}
			if (item.key === "communitySupport") {
				await openExternal("https://discord.gg/wcYTx9BGea")
				return
			}
			if (item.key === "codexSignOut") {
				const previousCredentials = openAiCodexOAuthManager.getCredentials()
				await rebuildTaskApi({ apiConfiguration: { "openai-codex-oauth-credentials": undefined } }, () =>
					persistInteractiveSettingWithRollback(
						() => openAiCodexOAuthManager.clearCredentials(),
						async () => {
							if (previousCredentials) await openAiCodexOAuthManager.saveCredentials(previousCredentials)
						},
					),
				)
				openAiCodexUsageService.clear()
				return
			}
			if (item.key === "githubSignOut") {
				const previousCredentials = await githubCopilotAuthManager.loadCredentials()
				await rebuildTaskApi({ apiConfiguration: { "github-copilot-oauth-credentials": undefined } }, () =>
					persistInteractiveSettingWithRollback(
						() => githubCopilotAuthManager.clearCredentials(),
						async () => {
							if (previousCredentials) await githubCopilotAuthManager.saveCredentials(previousCredentials)
						},
					),
				)
				return
			}
			if (item.key === "githubSignIn") await startGithubAuth()
			return
		}

		if (item.key === "autoApproveAll") {
			await commitSettings({ autoApproveAllToggled: !autoApproveAllToggled }, true)
			setAutoApproveAllToggled(!autoApproveAllToggled)
			return
		}

		if (item.type === SettingsItemType.OBJECT) {
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

		if (item.type === SettingsItemType.CYCLE) {
			if (item.key === "openRouterProviderSorting") {
				const sortingOptions = [undefined, "price", "throughput", "latency"]
				const nextSorting =
					sortingOptions[(sortingOptions.indexOf(openRouterProviderSorting) + 1) % sortingOptions.length]
				await commitSettings({ openRouterProviderSorting: nextSorting })
				setOpenRouterProviderSorting(nextSorting)
				return
			}
			const targetMode = item.key === "actReasoningEffort" ? "act" : item.key === "planReasoningEffort" ? "plan" : undefined
			if (targetMode) {
				const currentEffort = normalizeReasoningEffort(item.value)
				const options = item.cycleOptions?.filter(isOpenaiReasoningEffort)
				await setReasoningEffortForMode(targetMode, nextReasoningEffort(currentEffort, options))
			}
			return
		}

		if (item.type === SettingsItemType.EDITABLE) {
			if (item.key === "actOpenRouterProviders" || item.key === "planOpenRouterProviders") {
				const modelId = item.key === "actOpenRouterProviders" ? actModelId : planModelId
				if (modelId) setOpenRouterRoutingModelId(modelId)
				return
			}
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

		const newValue = !item.value
		if (item.key === "vimModeEnabled") {
			const previous = stateManager.getGlobalSettingsKey("cliVimMode")
			await persistInteractiveSettingWithRollback(
				async () => {
					stateManager.setGlobalState("cliVimMode", newValue)
					await stateManager.flushPendingState()
				},
				async () => {
					stateManager.setGlobalState("cliVimMode", previous)
					await stateManager.flushPendingState()
				},
			)
			setVimModeEnabled(newValue)
			return
		}
		if (item.key === "lightTerminalTheme") {
			setLightTerminalTheme(newValue)
			stateManager.setGlobalState("cliTerminalColorMode", newValue ? "light" : "dark")
			await stateManager.flushPendingState()
			return
		}
		if (item.key in FEATURE_SETTINGS) {
			await toggleFeature(item.key as FeatureKey)
			return
		}

		const isTool = availableTools.some((t) => t.id === item.key)
		if (isTool) {
			const toolId = item.key
			const previousToggles = await ToolRegistry.withExclusiveAccess((registry) => registry.getToggles())
			const toggles = { ...previousToggles, [toolId]: newValue }
			await rebuildTaskApi({ settings: { toolToggles: toggles } }, () =>
				persistInteractiveSettingWithRollback(
					() =>
						ToolRegistry.withExclusiveAccess((registry) => {
							registry.loadToggles(toggles)
							stateManager.setGlobalState("toolToggles", registry.getToggles())
						}),
					() =>
						ToolRegistry.withExclusiveAccess((registry) => {
							registry.loadToggles(previousToggles)
							stateManager.setGlobalState("toolToggles", registry.getToggles())
						}),
				),
			)
			setToolToggles((prev) => ({ ...prev, [toolId]: newValue }))
			return
		}

		if (item.key === "separateModels") {
			const taskConfig = controller?.task?.getWorkingConfiguration()
			const effectiveSettings = taskConfig?.settings
			const effectiveApi = taskConfig?.apiConfiguration ?? stateManager.getApiConfiguration()
			const taskSettingsPatch: Record<string, unknown> = { planActSeparateModelsSetting: newValue }
			if (!newValue) {
				const selection = readModeSelection(effectiveApi, "act")
				if (!selection?.modelId) throw new Error("Configure the Act model before sharing it with Plan")
				Object.assign(taskSettingsPatch, modelProviderSelectionUpdates("plan", selection, effectiveApi.actModeInferenceSpeed))
			}
			await commitSettings(taskSettingsPatch)
			setSeparateModels(newValue)
			if (!newValue) {
				setPlanThinkingEnabled(Number(taskSettingsPatch.planModeThinkingBudgetTokens) > 0)
				setPlanReasoningEffort(taskSettingsPatch.planModeReasoningEffort as OpenaiReasoningEffort)
			}
			return
		}

		if (item.key === "actThinkingEnabled") {
			const patch = {
				actModeThinkingBudgetTokens: newValue ? 1024 : 0,
				...(!separateModels ? { planModeThinkingBudgetTokens: newValue ? 1024 : 0 } : {}),
			}
			await commitSettings(patch)
			setActThinkingEnabled(newValue)
			if (!separateModels) setPlanThinkingEnabled(newValue)
			return
		}
		if (item.key === "planThinkingEnabled") {
			await commitSettings({ planModeThinkingBudgetTokens: newValue ? 1024 : 0 })
			setPlanThinkingEnabled(newValue)
			return
		}
		if (item.key === "openRouterPreventFallbacks") {
			await commitSettings({ openRouterPreventFallbacks: newValue || undefined })
			setOpenRouterPreventFallbacks(newValue)
			return
		}
		if (item.key === "telemetry") {
			const newTelemetry: TelemetrySetting = newValue ? "enabled" : "disabled"
			setTelemetry(newTelemetry)
			await controller?.updateTelemetrySetting(newTelemetry)
			return
		}

		let newSettings: AutoApprovalSettings
		if (item.key === "enableNotifications") {
			newSettings = {
				...autoApproveSettings,
				version: (autoApproveSettings.version ?? 1) + 1,
				enableNotifications: newValue,
			}
		} else {
			const actionKey = item.key as keyof AutoApprovalSettings["actions"]
			const newActions = { ...autoApproveSettings.actions, [actionKey]: newValue }
			if (!newValue) {
				if (actionKey === "readFiles") newActions.readFilesExternally = false
				if (actionKey === "editFiles") newActions.editFilesExternally = false
			}
			if (newValue && item.parentKey) newActions[item.parentKey as keyof typeof newActions] = true
			newSettings = { ...autoApproveSettings, version: (autoApproveSettings.version ?? 1) + 1, actions: newActions }
		}
		await commitSettings({ autoApprovalSettings: newSettings })
		setAutoApproveSettings(newSettings)
	}, [
		items,
		selectedIndex,
		stateManager,
		controller,
		autoApproveSettings,
		toggleFeature,
		utilityModelUseCases,
		setUtilityModelUseCases,
		separateModels,
		actReasoningEffort,
		planReasoningEffort,
		rebuildTaskApi,
		commitSettings,
		setReasoningEffortForMode,
		startGithubAuth,
		setObjectEditor,
		setIsPickingProvider,
		setIsPickingModel,
		setPickingModelKey,
		setIsPickingLanguage,
		setIsPickingUtilityModel,
		setEditValue,
		setIsEditing,
		setLightTerminalTheme,
		setSeparateModels,
		setPlanThinkingEnabled,
		setPlanReasoningEffort,
		setActThinkingEnabled,
		setTelemetry,
		setAutoApproveSettings,
		autoApproveAllToggled,
		setAutoApproveAllToggled,
		provider,
		actModelId,
		planModelId,
		openRouterProviderSorting,
		setOpenRouterProviderSorting,
		setOpenRouterPreventFallbacks,
		setOpenRouterRoutingModelId,
		availableTools,
		setToolToggles,
	])

	const handleSave = useCallback(
		async (editValue: string) => {
			const item = items[selectedIndex]
			if (!item) return
			if (item.key === "baseUrl") {
				await saveProviderSetup({ providerId: provider, baseUrl: editValue, controller })
				refreshModelIds()
				setIsEditing(false)
				return
			}

			const settingsPatch: Record<string, unknown> = {}
			if (["actModelId", "planModelId", "actCustomModelId", "planCustomModelId"].includes(item.key)) {
				const taskConfig =
					controller?.task?.getWorkingConfiguration().apiConfiguration ?? stateManager.getApiConfiguration()
				const selectedMode = item.key.startsWith("act") ? "act" : "plan"
				Object.assign(
					settingsPatch,
					await createModelSelectionPatch(taskConfig, selectedMode, editValue || undefined, separateModels, controller),
				)
			} else if (item.key === "autoCondenseContextLimit") {
				const limit = Number(editValue)
				if (!isValidAutoCondenseContextLimit(limit))
					throw new Error("Auto-condense context limit must be between 1 and 2,000,000,000 tokens")
				settingsPatch.autoCondenseContextLimits = {
					...(controller?.task?.getWorkingConfiguration().settings.autoCondenseContextLimits ??
						stateManager.getGlobalSettingsKey("autoCondenseContextLimits")),
					[provider]: limit,
				}
				await commitSettings(settingsPatch)
				setAutoCondenseContextLimit(limit)
			} else if (item.key === "language") {
				settingsPatch.preferredLanguage = editValue
				await commitSettings(settingsPatch)
				setPreferredLanguage(editValue)
			} else if (item.key === "utilityModelPermissionPolicy") {
				settingsPatch.utilityModelPermissionPolicy = editValue
				await commitSettings(settingsPatch, true)
				setUtilityPermissionPolicy(editValue)
			}
			if (
				Object.keys(settingsPatch).length > 0 &&
				item.key !== "autoCondenseContextLimit" &&
				item.key !== "language" &&
				item.key !== "utilityModelPermissionPolicy"
			) {
				await commitSettings(settingsPatch)
			}
			refreshModelIds()
			setIsEditing(false)
		},
		[
			items,
			selectedIndex,
			separateModels,
			stateManager,
			setPreferredLanguage,
			setUtilityPermissionPolicy,
			setAutoCondenseContextLimit,
			setIsEditing,
			commitSettings,
			provider,
			controller,
			refreshModelIds,
		],
	)

	const beginOpenRouterModelSelection = useCallback(() => {
		setPendingProvider("openrouter")
		setIsPickingProvider(false)
		setPickingModelKey("actModelId")
		setIsPickingModel(true)
	}, [setIsPickingModel, setIsPickingProvider, setPendingProvider, setPickingModelKey])

	const handleProviderSelect = useCallback(
		async (providerId: string) => {
			const keyField = ProviderToApiKeyMap[providerId as ApiProvider]
			const apiConfig = stateManager.getApiConfiguration()
			const fieldName = keyField ? (Array.isArray(keyField) ? keyField[0] : keyField) : null
			const existingKey = fieldName ? (apiConfig as Record<string, string>)[fieldName] || "" : ""
			const requiresOpenRouterModelSelection =
				providerId === "openrouter" && !apiConfig.actModeOpenRouterModelId && !apiConfig.planModeOpenRouterModelId
			if (
				initialMode === "provider-picker" &&
				(existingKey || !keyField) &&
				providerId !== "bedrock" &&
				!requiresOpenRouterModelSelection
			) {
				let canSwitchDirectly = true
				if (providerId === "openai-codex") canSwitchDirectly = await openAiCodexOAuthManager.isAuthenticated()
				else if (providerId === "github-copilot") canSwitchDirectly = await githubCopilotAuthManager.isAuthenticated()
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
				const isConfigured = !!(
					apiConfig.awsRegion &&
					(apiConfig.awsUseProfile || (apiConfig.awsAccessKey && apiConfig.awsSecretKey))
				)
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
				if (!(await githubCopilotAuthManager.isAuthenticated())) await startGithubAuth()
				else {
					await saveProviderSetup({ providerId, controller })
				}
				return
			}
			if (providerId === "openai-codex") {
				setIsPickingProvider(false)
				await startCodexAuth()
				return
			}
			if (initialMode === "provider-picker" && requiresOpenRouterModelSelection && existingKey) {
				beginOpenRouterModelSelection()
				return
			}
			if (keyField) {
				setPendingProvider(providerId)
				setApiKeyValue(existingKey)
				setIsPickingProvider(false)
				setIsEnteringApiKey(true)
			} else {
				await saveProviderSetup({ providerId, controller })
				setIsPickingProvider(false)
			}
		},
		[
			stateManager,
			startCodexAuth,
			controller,
			refreshModelIds,
			initialMode,
			onClose,
			setProvider,
			setIsPickingProvider,
			setIsConfiguringBedrock,
			setPendingProvider,
			startGithubAuth,
			setApiKeyValue,
			setIsEnteringApiKey,
			beginOpenRouterModelSelection,
		],
	)

	const handleModelSelect = useCallback(
		async (modelId: string) => {
			if (!pickingModelKey) return
			if (modelId === CUSTOM_MODEL_ID && provider === "bedrock") {
				setIsPickingModel(false)
				setIsBedrockCustomFlow(true)
				return
			}
			if (pendingProvider === "openrouter") {
				await applyProviderConfig({ providerId: pendingProvider, modelId, controller })
				setProvider(pendingProvider)
				setPendingProvider(null)
				refreshModelIds()
				setIsPickingModel(false)
				setPickingModelKey(null)
				if (initialMode) onClose()
				return
			}
			const taskConfig = controller?.task?.getWorkingConfiguration().apiConfiguration ?? stateManager.getApiConfiguration()
			const selectedMode = pickingModelKey === "actModelId" ? "act" : "plan"
			const settingsPatch = await createModelSelectionPatch(taskConfig, selectedMode, modelId, separateModels, controller)
			if (!Object.keys(settingsPatch).length) return
			await commitSettings(settingsPatch, true)
			refreshModelIds()
			setIsPickingModel(false)
			setPickingModelKey(null)
			if (initialMode) onClose()
		},
		[
			pickingModelKey,
			pendingProvider,
			separateModels,
			stateManager,
			controller,
			provider,
			refreshModelIds,
			initialMode,
			onClose,
			setIsPickingModel,
			setIsBedrockCustomFlow,
			setPickingModelKey,
			setPendingProvider,
			setProvider,
			commitSettings,
		],
	)

	const handleApiKeySubmit = useCallback(
		async (submittedValue: string) => {
			if (!pendingProvider || (!submittedValue.trim() && pendingProvider !== "openai")) return
			const apiConfig = stateManager.getApiConfiguration()
			const requiresOpenRouterModelSelection =
				pendingProvider === "openrouter" && !apiConfig.actModeOpenRouterModelId && !apiConfig.planModeOpenRouterModelId
			if (initialMode === "provider-picker" && requiresOpenRouterModelSelection) {
				await saveProviderSetup({ providerId: pendingProvider, apiKey: submittedValue.trim(), controller })
				setIsEnteringApiKey(false)
				setApiKeyValue("")
				beginOpenRouterModelSelection()
				return
			}
			await saveProviderSetup({ providerId: pendingProvider, apiKey: submittedValue.trim(), controller })
			await activatePickedProvider(pendingProvider)
			setIsEnteringApiKey(false)
			setPendingProvider(null)
			setApiKeyValue("")
			if (initialMode) onClose()
		},
		[
			pendingProvider,
			stateManager,
			controller,
			refreshModelIds,
			initialMode,
			onClose,
			beginOpenRouterModelSelection,
			activatePickedProvider,
			setProvider,
			setIsEnteringApiKey,
			setPendingProvider,
			setApiKeyValue,
		],
	)

	const handleBedrockComplete = useCallback(
		async (bedrockConfig: BedrockConfig) => {
			await saveBedrockSetup({ bedrockConfig, controller })
			await activatePickedProvider("bedrock")
			setIsConfiguringBedrock(false)
			setPendingProvider(null)
			if (initialMode) onClose()
		},
		[controller, activatePickedProvider, initialMode, onClose, setIsConfiguringBedrock, setPendingProvider],
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
			refreshModelIds()
			setIsBedrockCustomFlow(false)
			setPickingModelKey(null)
			if (initialMode) onClose()
		},
		[
			pickingModelKey,
			stateManager,
			controller,
			refreshModelIds,
			initialMode,
			onClose,
			setIsBedrockCustomFlow,
			setPickingModelKey,
		],
	)

	const handleLanguageSelect = useCallback(
		async (language: string) => {
			await commitSettings({ preferredLanguage: language })
			setPreferredLanguage(language)
			setIsPickingLanguage(false)
		},
		[commitSettings, setPreferredLanguage, setIsPickingLanguage],
	)

	const navigateItems = useCallback(
		(direction: SettingsNavigationDirection) => {
			setSelectedIndex((currentIndex) => getNextSelectableSettingsIndex(items, currentIndex, direction))
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
		completeCodexAuth,
		cancelGithubAuth,
		navigateItems,
		toggleFeature,
		handleUtilityModelPresetSelect,
		setReasoningEffortForMode,
	}
}
