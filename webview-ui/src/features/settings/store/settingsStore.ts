import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { Environment } from "@shared/config-types"
import type { DiracMessage, ExtensionState } from "@shared/ExtensionMessage"
import { SkillMetadata } from "@shared/skills"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { DEFAULT_PLATFORM } from "@shared/ExtensionMessage"
import {
	basetenDefaultModelId,
	basetenModels,
	groqDefaultModelId,
	groqModels,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
	liteLlmModelInfoSaneDefaults,
	openAiModelInfoSaneDefaults,
	ModelInfo,
	type ApiConfiguration,
} from "@shared/api"
import type { ModelProviderPreset } from "@shared/api"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import { OpenAiModelsRequest } from "@shared/proto/dirac/models"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { ModelsServiceClient, StateServiceClient } from "@/shared/api/grpc-client"
import { create } from "zustand"

interface SettingsState {
	version: string
	apiConfiguration: any
	apiConfigurationError?: string
	pendingApiConfigurationUpdates: Partial<ApiConfiguration>
	modelProviderPresets: ModelProviderPreset[]
	navigateToAccount: () => void
	setShowWelcome: (show: boolean) => void
	availableTerminalProfiles: any[]
	refreshTerminalProfiles: () => void
	diracModels: any
	refreshDiracModels: () => void
	openRouterModels: any
	refreshOpenRouterModels: () => void
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
	openAiCodexIsAuthenticated: boolean
	openAiCodexEmail?: string
	autoApprovalSettings: ExtensionState["autoApprovalSettings"]
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
	customPrompt?: string
	useAutoCondense: boolean
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
	navigateToSettings: (section?: string) => void
	navigateToSettingsModelPicker: (options: { targetSection?: string }) => void
	navigateToHistory: () => void
	navigateToChat: () => void
	navigateToWorktrees: () => void
	onRelinquishControl: (callback: () => void) => () => void

	// Actions
	setSettings: (settings: Partial<SettingsState>) => void
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

export const useSettingsStore = create<SettingsState>((set) => ({
	autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
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
	customPrompt: undefined,
	useAutoCondense: false,
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
	navigateToAccount: () => {},
	setShowWelcome: () => {},
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
	diracModels: {},
	refreshDiracModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshDiracModelsRpc(EmptyRequest.create())
			set({
				diracModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Dirac models:", error)
		}
	},
	openRouterModels: {
		[openRouterDefaultModelId]: openRouterDefaultModelInfo,
	},
	refreshOpenRouterModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshOpenRouterModelsRpc(EmptyRequest.create())
			set({
				openRouterModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh OpenRouter models:", error)
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
				vercelAiGatewayModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
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
	openAiCodexIsAuthenticated: false,
	openAiCodexEmail: undefined,

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
	navigateToSettings: () => {},
	navigateToSettingsModelPicker: () => {},
	navigateToHistory: () => {},
	navigateToChat: () => {},
	navigateToWorktrees: () => {},
	onRelinquishControl: () => () => {},
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
	setSettings: (settings) =>
		set((state) => {
			const pendingApiConfigurationUpdates = settings.pendingApiConfigurationUpdates ?? state.pendingApiConfigurationUpdates
			return {
				...state,
				...settings,
				pendingApiConfigurationUpdates,
				apiConfiguration:
					settings.apiConfiguration !== undefined
						? { ...settings.apiConfiguration, ...pendingApiConfigurationUpdates }
						: state.apiConfiguration,
			}
		}),
}))
