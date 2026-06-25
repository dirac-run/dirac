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

import * as fs from "node:fs/promises"
import type * as acp from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { DiracMessageChange } from "@core/task/message-state"
import type { ApiProvider } from "@shared/api"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { DiracMessageType } from "@shared/ExtensionMessage"
import { CLI_ONLY_COMMANDS, VSCODE_ONLY_COMMANDS } from "@shared/slashCommands"
import { Controller } from "@/core/controller"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { setRuntimeHooksDir } from "@/core/storage/disk"
import { StateManager } from "@/core/storage/StateManager"
import { swapSessionOverrides } from "../acp/sessionOverrides.js"
import { AuthHandler } from "@/hosts/external/AuthHandler.js"
import { ExternalCommentReviewController } from "@/hosts/external/ExternalCommentReviewController.js"
import { ExternalDiracWebviewProvider } from "@/hosts/external/ExternalWebviewProvider.js"
import { HostProvider } from "@/hosts/host-provider.js"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { StandaloneTerminalManager } from "@/integrations/terminal/index.js"
import { Logger } from "@/shared/services/Logger.js"
import type { Settings } from "@/shared/storage/state-keys"
import { version as AGENT_VERSION } from "../../package.json"
import { getLatestTaskIdForSession, recordTaskForSession } from "../acp/acp-session-tasks.js"
import { ACPDiffViewProvider } from "../acp/ACPDiffViewProvider.js"
import { ACPHostBridgeClientProvider } from "../acp/ACPHostBridgeClientProvider.js"
import { AcpTerminalManager } from "../acp/AcpTerminalManager.js"
import { initCoreServices } from "../initCoreServices.js"
import { CliContextResult, initializeCliContext } from "../vscode-context.js"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { translateMessage } from "./messageTranslator.js"
import { TaskMessageBridge } from "./taskMessageBridge.js"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { DiracAcpSession, DiracAgentOptions, PermissionHandler } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { ACP_REVIEW_COMMANDS, handleAcpReviewCommand } from "./review.js"
import { type AcpSessionState } from "./types.js"
import { SessionConfigManager, acpModeToInternalState, type AcpModeId } from "./sessionConfig.js"
import { getHistoryItemCwd } from "./sessionHistory.js"
import { parsePromptContent } from "./promptContent.js"
import pWaitFor from "p-wait-for"

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
        this.acpSessionOverrides.clear()
    }
    private readonly options: DiracAgentOptions
    private ctx!: CliContextResult

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

    /** Bridge for translating DiracMessages to ACP SessionUpdates */
    private readonly bridge = new TaskMessageBridge({
        getSession: (sessionId: string) => this.sessions.get(sessionId),
        getController: (session: DiracAcpSession) => this.#sessionControllers.get(session),
        requestPermission: (sessionId, toolCall, options) => this.requestPermission(sessionId, toolCall, options),
        emitSessionUpdate: (sessionId, update) => this.emitSessionUpdate(sessionId, update),
        getClientCapabilities: () => this.clientCapabilities,
    })

    /** Session config manager for mode, model, provider, reasoning effort, and thinking budget */
    private readonly sessionConfig = new SessionConfigManager()

    /** Current active session ID for use by DiffViewProvider */
    private currentActiveSessionId: string | undefined

    /**
     * Per-session override map for security-relevant settings (auto-approve, yolo, mode).
     *
     * The global StateManager.sessionOverrideCache is process-wide — writing to it from
     * one ACP session would bleed into every other concurrent session. Instead we keep
     * the authoritative per-session values here, and swap them into StateManager only for
     * the duration of each session's prompt() call (see applySessionOverrides /
     * restoreSessionOverrides). This ensures the Task-level auto-approve reads that go
     * through StateManager.getGlobalSettingsKey() see the correct session's values.
     */
    private readonly acpSessionOverrides: Map<string, Partial<Settings>> = new Map()

    /**
     * In-flight prompt resolvers, keyed by session id. {@link cancel} uses these
     * to resolve the current `session/prompt` request with `stopReason: "cancelled"`
     * as required by the ACP spec
     * (agent-client-protocol/docs/protocol/prompt-turn.mdx — "After all ongoing
     * operations have been successfully aborted ... the Agent MUST respond to
     * the original session/prompt request with the cancelled stop reason").
     */
    private readonly pendingPromptResolvers: Map<
        string,
        { resolve: (response: acp.PromptResponse) => void; resolved: { value: boolean } }
    > = new Map()


    constructor(options: DiracAgentOptions) {
        this.options = options
        setRuntimeHooksDir(options.hooksDir)
        // ctx is initialized lazily in initialize() so that IO failures (e.g. an
        // unwritable --config path) surface as a JSON-RPC error response on
        // `initialize` rather than killing the process before the client can
        // observe anything.
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
        this.ctx = initializeCliContext({ diracDir: this.options.diracDir, workspaceDir: this.options.cwd })
        this.clientCapabilities = params.clientCapabilities
        this.initializeHostProvider(this.clientCapabilities, connection)
        // Shared with initializeCli — see initCoreServices for why both modes
        // must route through it.
        await initCoreServices({ extensionDir: this.ctx.EXTENSION_DIR, storageContext: this.ctx.storageContext })

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
            reservedTaskId: sessionId,
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
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session, this.acpSessionOverrides.get(session.sessionId))

        return {
            sessionId,
            modes: this.sessionConfig.getSessionModeState(session.mode, this.acpSessionOverrides.get(sessionId)),
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
            const modelState = await this.sessionConfig.getSessionModelState(existingSession.mode)
            const configOptions = await this.sessionConfig.getSessionConfigOptions(existingSession, this.acpSessionOverrides.get(sessionId))
            return {
                modes: this.sessionConfig.getSessionModeState(existingSession.mode, this.acpSessionOverrides.get(sessionId)),
                models: modelState,
                configOptions,
            }
        }

        Logger.debug("[DiracAgent] loadSession called:", { sessionId })

        // Resolve the actual taskId: check the replacement-task map first (multi-task session),
        // then fall back to sessionId itself (the common single-task case where taskId === sessionId).
        const resolvedTaskId = getLatestTaskIdForSession(sessionId) ?? sessionId

        const controller = new Controller(this.ctx.extensionContext)
        const history = await controller.getTaskWithId(resolvedTaskId)
        const historyCwd = getHistoryItemCwd(history.historyItem, params.cwd, this.options.cwd)

        const session: DiracAcpSession = {
            sessionId,
            cwd: historyCwd || process.cwd(),
            mode: (await controller.getStateToPostToWebview()).mode,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            isLoadedFromHistory: true,
            loadedTaskId: resolvedTaskId,
        }

        this.#sessionControllers.set(session, controller)
        this.sessions.set(sessionId, session)
        this.sessionStates.set(sessionId, {
            sessionId,
            status: AcpSessionStatus.Idle,
            pendingToolCalls: new Map(),
        })

        const modelState = await this.sessionConfig.getSessionModelState(session.mode)
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session, this.acpSessionOverrides.get(session.sessionId))
        return {
            modes: this.sessionConfig.getSessionModeState(session.mode, this.acpSessionOverrides.get(sessionId)),
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
        const configOptions = await this.sessionConfig.getSessionConfigOptions(session, this.acpSessionOverrides.get(session.sessionId))
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

        // Install this session's per-session overrides (auto-approve, yolo, mode) into
        // the StateManager so that Task-level reads (AutoApprove, ToolExecutor, etc.) see
        // the correct values for THIS session. The previous overrides (e.g. from a CLI
        // --auto-approve-all flag) are saved and will be restored in the finally block.
        //
        // Residual race note: if two ACP sessions are simultaneously mid-prompt, the swap
        // means each session's Task may briefly see the other session's overrides between
        // JS await points. In practice, each session has its own Controller/Task and the
        // auto-approve decision is made synchronously within the event-loop turn, making
        // the window extremely narrow. A fully lock-free fix would require plumbing sessionId
        // into StateManager.getGlobalSettingsKey() all the way to AutoApprove — left for
        // a later refactor if concurrent-session auto-approve skew is observed in practice.
        const sessionOverridesToApply = this.acpSessionOverrides.get(params.sessionId) ?? {}
        const savedStateManagerOverrides = swapSessionOverrides(sessionOverridesToApply)

        // Clear delta tracking state for new prompt cycle
        this.bridge.clearPromptState()

        // Track cleanup functions for subscriptions
        const cleanupFunctions: (() => void)[] = []

        // Promise that resolves when task completes, is cancelled, or needs input
        let resolvePrompt: (response: acp.PromptResponse) => void
        const promptPromise = new Promise<acp.PromptResponse>((resolve) => {
            resolvePrompt = resolve
        })

        // Track if we've already resolved/rejected (object for pass-by-reference)
        const promptResolved = { value: false }

        // Register the resolver so cancel() can resolve the in-flight prompt with
        // `stopReason: "cancelled"`. Cleared in the finally block.
        this.pendingPromptResolvers.set(params.sessionId, { resolve: resolvePrompt!, resolved: promptResolved })

        try {
            // Extract text content from prompt
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
                // First prompt on a loaded session - resume the task from history
                Logger.debug("[DiracAgent] Resuming loaded session:", params.sessionId)

                // Clear the flag so subsequent prompts are handled normally
                session.isLoadedFromHistory = false

                // Use loadedTaskId if set (multi-task session resolved in loadSession),
                // otherwise fall back to sessionId (common case where taskId === sessionId).
                const taskIdToResume = session.loadedTaskId ?? params.sessionId
                session.loadedTaskId = undefined

                // Resume the task using its history item
                await controller.reinitExistingTaskFromId(taskIdToResume)

                // After reinit, resumeTaskFromHistory() is running asynchronously. We must
                // NOT call handleWebviewAskResponse yet — TaskMessenger.ask() clears
                // taskState.askResponse at its start (to reset stale state), so any
                // response set before ask() runs gets wiped, leaving pWaitFor spinning
                // forever and the idle watchdog firing after 60 s.
                //
                // Instead, wait for the task to actually issue ask("resume_task" |
                // "resume_completed_task") — signalled by a diracMessagesChanged "add"
                // event — and only then deliver the user's prompt as the response.
                if (controller.task) {
                    const task = controller.task
                    await new Promise<void>((resolve, reject) => {
                        // Guard: if runPromise rejects before ask() fires (e.g. task init
                        // error), bail out so we don't leak a listener that would never fire.
                        const onRunPromiseError = (err: unknown) => {
                            task.messageStateHandler.off("diracMessagesChanged", onChanged)
                            reject(err instanceof Error ? err : new Error(String(err)))
                        }
                        const onChanged = (change: DiracMessageChange) => {
                            if (
                                change.type === "add" &&
                                change.message?.content.type === DiracMessageType.CARD &&
                                (change.message.content.card.header === "Resume Task" || change.message.content.card.header === "Resume Completed Task")
                            ) {
                                task.messageStateHandler.off("diracMessagesChanged", onChanged)
                                resolve()
                            }
                        }
                        // runPromise may not be set yet if resumeTaskFromHistory was started
                        // in the same tick; use Promise.resolve() so we only see rejections,
                        // not an absent value. Calling reject() after resolve() is a no-op.
                        Promise.resolve(controller.taskRunPromise).catch(onRunPromiseError)
                        task.messageStateHandler.on("diracMessagesChanged", onChanged)
                    })
                    await task.submitCardResponse("", DiracAskResponse.MESSAGE, textContent, imageContent, fileResources)
                }
            } else if (hasActiveTask && controller.task) {
                // Continue existing task - respond to pending ask
                Logger.debug("[DiracAgent] Continuing existing task:", controller.task.taskId)

                // Find the last ask message and respond to it
                const messages = controller.task.messageStateHandler.getDiracMessages()
                const lastAskMessage = [...messages].reverse().find((m) =>
                    m.content.type === DiracMessageType.CARD &&
                    (m.content.card.requireApproval || m.content.card.requireFeedback)
                )

                const terminalCardHeaders = new Set(["API Request Failed", "Mistake Limit Reached"])
                const lastAskIsTerminal =
                    lastAskMessage?.content.type === DiracMessageType.CARD &&
                    terminalCardHeaders.has(lastAskMessage.content.card.header)

                if (lastAskMessage && !lastAskIsTerminal) {
                    await controller.task.submitCardResponse("", DiracAskResponse.MESSAGE, textContent, imageContent, fileResources)
                } else {
                    Logger.debug("[DiracAgent] Starting new task (no pending ask or last ask was terminal failure)")
                    await controller.initTask(textContent, imageContent, fileResources)
                    // reservedTaskId was already consumed on first prompt; record the
                    // replacement task so loadSession can recover it after a restart.
                    if (controller.task) {
                        await recordTaskForSession(params.sessionId, controller.task.taskId)
                    }
                }
            } else {
                // Start new task — consume reservedTaskId (sessionId) so the task's taskId
                // equals the sessionId, enabling loadSession to find it without a map lookup.
                const taskIdOverride = session.reservedTaskId
                session.reservedTaskId = undefined
                Logger.debug("[DiracAgent] Starting new task")
                await controller.initTask(textContent, imageContent, fileResources, undefined, undefined, taskIdOverride)
            }

            // Subscribe to diracMessages changes after task is created.
            // The bridge handles all message translation, delta tracking, permission
            // requests, prompt resolution, and error surfacing.
            const task = controller.task
            if (task) {
                this.bridge.subscribeToTaskMessages(
                    controller,
                    params.sessionId,
                    sessionState,
                    resolvePrompt!,
                    promptResolved,
                    cleanupFunctions,
                    controller.taskRunPromise,
                )
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
                return { stopReason: "end_turn" }
            }
            throw error
        } finally {
            // Restore whatever session overrides were in StateManager before this
            // prompt started (e.g. CLI --auto-approve-all global override), so that
            // other code paths running outside of a session's prompt turn continue
            // to see the correct values.
            swapSessionOverrides(savedStateManagerOverrides)

            // Clean up subscriptions
            for (const cleanup of cleanupFunctions) {
                try {
                    cleanup()
                } catch (error) {
                    Logger.debug("[DiracAgent] Error during cleanup:", error)
                }
            }
            this.pendingPromptResolvers.delete(params.sessionId)
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

            // Claim the prompt-resolver slot BEFORE any await so the idle watchdog
            // cannot steal it while we're awaiting cancelTask(). The ACP spec
            // (prompt-turn.mdx) requires the agent to respond with stopReason:
            // "cancelled" once the task is aborted; claiming here ensures that even
            // if the watchdog timer fires and its callback runs during the cancelTask()
            // await, the watchdog sees the flag and returns without emitting a phantom
            // "Agent stalled" tool_call or resolving with "end_turn".
            const pending = this.pendingPromptResolvers.get(params.sessionId)
            const cancelClaimed = pending != null && !pending.resolved.value
            if (cancelClaimed) {
                pending!.resolved.value = true
                // Actual resolve() call is deferred until after cancelTask() so the
                // response goes out once the task is truly stopped (see below).
            }

            // If we have an active controller task, cancel it
            const controller = this.#sessionControllers.get(session)
            if (controller?.task) {
                try {
                    await controller.cancelTask()
                } catch (error) {
                    Logger.debug("[DiracAgent] Error cancelling task:", error)
                }
            }

            // Per ACP spec (prompt-turn.mdx): "After all ongoing operations have
            // been successfully aborted ... the Agent MUST respond to the original
            // session/prompt request with the cancelled stop reason."
            if (cancelClaimed) {
                pending!.resolve({ stopReason: "cancelled" })
            }
        }
    }

    /**
     * Set the session mode.
     *
     * The ACP-level modes are:
     *   - "plan": gather information and create a detailed plan
     *   - "act":  execute actions, asking permission per tool call
     *   - "auto": "act" with auto-approve on
     *   - "yolo": "act" with auto-approve + yolo on (no safety prompts)
     *
     * Internally only `mode` ("plan" | "act") plus the global
     * `autoApproveAllToggled` and `yoloModeToggled` flags exist; this method
     * translates between the two.
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

        const validModes: AcpModeId[] = ["plan", "act", "auto", "yolo"]
        if (!validModes.includes(params.modeId as AcpModeId)) {
            throw new Error(`Invalid mode: ${params.modeId}. Valid modes are: ${validModes.join(", ")}`)
        }

        const acpMode = params.modeId as AcpModeId
        const { mode, autoApprove, yolo } = acpModeToInternalState(acpMode)

        // Write to the per-session override map rather than the global StateManager
        // sessionOverrideCache. This prevents one ACP session's mode switch from
        // bleeding into every other concurrent session in the same process.
        const existing = this.acpSessionOverrides.get(params.sessionId) ?? {}
        this.acpSessionOverrides.set(params.sessionId, {
            ...existing,
            autoApproveAllToggled: autoApprove,
            yoloModeToggled: yolo,
            mode,
        })

        session.mode = mode
        session.lastActivityAt = Date.now()

        const stateManager = StateManager.get()
        const controller = this.#sessionControllers.get(session)
        if (controller) {
            if (controller.task) {
                await controller.togglePlanActMode(session.mode)
            }
        }

        await stateManager.flushPendingState()
        await this.emitSessionUpdate(params.sessionId, {
            sessionUpdate: "current_mode_update",
            currentModeId: acpMode,
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
            configOptions: await this.sessionConfig.getSessionConfigOptions(session, this.acpSessionOverrides.get(session.sessionId)),
        })
    }

    /**
     * Replay the historical messages for a loaded session as ACP sessionUpdate events.
     * Called by AcpAgent after subscribing to session events, so the events reach the client.
     */
    async replayLoadedSessionHistory(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) return

        const controller = this.#sessionControllers.get(session)
        if (!controller) return

        const taskId = session.loadedTaskId ?? sessionId
        let uiMessages: DiracMessage[]
        try {
            const { uiMessagesFilePath } = await controller.getTaskWithId(taskId)
            const raw = await fs.readFile(uiMessagesFilePath, "utf8")
            uiMessages = JSON.parse(raw)
        } catch (error) {
            Logger.debug("[DiracAgent] replayLoadedSessionHistory: could not read ui_messages:", error)
            return
        }

        // Use a fresh session state for replay — don't pollute the live session's tool call tracking
        const replayState: AcpSessionState = {
            sessionId,
            status: AcpSessionStatus.Idle,
            pendingToolCalls: new Map(),
        }

        // Message types that are internal Dirac housekeeping and should not be replayed

        for (const message of uiMessages) {
            // Skip internal housekeeping: API_STATUS and CHECKPOINT messages
            if (message.content.type === DiracMessageType.API_STATUS || message.content.type === DiracMessageType.CHECKPOINT) continue

            try {
                // User-facing input messages that translateMessage skips — emit as user_message_chunk
                if (
                    message.content.type === DiracMessageType.MARKDOWN &&
                    message.content.role === "user" &&
                    message.content.content
                ) {
                    await this.emitSessionUpdate(sessionId, {
                        sessionUpdate: "user_message_chunk",
                        content: { type: "text", text: message.content.content },
                    } as acp.SessionUpdate)
                    continue
                }

                const result = translateMessage(message, replayState, {
                    clientCapabilities: this.clientCapabilities,
                })
                for (const update of result.updates) {
                    await this.emitSessionUpdate(sessionId, update)
                }
            } catch (error) {
                Logger.debug("[DiracAgent] replayLoadedSessionHistory: error translating message:", error)
            }
        }
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

    async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        return this.unstable_listSessions_internal(params)
    }

    private async unstable_listSessions_internal(_params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        const sessions = [...this.sessions.values()]
        return {
            sessions: sessions.map((session) => ({
                sessionId: session.sessionId,
                cwd: session.cwd,
            })),
        }
    }

    /**
     * Restore a checkpoint in a session.
     *
     * Cancels any active task, finds the message matching the checkpoint
     * ID (DiracMessage.id / toolCallId), and delegates to the controller's
     */
    async checkpointRestore(sessionId: string, checkpointId: string, restoreType: string, offset?: number): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`)
        }

        const controller = this.#sessionControllers.get(session)
        if (!controller) {
            throw new Error(`Controller not found for session: ${sessionId}`)
        }

        // Cancel active task — cannot alter message history while task is running
        await controller.cancelTask()

        // Wait for the task to be fully re-initialized after cancellation.
        // cancelTask() re-initializes the task asynchronously, and we must
        // wait for it to be ready before accessing its message handler.
        await pWaitFor(() => controller.task?.taskState.isInitialized === true, {
            timeout: 3_000,
        }).catch((error) => {
            Logger.error("[DiracAgent.checkpointRestore] Failed to wait for task initialization:", error)
            throw error
        })

        // Find the message matching the checkpoint ID (DiracMessage.id / toolCallId)
        const message = controller.task?.messageStateHandler
            .getDiracMessages()
            .find((m) => m.id === checkpointId)

        if (message && controller.task?.checkpointManager) {
            await controller.task.checkpointManager.restoreCheckpoint(
                message.id,
                restoreType as any,
                offset,
            )
        } else {
            throw new Error(`Checkpoint not found for id: ${checkpointId}`)
        }
    }
}
