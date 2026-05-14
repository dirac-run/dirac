/**
 * DiracAgent - Decoupled ACP Agent implementation for Dirac CLI.
 *
 * This class implements the ACP (Agent Client Protocol) Agent interface,
 * allowing Dirac to be used programmatically without stdio dependency.
 * It uses a callback pattern for permission requests and EventEmitters
 * for session updates, enabling embedding in other Node.js applications.
 *
 * For stdio-based ACP communication, use the AcpAgent wrapper class.
 *
 * @module acp
 */

import type * as acp from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { DiracMessageChange } from "@core/task/message-state"
import type { ApiProvider } from "@shared/api"
import type { DiracAsk, DiracMessage as DiracMessageType } from "@shared/ExtensionMessage"
import { CLI_ONLY_COMMANDS, VSCODE_ONLY_COMMANDS } from "@shared/slashCommands"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { DiracEndpoint } from "@/config.js"
import { Controller } from "@/core/controller"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { setRuntimeHooksDir } from "@/core/storage/disk"
import { StateManager } from "@/core/storage/StateManager"
import { AuthHandler } from "@/hosts/external/AuthHandler.js"
import { ExternalCommentReviewController } from "@/hosts/external/ExternalCommentReviewController.js"
import { ExternalDiracWebviewProvider } from "@/hosts/external/ExternalWebviewProvider.js"
import { HostProvider } from "@/hosts/host-provider.js"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { StandaloneTerminalManager } from "@/integrations/terminal/index.js"
import { Logger } from "@/shared/services/Logger.js"
import type { Mode } from "@/shared/storage/types"
import { version as AGENT_VERSION } from "../../package.json"
import { ACPDiffViewProvider } from "../acp/ACPDiffViewProvider.js"
import { ACPHostBridgeClientProvider } from "../acp/ACPHostBridgeClientProvider.js"
import { AcpTerminalManager } from "../acp/AcpTerminalManager.js"
import { refreshGithubCopilotModels } from "@/core/controller/models/refreshGithubCopilotModels"
import { filterOpenRouterModelIds } from "@/shared/utils/model-filters"
import { getDefaultModelId, getModelList, hasStaticModels } from "../utils/model-metadata.js"
import { fetchOpenRouterModels, usesOpenRouterModels } from "../utils/openrouter-models"
import { getProviderLabel, getValidCliProviders, isValidCliProvider } from "../utils/providers.js"
import { CliContextResult, initializeCliContext } from "../vscode-context.js"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { translateMessage } from "./messageTranslator.js"
import { handlePermissionResponse } from "./permissionHandler.js"
import type { DiracAcpSession, DiracAgentOptions, PermissionHandler } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { type AcpSessionState } from "./types.js"

const ACP_MODE_OPTIONS: acp.SessionConfigSelectOption[] = [
	{ value: "plan", name: "Plan", description: "Gather information and create a detailed plan" },
	{ value: "act", name: "Act", description: "Execute actions to accomplish the task" },
]

const REASONING_EFFORT_OPTIONS: acp.SessionConfigSelectOption[] = [
	{ value: "none", name: "None" },
	{ value: "low", name: "Low" },
	{ value: "medium", name: "Medium" },
	{ value: "high", name: "High" },
	{ value: "xhigh", name: "Extra high" },
]

const THINKING_BUDGET_OPTIONS: acp.SessionConfigSelectOption[] = [
	{ value: "0", name: "Off" },
	{ value: "1024", name: "1,024 tokens" },
	{ value: "4096", name: "4,096 tokens" },
	{ value: "8192", name: "8,192 tokens" },
	{ value: "16384", name: "16,384 tokens" },
	{ value: "32768", name: "32,768 tokens" },
]

/**
 * Dirac's implementation of the ACP Agent interface.
 *
 * This agent bridges the ACP protocol with Dirac's core Controller,
 * translating ACP requests into Controller operations and emitting
 * session updates via EventEmitters.
 *
 * This class is decoupled from the stdio connection, enabling:
 * - Programmatic usage without stdio dependency
 * - Running multiple concurrent sessions
 * - Handling ACP events via EventEmitter pattern
 *
 * For stdio-based ACP communication, use the AcpAgent wrapper class.
 */
export class DiracAgent implements acp.Agent {
	async shutdown() {
		for (const session of this.sessions.values()) {
			const controller = this.#sessionControllers.get(session)
			if (controller) {
				await controller.dispose()
			}
		}
		this.sessions.clear()
		this.sessionStates.clear()
		this.sessionEmitters.clear()
	}
	private readonly options: DiracAgentOptions
	private readonly ctx: CliContextResult

	/** Map of active sessions by session ID */
	public readonly sessions: Map<string, DiracAcpSession> = new Map()

	/** WeakMap to associate DiracAcpSession with its Controller without exposing it to consumers */
	readonly #sessionControllers = new WeakMap<DiracAcpSession, Controller>()

	/** Runtime state for active sessions */
	private readonly sessionStates: Map<string, AcpSessionState> = new Map()

	/** Per-session event emitters for session updates */
	private readonly sessionEmitters: Map<string, DiracSessionEmitter> = new Map()

	/** Permission handler callback for requesting user permission */
	private permissionHandler?: PermissionHandler

	/** Client capabilities received during initialization */
	private clientCapabilities?: acp.ClientCapabilities

	/** Track last sent content for partial messages to compute deltas */
	private partialMessageLastContent: Map<number, string> = new Map()

	/** Map message timestamps to toolCallIds to avoid creating duplicate tool calls during streaming */
	private messageToToolCallId: Map<number, string> = new Map()

	/** Current active session ID for use by DiffViewProvider */
	private currentActiveSessionId: string | undefined

	/** Shared WebviewProvider instance for auth and other operations */
	private webviewProvider: ReturnType<typeof HostProvider.get.prototype.createWebviewProvider> | undefined

	constructor(options: DiracAgentOptions) {
		this.options = options
		setRuntimeHooksDir(options.hooksDir)
		this.ctx = initializeCliContext({ diracDir: options.diracDir, workspaceDir: options.cwd })
	}

	/**
	 * Set the permission handler callback.
	 *
	 * This handler is called when the agent needs permission for a tool call.
	 * The handler should present the request to the user and call the resolve
	 * callback with their response.
	 *
	 * @param handler - The permission handler callback
	 */
	setPermissionHandler(handler: PermissionHandler): void {
		this.permissionHandler = handler
	}

	private async requestPermission(
		sessionId: string,
		toolCall: any,
		options?: acp.PermissionOption[],
	): Promise<acp.RequestPermissionResponse> {
		if (!this.permissionHandler) {
			throw new Error("Permission handler not set")
		}
		return new Promise((resolve) => {
			this.permissionHandler!({ sessionId, toolCall, options: options || [] }, resolve)
		})
	}

	/**
	 * Get the event emitter for a session.
	 *
	 * Use this to subscribe to session events like agent_message_chunk,
	 * tool_call, etc.
	 *
	 * @param sessionId - The session ID
	 * @returns The session's event emitter
	 */
	emitterForSession(sessionId: string): DiracSessionEmitter {
		let emitter = this.sessionEmitters.get(sessionId)
		if (!emitter) {
			emitter = new DiracSessionEmitter()
			this.sessionEmitters.set(sessionId, emitter)
		}
		return emitter
	}

	/**
	 * Initialize the agent and return its capabilities.
	 *
	 * This is the first method called by the client after establishing
	 * the connection. The agent returns its protocol version and capabilities.
	 */
	async initialize(params: acp.InitializeRequest, connection?: acp.AgentSideConnection): Promise<acp.InitializeResponse> {
		this.clientCapabilities = params.clientCapabilities
		this.initializeHostProvider(this.clientCapabilities, connection)
		await DiracEndpoint.initialize(this.ctx.EXTENSION_DIR)
		await StateManager.initialize(this.ctx.storageContext)

		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: {
					image: true,
					audio: false,
					embeddedContext: true,
				},
			},
			agentInfo: {
				name: "dirac",
				version: AGENT_VERSION,
			},
			authMethods: [
				{
					id: "openai-codex-oauth",
					name: "Sign in with ChatGPT",
					description: "Authenticate with your ChatGPT Plus/Pro/Team subscription",
				},
			],
		}
	}

	/**
	 * Initialize the host provider with optional connection for ACP mode.
	 *
	 * When used with the AcpAgent wrapper, a connection is provided for
	 * host bridge operations. When used programmatically, connection is
	 * undefined and standalone providers are used.
	 *
	 * @param clientCapabilities - Client capabilities from initialization
	 * @param connection - Optional ACP connection for host bridge operations
	 */
	initializeHostProvider(clientCapabilities?: acp.ClientCapabilities, connection?: acp.AgentSideConnection): void {
		const hostBridgeClientProvider = new ACPHostBridgeClientProvider(
			clientCapabilities,
			() => this.currentActiveSessionId,
			() => this.sessions.get(this.currentActiveSessionId ?? "")?.cwd ?? process.cwd(),
			AGENT_VERSION,
		)

		HostProvider.initialize(
			"cli",
			() => new ExternalDiracWebviewProvider(this.ctx.extensionContext),
			() => {
				if (clientCapabilities?.fs && connection) {
					return new ACPDiffViewProvider(connection, clientCapabilities, () => this.currentActiveSessionId)
				}
				// Fallback for programmatic use
				return new FileEditProvider()
			},
			() => new ExternalCommentReviewController(),
			() => {
				if (clientCapabilities?.terminal && connection) {
					return new AcpTerminalManager(connection, clientCapabilities, () => this.currentActiveSessionId)
				}
				// Fallback for programmatic use
				return new StandaloneTerminalManager()
			},
			hostBridgeClientProvider,
			(message: string) => Logger.info(message),
			async (path: string) => {
				return AuthHandler.getInstance().getCallbackUrl(path)
			},
			async () => "", // get binary location not needed in ACP mode
			this.ctx.EXTENSION_DIR,
			this.ctx.DATA_DIR,
			async (_cwd: string) => undefined
		)
	}

	/**
	 * Create a new session.
	 *
	 * A session represents a conversation/task with the agent. The client
	 * provides the working directory.
	 */
	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const sessionId = crypto.randomUUID()

		Logger.debug("[DiracAgent] newSession called:", {
			sessionId,
			cwd: params.cwd,
		})

		// Create Controller for this session
		const controller = new Controller(this.ctx.extensionContext)

		// Create session record with all resources
		const session: DiracAcpSession = {
			sessionId,
			cwd: params.cwd,
			mode: (await controller.getStateToPostToWebview()).mode,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		}

		this.#sessionControllers.set(session, controller)

		this.sessions.set(sessionId, session)

		// Initialize session state
		const sessionState: AcpSessionState = {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		}

		this.sessionStates.set(sessionId, sessionState)

		// Get current model configuration for the response
		const modelState = await this.getSessionModelState(session.mode)
		const configOptions = await this.getSessionConfigOptions(session)

		return {
			sessionId,
			modes: this.getSessionModeState(session.mode),
			models: modelState,
			configOptions,
		}
	}

	/**
	 * Load an existing session from task history.
	 *
	 * The ACP LoadSessionRequest sessionId is treated as the historical task ID.
	 * The task is rehydrated lazily on first prompt to align with the ACP flow.
	 */
	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		const sessionId = params.sessionId
		const existingSession = this.sessions.get(sessionId)
		if (existingSession) {
			const modelState = await this.getSessionModelState(existingSession.mode)
			const configOptions = await this.getSessionConfigOptions(existingSession)
			return {
				modes: this.getSessionModeState(existingSession.mode),
				models: modelState,
				configOptions,
			}
		}

		Logger.debug("[DiracAgent] loadSession called:", { sessionId })

		const controller = new Controller(this.ctx.extensionContext)
		const history = await controller.getTaskWithId(sessionId)
		const historyCwd =
			history.historyItem.cwdOnTaskInitialization || history.historyItem.workspaceRootPath || params.cwd || this.options.cwd

		const session: DiracAcpSession = {
			sessionId,
			cwd: historyCwd || process.cwd(),
			mode: (await controller.getStateToPostToWebview()).mode,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			isLoadedFromHistory: true,
		}

		this.#sessionControllers.set(session, controller)
		this.sessions.set(sessionId, session)
		this.sessionStates.set(sessionId, {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		})

		const modelState = await this.getSessionModelState(session.mode)
		const configOptions = await this.getSessionConfigOptions(session)
		return {
			modes: this.getSessionModeState(session.mode),
			models: modelState,
			configOptions,
		}
	}

	/**
	 * Emit initial session updates that must happen after the ACP stdio wrapper
	 * has registered and subscribed to the session.
	 */
	async publishSessionSetupUpdates(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}

		const controller = this.#sessionControllers.get(session)
		if (!controller) {
			throw new Error("Controller not initialized for session. This is a bug in the ACP agent setup.")
		}

		await this.sendAvailableCommands(sessionId, controller)
		await this.emitConfigOptionsUpdate(sessionId)
	}

	private getSessionModeState(mode: Mode): acp.SessionModeState {
		return {
			availableModes: ACP_MODE_OPTIONS.map(({ value, name, description }) => ({
				id: value,
				name,
				description,
			})),
			currentModeId: mode,
		}
	}

	/**
	 * Get the current model state for ACP responses.
	 * Returns available models and the current model ID based on the session mode.
	 */
	private async getSessionModelState(mode: Mode): Promise<acp.SessionModelState> {
		const stateManager = StateManager.get()

		// Get current provider and model for the mode
		const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
		const currentProvider = stateManager.getGlobalSettingsKey(providerKey) as ApiProvider | undefined

		// Use provider-specific model ID key (e.g., dirac uses actModeOpenRouterModelId)
		const modelKey = currentProvider ? getProviderModelIdKey(currentProvider, mode) : null
		const currentModelId =
			((modelKey ? stateManager.getGlobalSettingsKey(modelKey) : undefined) as string | undefined) ||
			(currentProvider ? getDefaultModelId(currentProvider) : undefined)

		// Build the current model ID in provider/model format
		const currentFullModelId =
			currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : currentProvider || ""

		// Get available models based on provider
		let modelIds: string[] = []

		if (currentProvider) {
			if (usesOpenRouterModels(currentProvider)) {
				// Fetch OpenRouter models (async)
				modelIds = filterOpenRouterModelIds(await fetchOpenRouterModels(), currentProvider)
			} else if (currentProvider === "github-copilot") {
				modelIds = Object.keys(await refreshGithubCopilotModels()).sort((a, b) => a.localeCompare(b))
			} else if (hasStaticModels(currentProvider)) {
				// Use static model list
				modelIds = getModelList(currentProvider)
			}
		}

		if (currentModelId && !modelIds.includes(currentModelId)) {
			modelIds = [currentModelId, ...modelIds]
		}

		// Convert to ACP ModelInfo format with provider prefix
		const availableModels: acp.ModelInfo[] = modelIds.map((modelId) => ({
			modelId: currentProvider ? `${currentProvider}/${modelId}` : modelId,
			name: modelId,
		}))

		return {
			currentModelId: currentFullModelId,
			availableModels,
		}
	}

	private async getSessionConfigOptions(session: DiracAcpSession): Promise<acp.SessionConfigOption[]> {
		const stateManager = StateManager.get()
		const currentProvider = stateManager.getGlobalSettingsKey(
			session.mode === "act" ? "actModeApiProvider" : "planModeApiProvider",
		) as ApiProvider | undefined
		const currentModelId = await this.getCurrentModeModelId(session.mode, currentProvider)
		const thinkingBudget = String(
			stateManager.getGlobalSettingsKey(
				session.mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens",
			) ?? 0,
		)
		const reasoningEffort = String(
			stateManager.getGlobalSettingsKey(session.mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort") ??
				"medium",
		)

		return [
			{
				id: "mode",
				name: "Mode",
				description: "Session operating mode",
				type: "select",
				category: "mode",
				currentValue: session.mode,
				options: ACP_MODE_OPTIONS,
			},
			{
				id: "provider",
				name: "Provider",
				description: "API provider",
				type: "select",
				category: "model",
				currentValue: currentProvider || "",
				options: getValidCliProviders().map((provider) => ({
					value: provider,
					name: getProviderLabel(provider),
				})),
			},
			{
				id: "model",
				name: "Model",
				description: "Model for the current mode",
				type: "select",
				category: "model",
				currentValue: currentModelId || "",
				options: await this.getModelConfigOptions(currentProvider, currentModelId),
			},
			{
				id: "reasoning_effort",
				name: "Reasoning Effort",
				description: "Reasoning effort for models that support it",
				type: "select",
				category: "thought_level",
				currentValue: reasoningEffort,
				options: REASONING_EFFORT_OPTIONS,
			},
			{
				id: "thinking_budget",
				name: "Thinking Budget",
				description: "Extended thinking budget for models that support it",
				type: "select",
				category: "thought_level",
				currentValue: thinkingBudget,
				options: this.withCurrentSelectOption(THINKING_BUDGET_OPTIONS, thinkingBudget, `${thinkingBudget} tokens`),
			},
		]
	}

	private async getCurrentModeModelId(mode: Mode, provider?: ApiProvider): Promise<string> {
		if (!provider) return ""
		const modelKey = getProviderModelIdKey(provider, mode)
		return (StateManager.get().getGlobalSettingsKey(modelKey) as string | undefined) || getDefaultModelId(provider)
	}

	private async getModelConfigOptions(
		provider: ApiProvider | undefined,
		currentModelId: string | undefined,
	): Promise<acp.SessionConfigSelectOption[]> {
		if (!provider) {
			return []
		}

		let modelIds: string[] = []
		if (usesOpenRouterModels(provider)) {
			modelIds = filterOpenRouterModelIds(await fetchOpenRouterModels(), provider)
		} else if (provider === "github-copilot") {
			modelIds = Object.keys(await refreshGithubCopilotModels()).sort((a, b) => a.localeCompare(b))
		} else if (hasStaticModels(provider)) {
			modelIds = getModelList(provider)
		}

		if (currentModelId && !modelIds.includes(currentModelId)) {
			modelIds = [currentModelId, ...modelIds]
		}

		return modelIds.map((modelId) => ({ value: modelId, name: modelId }))
	}

	private withCurrentSelectOption(
		options: acp.SessionConfigSelectOption[],
		currentValue: string,
		currentName: string,
	): acp.SessionConfigSelectOption[] {
		if (!currentValue || options.some((option) => option.value === currentValue)) {
			return options
		}
		return [{ value: currentValue, name: currentName }, ...options]
	}

	/**
	 * Set the model for a session.
	 *
	 * This method allows changing the model for either plan or act mode.
	 * The modelId format is "provider/modelId" (e.g., "anthropic/claude-3-5-sonnet-20241022").
	 *
	 * @experimental This is an unstable API that may change.
	 */
	async unstable_setSessionModel(params: acp.SetSessionModelRequest): Promise<acp.SetSessionModelResponse> {
		const session = this.sessions.get(params.sessionId)

		if (!session) {
			throw new Error(`Session not found: ${params.sessionId}`)
		}

		Logger.debug("[DiracAgent] unstable_setSessionModel called:", {
			sessionId: params.sessionId,
			modelId: params.modelId,
		})

		// Parse the modelId format: "provider/modelId"
		const slashIndex = params.modelId.indexOf("/")
		if (slashIndex === -1) {
			throw new Error(`Invalid modelId format: ${params.modelId}. Expected "provider/modelId".`)
		}

		const provider = params.modelId.substring(0, slashIndex) as ApiProvider
		const modelId = params.modelId.substring(slashIndex + 1)

		await this.applyProviderAndModel(session, provider, modelId)
		session.lastActivityAt = Date.now()

		await StateManager.get().flushPendingState()
		await this.emitConfigOptionsUpdate(params.sessionId)

		return {}
	}

	async unstable_setSessionConfigOption(
		params: acp.SetSessionConfigOptionRequest,
	): Promise<acp.SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId)
		if (!session) {
			throw new Error(`Session not found: ${params.sessionId}`)
		}

		Logger.debug("[DiracAgent] unstable_setSessionConfigOption called:", {
			sessionId: params.sessionId,
			configId: params.configId,
			value: params.value,
		})

		let emittedConfigUpdate = false
		switch (params.configId) {
			case "mode":
				await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value })
				emittedConfigUpdate = true
				break
			case "provider":
				await this.applyProviderConfigOption(session, params.value)
				break
			case "model":
				await this.applyModelConfigOption(session, params.value)
				break
			case "reasoning_effort":
				this.applyReasoningEffortConfigOption(session, params.value)
				break
			case "thinking_budget":
				this.applyThinkingBudgetConfigOption(session, params.value)
				break
			default:
				throw new Error(`Unknown session config option: ${params.configId}`)
		}

		session.lastActivityAt = Date.now()
		await StateManager.get().flushPendingState()
		const configOptions = await this.getSessionConfigOptions(session)
		if (!emittedConfigUpdate) {
			await this.emitSessionUpdate(params.sessionId, {
				sessionUpdate: "config_option_update",
				configOptions,
			})
		}
		return { configOptions }
	}

	private async applyProviderConfigOption(session: DiracAcpSession, providerValue: string): Promise<void> {
		if (!isValidCliProvider(providerValue)) {
			throw new Error(`Invalid provider: ${providerValue}`)
		}

		const provider = providerValue as ApiProvider
		const currentModelId = await this.getCurrentModeModelId(session.mode, provider)
		await this.applyProviderAndModel(session, provider, currentModelId)
	}

	private async applyModelConfigOption(session: DiracAcpSession, modelValue: string): Promise<void> {
		const stateManager = StateManager.get()
		const provider = stateManager.getGlobalSettingsKey(
			session.mode === "act" ? "actModeApiProvider" : "planModeApiProvider",
		) as ApiProvider | undefined

		if (!provider) {
			throw new Error("Cannot set model before a provider is selected")
		}

		await this.applyProviderAndModel(session, provider, modelValue)
	}

	private applyReasoningEffortConfigOption(session: DiracAcpSession, effort: string): void {
		if (!REASONING_EFFORT_OPTIONS.some((option) => option.value === effort)) {
			throw new Error(`Invalid reasoning effort: ${effort}`)
		}

		this.setModeScopedSessionState(session.mode, (mode) => {
			StateManager.get().setGlobalState(
				mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort",
				effort as any,
			)
		})
	}

	private applyThinkingBudgetConfigOption(session: DiracAcpSession, budgetValue: string): void {
		const budget = Number.parseInt(budgetValue, 10)
		if (Number.isNaN(budget) || budget < 0) {
			throw new Error(`Invalid thinking budget: ${budgetValue}`)
		}

		this.setModeScopedSessionState(session.mode, (mode) => {
			StateManager.get().setGlobalState(
				mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens",
				budget as any,
			)
		})
	}

	private async applyProviderAndModel(session: DiracAcpSession, provider: ApiProvider, modelId: string): Promise<void> {
		this.setModeScopedSessionState(session.mode, (mode) => {
			const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			StateManager.get().setGlobalState(providerKey, provider)

			const modelKey = getProviderModelIdKey(provider, mode)
			StateManager.get().setGlobalState(modelKey, modelId as any)

			if (mode === "act") {
				session.actModeModelId = `${provider}/${modelId}`
			} else {
				session.planModeModelId = `${provider}/${modelId}`
			}
		})
	}

	private setModeScopedSessionState(currentMode: Mode, setter: (mode: Mode) => void): void {
		const stateManager = StateManager.get()
		setter(currentMode)

		const separateModels = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ?? false
		if (!separateModels) {
			setter(currentMode === "act" ? "plan" : "act")
		}
	}

	/**
	 * Handle a user prompt.
	 *
	 * This is the main entry point for user interaction. The agent
	 * processes the prompt and sends updates back via sessionUpdate.
	 *
	 * The prompt flow:
	 * 1. Extract content from the ACP prompt (text, images, files)
	 * 2. Set up internal dirac state subsription
	 * 3. Initialize or continue dirac task
	 * 4. Translate DiracMessages to ACP SessionUpdates
	 * 5. Handle permission requests for tools/commands
	 * 6. Return when dirac task completes, is cancelled, or needs user input
	 */
	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		const session = this.sessions.get(params.sessionId)
		const sessionState = this.sessionStates.get(params.sessionId)

		if (!session || !sessionState) {
			throw new Error(`Session not found: ${params.sessionId}`)
		}

		if (sessionState.status === AcpSessionStatus.Processing) {
			throw new Error(`Session ${params.sessionId} is already processing a prompt`)
		}

		const controller = this.#sessionControllers.get(session)
		if (!controller) {
			throw new Error("Controller not initialized for session. This is a bug in the ACP agent setup.")
		}

		Logger.debug("[DiracAgent] prompt called:", {
			sessionId: params.sessionId,
			promptLength: params.prompt.length,
		})

		// Mark session as processing and set as current active session
		sessionState.status = AcpSessionStatus.Processing
		session.lastActivityAt = Date.now()
		this.currentActiveSessionId = params.sessionId

		// Clear delta tracking state for new prompt cycle
		this.partialMessageLastContent.clear()
		this.messageToToolCallId.clear()

		// Track cleanup functions for subscriptions
		const cleanupFunctions: (() => void)[] = []

		// Promise that resolves when task completes, is cancelled, or needs input
		let resolvePrompt: (response: acp.PromptResponse) => void
		let _rejectPrompt: (error: Error) => void
		const promptPromise = new Promise<acp.PromptResponse>((resolve, reject) => {
			resolvePrompt = resolve
			_rejectPrompt = reject
		})

		// Track if we've already resolved/rejected (object for pass-by-reference)
		const promptResolved = { value: false }

		try {
			// Extract text content from prompt
			const textContent = params.prompt
				.filter((block): block is acp.TextContent & { type: "text" } => block.type === "text")
				.map((block) => block.text)
				.join("\n")

			// Extract image content as base64 data URLs
			const imageContent = params.prompt
				.filter((block): block is acp.ImageContent & { type: "image" } => block.type === "image")
				.map((block) => `data:${block.mimeType || "image/png"};base64,${block.data}`)

			// Extract file resources (embedded resources)
			const fileResources = params.prompt
				.filter((block): block is acp.EmbeddedResource & { type: "resource" } => block.type === "resource")
				.map((block) => block.resource.uri)

			// Determine if this is a new task, continuation, or loaded session resume
			const hasActiveTask = controller.task !== undefined
			const isLoadedSession = session.isLoadedFromHistory === true

			if (isLoadedSession && !hasActiveTask) {
				// First prompt on a loaded session - resume the task from history
				Logger.debug("[DiracAgent] Resuming loaded session:", params.sessionId)

				// Clear the flag so subsequent prompts are handled normally
				session.isLoadedFromHistory = false

				// Resume the task using its history item
				await controller.reinitExistingTaskFromId(params.sessionId)

				// After reinit, the task should be in a waiting state (resume_task ask)
				// Send the user's prompt as a response to continue
				if (controller.task) {
					await controller.task.handleWebviewAskResponse("messageResponse", textContent, imageContent, fileResources)
				}
			} else if (hasActiveTask && controller.task) {
				// Continue existing task - respond to pending ask
				Logger.debug("[DiracAgent] Continuing existing task:", controller.task.taskId)

				// Find the last ask message and respond to it
				const messages = controller.task.messageStateHandler.getDiracMessages()
				const lastAskMessage = [...messages].reverse().find((m) => m.type === "ask")

				if (lastAskMessage) {
					await controller.task.handleWebviewAskResponse("messageResponse", textContent, imageContent, fileResources)
				} else {
					// No pending ask - treat as new user message
					// This shouldn't normally happen but handle gracefully
					Logger.debug("[DiracAgent] No pending ask found, starting new task")
					await controller.initTask(textContent, imageContent, fileResources)
				}
			} else {
				// Start new task
				Logger.debug("[DiracAgent] Starting new task")
				await controller.initTask(textContent, imageContent, fileResources)
			}

			// Subscribe to diracMessages changes after task is created
			if (controller.task) {
				const onDiracMessagesChanged = (change: DiracMessageChange) => {
					this.handleDiracMessagesChanged(params.sessionId, sessionState, change, resolvePrompt, promptResolved).catch(
						(error) => {
							Logger.debug("[DiracAgent] Error handling diracMessagesChanged:", error)
						},
					)
				}

				controller.task.messageStateHandler.on("diracMessagesChanged", onDiracMessagesChanged)
				cleanupFunctions.push(() => {
					controller.task?.messageStateHandler.off("diracMessagesChanged", onDiracMessagesChanged)
				})
			}

			// Return the promise that will resolve when task completes
			return await promptPromise
		} catch (error) {
			if (!promptResolved.value) {
				promptResolved.value = true
				// Send error as session update before returning
				await this.emitSessionUpdate(params.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					},
				})
				return { stopReason: "error" as acp.StopReason }
			}
			throw error
		} finally {
			// Clean up subscriptions
			for (const cleanup of cleanupFunctions) {
				try {
					cleanup()
				} catch (error) {
					Logger.debug("[DiracAgent] Error during cleanup:", error)
				}
			}
			sessionState.status = AcpSessionStatus.Idle
		}
	}

	private async handleDiracMessagesChanged(
		sessionId: string,
		sessionState: AcpSessionState,
		change: DiracMessageChange,
		resolvePrompt: (response: acp.PromptResponse) => void,
		promptResolved: { value: boolean },
	): Promise<void> {
		Logger.debug("[DiracAgent] handleDiracMessagesChanged:", change)
		try {
			switch (change.type) {
				case "add":
					// Process the newly added message
					if (change.message) {
						await this.processMessageWithDelta(sessionId, sessionState, change.message)
						this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
					}
					break

				case "update":
					// Process the updated message (streaming updates)
					if (change.message) {
						await this.processMessageWithDelta(sessionId, sessionState, change.message)
						// Also check for prompt resolution on updates - message may have transitioned from partial to complete
						this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
					}
					break
				case "set":
					// Check the last message for prompt resolution
					break
				case "delete":
					// Message deleted - no action needed for ACP updates
					break
			}
		} catch (error) {
			Logger.debug("[DiracAgent] Error handling diracMessagesChanged:", error)
		}
	}

	/**
	 * Handle a permission request for an ask message.
	 *
	 * This method:
	 * 1. Sends the permission request to the client
	 * 2. Waits for the user's decision
	 * 3. Responds to Dirac's ask based on the decision
	 *
	 * @param sessionId - The session ID
	 * @param sessionState - The session state
	 * @param message - The Dirac ask message
	 * @param permissionRequest - The permission request details from translateMessage
	 */
	private async handlePermissionRequest(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessageType,
		permissionRequest: Omit<acp.RequestPermissionRequest, "sessionId">,
	): Promise<void> {
		const session = this.sessions.get(sessionId)

		if (!session) {
			Logger.debug("[DiracAgent] No session found for permission request")
			return
		}

		const controller = this.#sessionControllers.get(session)

		if (!controller?.task) {
			Logger.debug("[DiracAgent] No active task for permission request")
			return
		}

		const askType = message.ask as DiracAsk

		try {
			// Request permission from the client
			const response = await this.requestPermission(sessionId, permissionRequest.toolCall, permissionRequest.options)

			Logger.debug("[DiracAgent] Permission response received:", response.outcome)

			// Handle the response
			const result = handlePermissionResponse(response, askType)

			// Update tool call status based on permission result
			if (sessionState.currentToolCallId) {
				if (result.cancelled) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "cancelled" },
					})
				} else if (result.response === "noButtonClicked") {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "rejected" },
					})
				} else {
					// Permission granted - mark as in_progress
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "in_progress",
					})
				}
			}

			// Respond to Dirac's ask based on the permission result
			if (result.cancelled) {
				// Cancellation - reject the operation
				await controller.task.handleWebviewAskResponse("noButtonClicked")
			} else {
				// Pass the response to Dirac
				await controller.task.handleWebviewAskResponse(result.response, result.text)
			}
		} catch (error) {
			Logger.debug("[DiracAgent] Error handling permission request:", error)

			// Update tool call status to failed
			if (sessionState.currentToolCallId) {
				await this.emitSessionUpdate(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.currentToolCallId,
					status: "failed",
					rawOutput: { error: String(error) },
				})
			}

			// Reject the operation on error
			await controller.task.handleWebviewAskResponse("noButtonClicked")
		}
	}

	/**
	 * Check if a message should resolve the prompt (end the turn).
	 */
	private checkMessageForPromptResolution(
		message: DiracMessageType,
		resolvePrompt: (response: acp.PromptResponse) => void,
		promptResolved: { value: boolean },
	): void {
		if (promptResolved.value) return

		// Don't resolve for partial (still streaming) messages
		if (message.partial) return

		// Check for ask messages that require user input
		if (message.type === "ask") {
			const askType = message.ask as DiracAsk
			if (
				askType === "followup" ||
				askType === "plan_mode_respond" ||
				askType === "act_mode_respond" ||
				askType === "completion_result" ||
				askType === "resume_task" ||
				askType === "resume_completed_task"
			) {
				promptResolved.value = true
				resolvePrompt({ stopReason: "end_turn" })
				return
			}
		}

		// Check for completion_result say message
		if (message.type === "say" && message.say === "completion_result") {
			promptResolved.value = true
			resolvePrompt({ stopReason: "end_turn" })
		}
	}

	/**
	 * Process a message and compute deltas for streaming content.
	 *
	 * This method uses translateMessage to properly map DiracMessages to ACP SessionUpdates,
	 * while computing deltas for text content to avoid sending duplicate content during
	 * streaming updates.
	 *
	 * For text-streaming messages (text, reasoning, followup, plan_mode_respond):
	 * - Computes delta between current and last-sent content
	 * - Only sends the new portion to avoid duplicates
	 *
	 * For other messages (tool calls, commands, etc.):
	 * - Uses translateMessage to produce proper ACP updates
	 * - Sends complete updates (no delta computation needed)
	 */
	private async processMessageWithDelta(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessageType,
	): Promise<void> {
		const messageKey = message.ts
		const lastText = this.partialMessageLastContent.get(messageKey) || ""

		// Determine if this is a text-streaming message type that needs delta handling
		// Note: act_mode_respond is NOT included here because its text content was already
		// sent via the say: "text" message. Including it would cause duplicate output.
		const isTextStreamingMessage =
			(message.type === "say" &&
				(message.say === "text" || message.say === "reasoning" || message.say === "completion_result")) ||
			(message.type === "ask" &&
				(message.ask === "followup" || message.ask === "plan_mode_respond" || message.ask === "completion_result"))

		if (isTextStreamingMessage && message.text) {
			// Extract the actual text content for JSON-wrapped messages
			// plan_mode_respond uses { response: string, options?: string[] }
			// followup uses { question: string, options?: string[] }
			let textContent = message.text
			if (message.type === "ask" && (message.ask === "plan_mode_respond" || message.ask === "followup")) {
				try {
					const parsed = JSON.parse(message.text)
					if (message.ask === "plan_mode_respond" && parsed.response !== undefined) {
						textContent = parsed.response
					} else if (message.ask === "followup" && parsed.question !== undefined) {
						textContent = parsed.question
					}
				} catch {
					// If parsing fails, use the raw text
				}
			}

			// For streaming text messages, compute delta to avoid sending duplicates
			let textDelta: string
			if (textContent.startsWith(lastText)) {
				textDelta = textContent.slice(lastText.length)
			} else {
				// Content changed entirely (rare), send all
				textDelta = textContent
			}

			// Only send if there's new content
			if (textDelta) {
				// Determine the correct update type based on message type
				const sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" =
					message.type === "say" && message.say === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk"

				// For completion_result messages, add a leading newline to separate from previous content
				// This ensures the completion message appears on a new line after any preceding text
				const isCompletionResult =
					(message.type === "say" && message.say === "completion_result") ||
					(message.type === "ask" && message.ask === "completion_result")
				const needsNewline = isCompletionResult && lastText === ""

				await this.emitSessionUpdate(sessionId, {
					sessionUpdate,
					content: { type: "text", text: needsNewline ? `\n${textDelta}` : textDelta },
				})
			}

			// Track what we've sent (use extracted text, not raw JSON)
			this.partialMessageLastContent.set(messageKey, textContent)
		} else {
			// For non-streaming messages, use the full translator
			// Check if we already have a toolCallId for this message (from a previous partial update)
			const existingToolCallId = this.messageToToolCallId.get(messageKey)

			const result = translateMessage(message, sessionState, {
				existingToolCallId,
			})

			// Send all updates produced by the translator
			for (const update of result.updates) {
				await this.emitSessionUpdate(sessionId, update)
			}

			// Track the toolCallId for this message so subsequent updates reuse it
			if (result.toolCallId) {
				this.messageToToolCallId.set(messageKey, result.toolCallId)
			}

			// Handle permission requests for ask messages
			// Only process permissions for non-partial (complete) ask messages
			if (result.requiresPermission && result.permissionRequest && !message.partial) {
				// Handle the permission request asynchronously
				// This will request permission from the client and respond to Dirac
				await this.handlePermissionRequest(sessionId, sessionState, message, result.permissionRequest)
			}

			// Track text content for this message (in case of future updates)
			if (message.text) {
				this.partialMessageLastContent.set(messageKey, message.text)
			}

			// Clean up the mapping when the message is complete (not partial)
			if (!message.partial && result.toolCallId) {
				this.messageToToolCallId.delete(messageKey)
			}
		}
	}

	/**
	 * Cancel the current operation in a session.
	 *
	 * This is a notification (no response expected). The agent should
	 * stop any ongoing processing for the specified session.
	 */
	async cancel(params: acp.CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId)
		if (!session) {
			Logger.debug("[DiracAgent] cancel called for non-existent session:", params.sessionId)
			return
		}
		const sessionState = this.sessionStates.get(params.sessionId)

		Logger.debug("[DiracAgent] cancel called:", {
			sessionId: params.sessionId,
			status: sessionState?.status,
		})

		if (sessionState) {
			sessionState.status = AcpSessionStatus.Cancelled

			// If we have an active controller task, cancel it
			const controller = this.#sessionControllers.get(session)
			if (controller?.task) {
				try {
					await controller.cancelTask()
				} catch (error) {
					Logger.debug("[DiracAgent] Error cancelling task:", error)
				}
			}
		}
	}

	/**
	 * Set the session mode (plan/act).
	 *
	 * Dirac supports two modes:
	 * - "plan": Gather information and create a detailed plan
	 * - "act": Execute actions to accomplish the task
	 */
	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		const session = this.sessions.get(params.sessionId)

		if (!session) {
			throw new Error(`Session not found: ${params.sessionId}`)
		}

		Logger.debug("[DiracAgent] setSessionMode called:", {
			sessionId: params.sessionId,
			modeId: params.modeId,
		})

		// Validate mode
		const validModes = ["plan", "act"]
		if (!validModes.includes(params.modeId)) {
			throw new Error(`Invalid mode: ${params.modeId}. Valid modes are: ${validModes.join(", ")}`)
		}

		// Update session mode
		session.mode = params.modeId as Mode
		session.lastActivityAt = Date.now()

		// Update Controller mode if active
		const controller = this.#sessionControllers.get(session)
		if (controller) {
			controller.stateManager.setGlobalState("mode", session.mode)

			// If there's an active task, switch its mode
			if (controller.task) {
				await controller.togglePlanActMode(session.mode)
			}
		}

		await StateManager.get().flushPendingState()
		await this.emitSessionUpdate(params.sessionId, {
			sessionUpdate: "current_mode_update",
			currentModeId: session.mode,
		})
		await this.emitConfigOptionsUpdate(params.sessionId)

		return {}
	}

	async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		throw new Error("Authentication not supported")
	}

	private async emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void> {
		const emitter = this.emitterForSession(sessionId)

		try {
			emitter.emit(update.sessionUpdate, update)
		} catch (error) {
			Logger.debug("[DiracAgent] Error emitting session update:", error)
			emitter.emit("error", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async emitConfigOptionsUpdate(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) return

		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "config_option_update",
			configOptions: await this.getSessionConfigOptions(session),
		})
	}

	private async sendAvailableCommands(sessionId: string, controller: Controller): Promise<void> {
		try {
			// Get all available commands from Dirac
			const response = await getAvailableSlashCommands(controller, {})

			// Filter out CLI-only and VS Code-only commands
			const cliOnlyNames = new Set(CLI_ONLY_COMMANDS.map((c) => c.name))
			const vscodeOnlyNames = new Set(VSCODE_ONLY_COMMANDS.map((c) => c.name))

			const filteredCommands = response.commands.filter(
				(cmd) => cmd.cliCompatible && !cliOnlyNames.has(cmd.name) && !vscodeOnlyNames.has(cmd.name),
			)

			// Convert to ACP AvailableCommand format
			const availableCommands: acp.AvailableCommand[] = filteredCommands.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				input: {
					hint: cmd.description,
				},
			}))

			// Send the available_commands_update notification
			await this.emitSessionUpdate(sessionId, {
				sessionUpdate: "available_commands_update",
				availableCommands,
			})

			Logger.debug("[DiracAgent] Sent available commands:", {
				sessionId,
				commandCount: availableCommands.length,
				commands: availableCommands.map((c) => c.name),
			})
		} catch (error) {
			Logger.debug("[DiracAgent] Error sending available commands:", error)
		}
	}
}
