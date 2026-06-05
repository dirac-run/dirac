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
import { ulid } from "ulid"
import type { ApiProvider } from "@shared/api"
import { DiracMessageType, CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"

import { CLI_ONLY_COMMANDS, VSCODE_ONLY_COMMANDS } from "@shared/slashCommands"
import { DiracEndpoint } from "@/config.js"
import { Controller } from "@/core/controller"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { getSavedDiracMessages, setRuntimeHooksDir } from "@/core/storage/disk"
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
import { CliContextResult, initializeCliContext } from "../vscode-context.js"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { getHistoryItemCwd, historyItemToSessionInfo, listLatestConversationHistoryItems, resolveHistorySession } from "./sessionHistory.js"
import { SessionConfigManager } from "./sessionConfig.js"
import { parsePromptContent } from "./promptContent.js"
import { TaskMessageBridge } from "./taskMessageBridge.js"
import { translateMessage } from "./messageTranslator.js"
import type { DiracAcpSession, DiracAgentOptions, PermissionHandler } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { ACP_REVIEW_COMMANDS, handleAcpReviewCommand } from "./review.js"
import { type AcpSessionState } from "./types.js"

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
    private readonly sessionConfig = new SessionConfigManager()
    private readonly taskMessageBridge = new TaskMessageBridge({
        getSession: (sessionId) => this.sessions.get(sessionId),
        getController: (session) => this.#sessionControllers.get(session),
        requestPermission: this.requestPermission.bind(this),
        emitSessionUpdate: this.emitSessionUpdate.bind(this),
    })

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
                sessionCapabilities: {
                    list: {},
                },
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
            async (_cwd: string) => undefined,
        )
    }

    /**
     * Create a new session.
     *
     * A session represents a conversation/task with the agent. The client
     * provides the working directory.
     */
    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const sessionId = ulid()

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
        const modelState = await this.sessionConfig.getSessionModelState(session.mode)
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session)

        return {
            sessionId,
            modes: this.sessionConfig.getSessionModeState(session.mode),
            models: modelState,
            configOptions,
        }
    }

    async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        return {
            sessions: listLatestConversationHistoryItems(params.cwd, this.options.cwd).map((item) =>
                historyItemToSessionInfo(item, params.cwd, this.options.cwd),
            ),
        }
    }

    /**
     * Load an existing session from task history.
     *
     * ACP session IDs are stable conversation IDs (HistoryItem.ulid when available).
     * The concrete backing task ID is resolved from history and used only for persisted task files.
     */
    async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
        const sessionId = params.sessionId
        const existingSession = this.sessions.get(sessionId)
        if (existingSession) {
            const modelState = await this.sessionConfig.getSessionModelState(existingSession.mode)
            const configOptions = await this.sessionConfig.getSessionConfigOptions(existingSession)
            return {
                modes: this.sessionConfig.getSessionModeState(existingSession.mode),
                models: modelState,
                configOptions,
            }
        }

        Logger.debug("[DiracAgent] loadSession called:", { sessionId })

        const resolvedSession = resolveHistorySession(sessionId)
        const controller = new Controller(this.ctx.extensionContext)
        const history = await controller.getTaskWithId(resolvedSession.taskId)
        const historyCwd = getHistoryItemCwd(history.historyItem, params.cwd, this.options.cwd)

        const session: DiracAcpSession = {
            sessionId,
            taskId: resolvedSession.taskId,
            cwd: historyCwd,
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

        const modelState = await this.sessionConfig.getSessionModelState(session.mode)
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session)
        return {
            modes: this.sessionConfig.getSessionModeState(session.mode),
            models: modelState,
            configOptions,
        }
    }

    async replayLoadedSessionHistory(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        const sessionState = this.sessionStates.get(sessionId)
        if (!session || !sessionState) {
            throw new Error(`Session not found: ${sessionId}`)
        }

        const messages = await getSavedDiracMessages(session.taskId || sessionId)
        for (const message of messages) {
            const result = translateMessage(message, sessionState)
            for (const update of result.updates) {
                await this.emitSessionUpdate(sessionId, update)
            }
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

        const slashIndex = params.modelId.indexOf("/")
        if (slashIndex === -1) {
            throw new Error(`Invalid modelId format: ${params.modelId}. Expected "provider/modelId".`)
        }

        const provider = params.modelId.substring(0, slashIndex) as ApiProvider
        const modelId = params.modelId.substring(slashIndex + 1)

        await this.sessionConfig.applyProviderAndModel(session, provider, modelId)
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
                await this.sessionConfig.applyProviderConfigOption(session, params.value)
                break
            case "model":
                await this.sessionConfig.applyModelConfigOption(session, params.value)
                break
            case "reasoning_effort":
                this.sessionConfig.applyReasoningEffortConfigOption(session, params.value)
                break
            case "thinking_budget":
                this.sessionConfig.applyThinkingBudgetConfigOption(session, params.value)
                break
            default:
                throw new Error(`Unknown session config option: ${params.configId}`)
        }

        session.lastActivityAt = Date.now()
        await StateManager.get().flushPendingState()
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session)
        if (!emittedConfigUpdate) {
            await this.emitSessionUpdate(params.sessionId, {
                sessionUpdate: "config_option_update",
                configOptions,
            })
        }
        return { configOptions }
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
        this.taskMessageBridge.clearPromptState()

        // Track cleanup functions for subscriptions
        const cleanupFunctions: (() => void)[] = []

        // Promise that resolves when task completes, is cancelled, or needs input
        let resolvePrompt!: (response: acp.PromptResponse) => void
        let _rejectPrompt!: (error: Error) => void
        const promptPromise = new Promise<acp.PromptResponse>((resolve, reject) => {
            resolvePrompt = resolve
            _rejectPrompt = reject
        })

        // Track if we've already resolved/rejected (object for pass-by-reference)
        const promptResolved = { value: false }

        try {
            const { textContent, imageContent, fileResources } = parsePromptContent(params.prompt)

            const interceptedReviewResponse =
                imageContent.length === 0 && fileResources.length === 0
                    ? await handleAcpReviewCommand({
                        commandText: textContent,
                        controller,
                        sessionId: params.sessionId,
                        cwd: session.cwd,
                        emitSessionUpdate: this.emitSessionUpdate.bind(this),
                    })
                    : null

            if (interceptedReviewResponse) {
                return interceptedReviewResponse
            }

            // Determine if this is a new task, continuation, or loaded session resume
            const hasActiveTask = controller.task !== undefined
            const isLoadedSession = session.isLoadedFromHistory === true

            if (isLoadedSession && !hasActiveTask) {
                Logger.debug("[DiracAgent] Resuming loaded session:", params.sessionId)
                session.isLoadedFromHistory = false

                await controller.reinitExistingTaskFromId(session.taskId || params.sessionId)
                const initialMessageCount = controller.task?.messageStateHandler.getDiracMessages().length ?? 0

                if (controller.task) {
                    await controller.task.submitCardResponse(
                        "",
                        DiracAskResponse.MESSAGE,
                        textContent,
                        imageContent,
                        fileResources,
                    )
                    this.taskMessageBridge.subscribeToTaskMessages(
                        controller,
                        params.sessionId,
                        sessionState,
                        resolvePrompt,
                        promptResolved,
                        cleanupFunctions,
                    )
                    await this.taskMessageBridge.replayTaskMessages(
                        controller,
                        params.sessionId,
                        sessionState,
                        resolvePrompt,
                        promptResolved,
                        initialMessageCount,
                    )
                }
            } else if (hasActiveTask && controller.task) {
                Logger.debug("[DiracAgent] Continuing existing task:", controller.task.taskId)
                const initialMessageCount = controller.task.messageStateHandler.getDiracMessages().length
                const messages = controller.task.messageStateHandler.getDiracMessages()
                const lastAskMessage = [...messages]
                    .reverse()
                    .find(
                        (m) => m.content.type === DiracMessageType.CARD && m.content.card.status === CardStatus.WAITING_FOR_INPUT,
                    )

                if (lastAskMessage) {
                    await controller.task.submitCardResponse(
                        "",
                        DiracAskResponse.MESSAGE,
                        textContent,
                        imageContent,
                        fileResources,
                    )
                    this.taskMessageBridge.subscribeToTaskMessages(
                        controller,
                        params.sessionId,
                        sessionState,
                        resolvePrompt,
                        promptResolved,
                        cleanupFunctions,
                    )
                    await this.taskMessageBridge.replayTaskMessages(
                        controller,
                        params.sessionId,
                        sessionState,
                        resolvePrompt,
                        promptResolved,
                        initialMessageCount,
                    )
                } else {
                    Logger.debug("[DiracAgent] No pending ask found, starting new task")
                    session.taskId = await controller.initTask(
                        textContent,
                        imageContent,
                        fileResources,
                        undefined,
                        undefined,
                        session.sessionId,
                    )
                    this.taskMessageBridge.subscribeToTaskMessages(
                        controller,
                        params.sessionId,
                        sessionState,
                        resolvePrompt,
                        promptResolved,
                        cleanupFunctions,
                    )
                    await this.taskMessageBridge.replayTaskMessages(controller, params.sessionId, sessionState, resolvePrompt, promptResolved)
                }
            } else {
                Logger.debug("[DiracAgent] Starting new task")
                session.taskId = await controller.initTask(
                    textContent,
                    imageContent,
                    fileResources,
                    undefined,
                    undefined,
                    session.sessionId,
                )
                this.taskMessageBridge.subscribeToTaskMessages(
                    controller,
                    params.sessionId,
                    sessionState,
                    resolvePrompt,
                    promptResolved,
                    cleanupFunctions,
                )
                await this.taskMessageBridge.replayTaskMessages(controller, params.sessionId, sessionState, resolvePrompt, promptResolved)
                await this.emitSessionUpdate(params.sessionId, {
                    sessionUpdate: "session_info_update",
                    title: textContent || null,
                    updatedAt: new Date().toISOString(),
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
            configOptions: await this.sessionConfig.getSessionConfigOptions(session),
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

            for (const reviewCommand of ACP_REVIEW_COMMANDS) {
                if (!availableCommands.some((cmd) => cmd.name === reviewCommand.name)) {
                    availableCommands.push(reviewCommand)
                }
            }

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
