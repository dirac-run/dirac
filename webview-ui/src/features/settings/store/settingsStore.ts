import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { Environment } from "@shared/config-types"
import type { DiracMessage, ExtensionState } from "@shared/ExtensionMessage"
import type { OpenAiCodexUsageSnapshot } from "@shared/openai-codex-usage"
import { SkillMetadata } from "@shared/skills"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { DEFAULT_PLATFORM } from "@shared/ExtensionMessage"
import {
	basetenDefaultModelId,
	basetenModels,
	groqDefaultModelId,
	groqModels,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
	liteLlmModelInfoSaneDefaults,
	openAiModelInfoSaneDefaults,
	ModelInfo,
	type ApiConfiguration,
} from "@shared/api"
import type { ModelProviderPreset, ModelProviderSelection } from "@shared/api"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import { fromProtobufOpenAiCodexUsage } from "@shared/proto-conversions/openai-codex-usage"
import {
	OpenAiModelsRequest,
	type OpenRouterEndpoint,
	OpenRouterEndpointsRequest,
	OpenRouterEndpointsStatus,
} from "@shared/proto/dirac/models"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { ModelsServiceClient, StateServiceClient } from "@/shared/api/grpc-client"
import { create } from "zustand"

export interface OpenRouterEndpointState {
	status: "loading" | "fresh" | "stale" | "unavailable"
	endpoints: OpenRouterEndpoint[]
	errorMessage?: string
}

interface SettingsState {
	version: string
	apiConfiguration: any
	apiConfigurationError?: string
	pendingApiConfigurationUpdates: Partial<ApiConfiguration>
	modelProviderPresets: ModelProviderPreset[]
	utilityModelEnabled: boolean
	utilityModelSelection?: ModelProviderSelection
	utilityModelUseCondense: boolean
	utilityModelUseNewTask: boolean
	utilityModelUseGenerateCommitMessage: boolean
	utilityModelUsePermissionHandling: boolean
	utilityModelPermissionPolicy: string
	navigateToAccount: () => void
	setShowWelcome: (show: boolean) => void
	availableTerminalProfiles: any[]
	refreshTerminalProfiles: () => void
	openRouterModels: any
	refreshOpenRouterModels: () => void
	openRouterModelRankings: string[]
	refreshOpenRouterModelRankings: () => void
	openRouterEndpointStates: Record<string, OpenRouterEndpointState>
	fetchOpenRouterEndpoints: (modelId: string, forceRefresh?: boolean) => Promise<void>
	refreshBasetenModels: () => void
	refreshGroqModels: () => void
	refreshHuggingFaceModels: () => void
	refreshRequestyModels: () => void
	vercelAiGatewayModels: any
	refreshVercelAiGatewayModels: () => void
	liteLlmModels: any
	refreshLiteLlmModels: () => void
	basetenModels: any
	groqModels: any
	huggingFaceModels: any
	requestyModels: any
	openAiModels: any
	refreshOpenAiModels: (baseUrl: string, apiKey: string) => Promise<void>
	githubCopilotModels: any
	githubCopilotIsAuthenticated: boolean
	githubCopilotEmail?: string
	unbiasedWorkloadName?: string | null
	openAiCodexIsAuthenticated: boolean
	openAiCodexEmail?: string
	openAiCodexUsage?: OpenAiCodexUsageSnapshot
	openAiCodexUsageRefreshing: boolean
	openAiCodexUsageRefreshError?: string
	refreshOpenAiCodexUsage: (force?: boolean) => Promise<void>
	autoApprovalSettings: ExtensionState["autoApprovalSettings"]
	userApprovedCommands: ExtensionState["userApprovedCommands"]
	browserSettings: ExtensionState["browserSettings"]
	preferredLanguage: string
	mode: string
	platform: string
	environment: Environment
	telemetrySetting: string
	distinctId: string
	planActSeparateModelsSetting: boolean
	enableCheckpointsSetting: boolean
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	vscodeTerminalExecutionMode: string
	terminalOutputLineLimit: number
	maxConsecutiveMistakes: number
	defaultTerminalProfile: string
	isNewUser: boolean
	welcomeViewCompleted: boolean
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	autoApproveAllToggled: boolean
	pendingAutoApproveAllToggled?: boolean
	autoApproveAllUpdateError?: string
	customPrompt?: string
	useAutoCondense: boolean
	autoCondenseContextLimits: Record<string, number>
	subagentsEnabled: boolean
	diracWebToolsEnabled: { user: boolean; featureFlag: boolean }
	worktreesEnabled: { user: boolean; featureFlag: boolean }
	favoritedModelIds: string[]
	lastDismissedInfoBannerVersion: number
	lastDismissedModelBannerVersion: number
	optOutOfRemoteConfig: boolean
	remoteConfigSettings: Record<string, any>
	backgroundCommandRunning: boolean
	backgroundCommandTaskId?: string
	lastDismissedCliBannerVersion: number
	backgroundEditEnabled: boolean
	doubleCheckCompletionEnabled: boolean
	lowVerbosityEnabled: boolean

	// Toggles
	globalDiracRulesToggles: Record<string, boolean>
	localDiracRulesToggles: Record<string, boolean>
	localCursorRulesToggles: Record<string, boolean>
	localWindsurfRulesToggles: Record<string, boolean>
	localAgentsRulesToggles: Record<string, boolean>
	localWorkflowToggles: Record<string, boolean>
	globalWorkflowToggles: Record<string, boolean>
	availableSkills: SkillMetadata[]
	availableTools: ToolMetadata[]
	toolToggles: Record<string, boolean>
	globalSkillsToggles: Record<string, boolean>
	localSkillsToggles: Record<string, boolean>
	remoteRulesToggles: Record<string, boolean>
	remoteWorkflowToggles: Record<string, boolean>

	// Workspace
	workspaceRoots: any[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	multiRootSetting: { user: boolean; featureFlag: boolean }
	hooksEnabled: boolean
	triggerNativeToolCall: boolean
	enableParallelToolCalling: boolean
	writePromptMetadataEnabled: boolean
	writePromptMetadataDirectory?: string

	// Chat & History (Moved from other stores)
	diracMessages: DiracMessage[]
	taskHistory: any[]
	currentTaskItem?: any
	checkpointManagerErrorMessage?: string
	expandTaskHeader: boolean
	totalTasksSize: number
	dismissedBanners: any[]
	banners: any[]
	welcomeBanners: any[]

	// Navigation Actions
	onRelinquishControl: (callback: () => void) => () => void

	// Actions
	setSettings: (settings: Partial<SettingsState>) => void
	beginAutoApproveAllUpdate: (value: boolean) => void
	finishAutoApproveAllUpdate: (value: boolean, error?: string) => void
	setDiracMessages: (messages: DiracMessage[]) => void
	setTaskHistory: (history: any[]) => void
	setExpandTaskHeader: (expand: boolean) => void
	setTotalTasksSize: (size: number) => void
	setGlobalDiracRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalDiracRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCursorRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWindsurfRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalAgentsRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalSkillsToggles: (toggles: Record<string, boolean>) => void
	setLocalSkillsToggles: (toggles: Record<string, boolean>) => void
	setRemoteRulesToggles: (toggles: Record<string, boolean>) => void
	setRemoteWorkflowToggles: (toggles: Record<string, boolean>) => void
	setAvailableTools: (tools: ToolMetadata[]) => void
	setToolToggles: (toggles: Record<string, boolean>) => void
	setGroqModels: (models: any) => void
	setHuggingFaceModels: (models: any) => void
	setRequestyModels: (models: any) => void
}

let openAiCodexUsageRefreshGeneration = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
	autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	userApprovedCommands: [],
	browserSettings: DEFAULT_BROWSER_SETTINGS,
	preferredLanguage: "English",
	mode: "act",
	platform: DEFAULT_PLATFORM,
	environment: Environment.production,
	telemetrySetting: "unset",
	distinctId: "",
	planActSeparateModelsSetting: false,
	enableCheckpointsSetting: true,
	shellIntegrationTimeout: 4000,
	terminalReuseEnabled: true,
	vscodeTerminalExecutionMode: "vscodeTerminal",
	terminalOutputLineLimit: 500,
	maxConsecutiveMistakes: 3,
	defaultTerminalProfile: "default",
	isNewUser: false,
	welcomeViewCompleted: false,
	strictPlanModeEnabled: false,
	yoloModeToggled: false,
	autoApproveAllToggled: false,
	pendingAutoApproveAllToggled: undefined,
	autoApproveAllUpdateError: undefined,
	customPrompt: undefined,
	useAutoCondense: false,
	autoCondenseContextLimits: {},
	subagentsEnabled: false,
	diracWebToolsEnabled: { user: true, featureFlag: false },
	worktreesEnabled: { user: true, featureFlag: false },
	favoritedModelIds: [],
	lastDismissedInfoBannerVersion: 0,
	lastDismissedModelBannerVersion: 0,
	optOutOfRemoteConfig: false,
	remoteConfigSettings: {},
	backgroundCommandRunning: false,
	backgroundCommandTaskId: undefined,
	lastDismissedCliBannerVersion: 0,
	backgroundEditEnabled: false,
	doubleCheckCompletionEnabled: false,
	lowVerbosityEnabled: true,

	globalDiracRulesToggles: {},
	localDiracRulesToggles: {},
	localCursorRulesToggles: {},
	localWindsurfRulesToggles: {},
	localAgentsRulesToggles: {},
	localWorkflowToggles: {},
	globalWorkflowToggles: {},
	availableSkills: [],
	availableTools: [],
	toolToggles: {},
	globalSkillsToggles: {},
	localSkillsToggles: {},
	assertion: {},
	remoteRulesToggles: {},
	remoteWorkflowToggles: {},

	workspaceRoots: [],
	primaryRootIndex: 0,
	isMultiRootWorkspace: false,
	multiRootSetting: { user: false, featureFlag: false },
	hooksEnabled: false,
	enableParallelToolCalling: false,
	writePromptMetadataEnabled: false,
	writePromptMetadataDirectory: undefined,

	version: "0.0.0",
	apiConfiguration: {},
	apiConfigurationError: undefined,
	pendingApiConfigurationUpdates: {},
	modelProviderPresets: [],
	utilityModelEnabled: false,
	utilityModelSelection: undefined,
	utilityModelUseCondense: true,
	utilityModelUseNewTask: true,
	utilityModelUseGenerateCommitMessage: true,
	utilityModelUsePermissionHandling: false,
	utilityModelPermissionPolicy: "",
	navigateToAccount: () => { },
	setShowWelcome: () => { },
	availableTerminalProfiles: [],

	refreshTerminalProfiles: async () => {
		try {
			const response = await StateServiceClient.getAvailableTerminalProfiles(EmptyRequest.create())
			set({
				availableTerminalProfiles: response.profiles || [],
			})
		} catch (error) {
			console.error("Failed to refresh terminal profiles:", error)
		}
	},
	openRouterModels: {},
	openRouterModelRankings: [],
	openRouterEndpointStates: {},
	fetchOpenRouterEndpoints: async (modelId, forceRefresh = false) => {
		const current = get().openRouterEndpointStates[modelId]
		set((state) => ({
			openRouterEndpointStates: {
				...state.openRouterEndpointStates,
				[modelId]: { status: "loading", endpoints: current?.endpoints || [] },
			},
		}))

		try {
			const response = await ModelsServiceClient.getOpenRouterEndpoints(
				OpenRouterEndpointsRequest.create({ modelId, forceRefresh }),
			)
			const status =
				response.status === OpenRouterEndpointsStatus.OPENROUTER_ENDPOINTS_STATUS_FRESH
					? "fresh"
					: response.status === OpenRouterEndpointsStatus.OPENROUTER_ENDPOINTS_STATUS_STALE
						? "stale"
						: "unavailable"
			set((state) => ({
				openRouterEndpointStates: {
					...state.openRouterEndpointStates,
					[modelId]: {
						status,
						endpoints: response.endpoints,
						errorMessage: response.errorMessage || undefined,
					},
				},
			}))
		} catch (error) {
			const endpoints = current?.endpoints || []
			set((state) => ({
				openRouterEndpointStates: {
					...state.openRouterEndpointStates,
					[modelId]: {
						status: endpoints.length > 0 ? "stale" : "unavailable",
						endpoints,
						errorMessage: error instanceof Error ? error.message : "Endpoint metadata is unavailable",
					},
				},
			}))
		}
	},
	refreshOpenRouterModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshOpenRouterModelsRpc(EmptyRequest.create())
			set({
				openRouterModels: fromProtobufModels(response.models),
			})
		} catch (error) {
			console.error("Failed to refresh OpenRouter models:", error)
		}
	},
	refreshOpenRouterModelRankings: async () => {
		try {
			const response = await ModelsServiceClient.fetchOpenRouterModelRankings(EmptyRequest.create())
			set({ openRouterModelRankings: response.values })
		} catch {
			set({ openRouterModelRankings: [] })
		}
	},
	refreshOpenAiModels: async (baseUrl: string, apiKey: string) => {
		try {
			const response = await ModelsServiceClient.refreshOpenAiModels(
				OpenAiModelsRequest.create({
					baseUrl,
					apiKey,
				}),
			)
			if (response?.values) {
				const models: Record<string, ModelInfo> = {}
				response.values.forEach((id) => {
					models[id] = {
						...openAiModelInfoSaneDefaults,
					}
				})
				set({ openAiModels: models })
			}
		} catch (error) {
			console.error("Failed to refresh OpenAI models:", error)
		}
	},
	like: {},
	vercelAiGatewayModels: {},
	refreshVercelAiGatewayModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshVercelAiGatewayModelsRpc(EmptyRequest.create())
			set({
				vercelAiGatewayModels: fromProtobufModels(response.models),
			})
		} catch (error) {
			console.error("Failed to refresh Vercel AI Gateway models:", error)
		}
	},
	prototype: {},
	liteLlmModels: {},
	refreshLiteLlmModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshLiteLlmModelsRpc(EmptyRequest.create())
			set({
				liteLlmModels: {
					"": liteLlmModelInfoSaneDefaults,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh LiteLLM models:", error)
		}
	},
	basetenModels: {
		...basetenModels,
		[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
	},
	groqModels: {
		[groqDefaultModelId]: groqModels[groqDefaultModelId],
	},
	huggingFaceModels: {},
	requestyModels: {
		[requestyDefaultModelId]: requestyDefaultModelInfo,
	},
	githubCopilotModels: {},
	openAiModels: {},
	githubCopilotIsAuthenticated: false,
	githubCopilotEmail: undefined,
	unbiasedWorkloadName: null,
	openAiCodexIsAuthenticated: false,
	openAiCodexEmail: undefined,
	openAiCodexUsage: undefined,
	openAiCodexUsageRefreshing: false,
	openAiCodexUsageRefreshError: undefined,
	refreshOpenAiCodexUsage: async (force = false) => {
		const current = get()
		if (current.openAiCodexUsageRefreshing) return

		const now = Date.now()
		const quotaFetchedAt = current.openAiCodexUsage?.quotaFetchedAt ?? 0
		const activityFetchedAt = current.openAiCodexUsage?.activityFetchedAt ?? 0
		const quotaIsFresh = quotaFetchedAt > 0 && now - quotaFetchedAt < 60_000
		const activityIsFresh = activityFetchedAt > 0 && now - activityFetchedAt < 60_000
		if (!force && quotaIsFresh && activityIsFresh) return

		const refreshGeneration = openAiCodexUsageRefreshGeneration
		set({ openAiCodexUsageRefreshing: true, openAiCodexUsageRefreshError: undefined })
		try {
			const response = await ModelsServiceClient.refreshOpenAiCodexUsage(EmptyRequest.create({}))
			if (refreshGeneration !== openAiCodexUsageRefreshGeneration) return
			set({
				openAiCodexUsage: fromProtobufOpenAiCodexUsage(response),
				openAiCodexUsageRefreshError: undefined,
			})
		} catch (error) {
			if (refreshGeneration !== openAiCodexUsageRefreshGeneration) return
			set({
				openAiCodexUsageRefreshError:
					error instanceof Error ? error.message : "ChatGPT usage is temporarily unavailable",
			})
		} finally {
			if (refreshGeneration === openAiCodexUsageRefreshGeneration) {
				set({ openAiCodexUsageRefreshing: false })
			}
		}
	},

	triggerNativeToolCall: false,
	diracMessages: [],
	taskHistory: [],
	currentTaskItem: undefined,
	checkpointManagerErrorMessage: undefined,
	expandTaskHeader: false,
	totalTasksSize: 0,
	dismissedBanners: [],
	banners: [],
	welcomeBanners: [],
	onRelinquishControl: () => () => { },
	setDiracMessages: (messages) => set({ diracMessages: messages }),
	setTaskHistory: (history) => set({ taskHistory: history }),
	setExpandTaskHeader: (expand) => set({ expandTaskHeader: expand }),
	setTotalTasksSize: (size) => set({ totalTasksSize: size }),
	setGlobalDiracRulesToggles: (toggles) => set({ globalDiracRulesToggles: toggles }),
	setLocalDiracRulesToggles: (toggles) => set({ localDiracRulesToggles: toggles }),
	setLocalCursorRulesToggles: (toggles) => set({ localCursorRulesToggles: toggles }),
	setLocalWindsurfRulesToggles: (toggles) => set({ localWindsurfRulesToggles: toggles }),
	setLocalAgentsRulesToggles: (toggles) => set({ localAgentsRulesToggles: toggles }),
	setLocalWorkflowToggles: (toggles) => set({ localWorkflowToggles: toggles }),
	setGlobalWorkflowToggles: (toggles) => set({ globalWorkflowToggles: toggles }),
	setGlobalSkillsToggles: (toggles) => set({ globalSkillsToggles: toggles }),
	setLocalSkillsToggles: (toggles) => set({ localSkillsToggles: toggles }),
	setRemoteRulesToggles: (toggles) => set({ remoteRulesToggles: toggles }),
	setRemoteWorkflowToggles: (toggles) => set({ remoteWorkflowToggles: toggles }),
	setAvailableTools: (tools: ToolMetadata[]) => set({ availableTools: tools }),
	setToolToggles: (toggles: Record<string, boolean>) => set({ toolToggles: toggles }),
	setGroqModels: (models) => set({ groqModels: models }),
	setHuggingFaceModels: (models) => set({ huggingFaceModels: models }),
	setRequestyModels: (models) => set({ requestyModels: models }),
	refreshBasetenModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshBasetenModelsRpc(EmptyRequest.create())
			set({
				basetenModels: {
					...basetenModels,
					[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Baseten models:", error)
		}
	},
	refreshGroqModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshGroqModelsRpc(EmptyRequest.create())
			set({
				groqModels: {
					[groqDefaultModelId]: groqModels[groqDefaultModelId],
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Groq models:", error)
		}
	},
	refreshHuggingFaceModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshHuggingFaceModels(EmptyRequest.create())
			set({ huggingFaceModels: fromProtobufModels(response.models) })
		} catch (error) {
			console.error("Failed to refresh HuggingFace models:", error)
		}
	},
	refreshRequestyModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshRequestyModels(EmptyRequest.create())
			set({
				requestyModels: {
					[requestyDefaultModelId]: requestyDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Requesty models:", error)
		}
	},
	beginAutoApproveAllUpdate: (value) =>
		set({
			autoApproveAllToggled: value,
			pendingAutoApproveAllToggled: value,
			autoApproveAllUpdateError: undefined,
		}),
	finishAutoApproveAllUpdate: (value, error) =>
		set({
			autoApproveAllToggled: value,
			pendingAutoApproveAllToggled: undefined,
			autoApproveAllUpdateError: error,
		}),

	setSettings: (settings) =>
		set((state) => {
			const pendingApiConfigurationUpdates = settings.pendingApiConfigurationUpdates ?? state.pendingApiConfigurationUpdates
			const autoApproveAllToggled =
				state.pendingAutoApproveAllToggled === undefined
					? (settings.autoApproveAllToggled ?? state.autoApproveAllToggled)
					: state.autoApproveAllToggled
			const didSignOutFromOpenAiCodex = settings.openAiCodexIsAuthenticated === false
			const openAiCodexAccountChanged =
				settings.openAiCodexEmail !== undefined &&
				state.openAiCodexEmail !== undefined &&
				settings.openAiCodexEmail !== state.openAiCodexEmail
			const hasIncomingOpenAiCodexUsage = settings.openAiCodexUsage !== undefined
			const shouldClearOpenAiCodexUsage =
				didSignOutFromOpenAiCodex || (openAiCodexAccountChanged && !hasIncomingOpenAiCodexUsage)
			if (didSignOutFromOpenAiCodex || openAiCodexAccountChanged) openAiCodexUsageRefreshGeneration += 1
			return {
				...state,
				...settings,
				...(shouldClearOpenAiCodexUsage
					? {
						...(didSignOutFromOpenAiCodex ? { openAiCodexEmail: undefined } : {}),
						openAiCodexUsage: undefined,
						openAiCodexUsageRefreshError: undefined,
						openAiCodexUsageRefreshing: false,
					}
					: {}),
				pendingApiConfigurationUpdates,
				autoApproveAllToggled,
				apiConfiguration:
					settings.apiConfiguration !== undefined
						? { ...settings.apiConfiguration, ...pendingApiConfigurationUpdates }
						: state.apiConfiguration,
			}
		}),
}))
