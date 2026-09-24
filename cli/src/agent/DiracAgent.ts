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
import { Controller } from "@/core/controller"
import type { ToolPermissionRule } from "@/core/permissions/types.js"
import { setRuntimeHooksDir } from "@/core/storage/disk"
import { StateManager } from "@/core/storage/StateManager"
import { withTaskHistoryInventoryLock } from "@/core/storage/taskHistory"
import { AuthHandler } from "@/hosts/external/AuthHandler.js"
import { ExternalCommentReviewController } from "@/hosts/external/ExternalCommentReviewController.js"
import { ExternalDiracWebviewProvider } from "@/hosts/external/ExternalWebviewProvider.js"
import { HostProvider } from "@/hosts/host-provider.js"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { NodeTextFileAccess } from "@/integrations/editor/NodeTextFileAccess"
import { StandaloneTerminalManager } from "@/integrations/terminal/index.js"
import { DiracTempManager } from "@/services/temp/DiracTempManager.js"
import { Logger } from "@/shared/services/Logger.js"
import { version as AGENT_VERSION } from "../../package.json"
import { ACPHostBridgeClientProvider } from "../acp/ACPHostBridgeClientProvider.js"
import { ACPTextFileAccess } from "../acp/ACPTextFileAccess.js"
import { AcpTerminalManager } from "../acp/AcpTerminalManager.js"
import { deletePinnedSessionMessages, type PinnedSessionMessage } from "../acp/acp-session-pins.js"
import { deleteSessionRuntimeConfig } from "../acp/acp-session-runtime-config.js"
import { deleteTasksForSession } from "../acp/acp-session-tasks.js"
import { deleteSessionUpdates, recordClientAnnotation } from "../acp/acp-session-updates.js"
import type { ActiveAcpSessionIdResolver } from "../acp/active-session.js"
import { initCoreServices } from "../initCoreServices.js"
import { getCliBinaryPath } from "../utils/path.js"
import { CliContextResult, initializeCliContext } from "../vscode-context.js"
import { AcpAuthenticationManager } from "./AcpAuthenticationManager.js"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { PinnedMessagesManager } from "./pinnedMessages.js"
import { PromptSteeringQueue } from "./promptSteeringQueue.js"
import { PromptTurnRunner } from "./promptTurnRunner.js"
import { ProviderConfigurationManager } from "./providerConfiguration.js"
import type { DiracAcpSession, DiracAgentOptions, ElicitationHandler, PermissionHandler } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { SessionCatalog } from "./sessionCatalog.js"
import { SessionCheckpointService, type WorkspaceCheckpoint } from "./sessionCheckpoints.js"
import { SessionConfigManager } from "./sessionConfig.js"
import { getTaskIdsForSession } from "./sessionHistory.js"
import { SessionHistoryReplayer } from "./sessionHistoryReplay.js"
import { SessionLifecycleManager } from "./sessionLifecycle.js"
import { SessionPermissionManager } from "./sessionPermissions.js"
import { SessionRuntimeManager } from "./sessionRuntime.js"
import { SessionUpdateJournal } from "./sessionUpdateJournal.js"
import { SessionWorktreeManager } from "./sessionWorktrees.js"
import { TaskMessageBridge } from "./taskMessageBridge.js"
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
	private readonly options: DiracAgentOptions
	private readonly authentication: AcpAuthenticationManager
	private ctx!: CliContextResult

	/** Map of active sessions by session ID */
	public readonly sessions: Map<string, DiracAcpSession> = new Map()

	/** WeakMap to associate DiracAcpSession with its Controller without exposing it to consumers */
	readonly #sessionControllers = new WeakMap<DiracAcpSession, Controller>()

	/** Runtime state for active sessions */
	private readonly sessionStates: Map<string, AcpSessionState> = new Map()

	/** Per-session event emitters for session updates */
	private readonly sessionEmitters: Map<string, DiracSessionEmitter> = new Map()

	/** Client capabilities received during initialization */
	private clientCapabilities?: acp.ClientCapabilities

	/** Per-session bridges isolate message, tool-call, and streaming state. */
	private readonly bridges: Map<string, TaskMessageBridge> = new Map()

	/** Provider routing configured through ACP's provider provisioning methods. */
	private readonly providerConfiguration = new ProviderConfigurationManager()

	/** Session config manager for mode, model, provider, reasoning effort, and thinking budget */
	private readonly sessionConfig = new SessionConfigManager(this.providerConfiguration)

	private readonly updates: SessionUpdateJournal
	private readonly steering: PromptSteeringQueue
	private readonly permissions: SessionPermissionManager
	private readonly runtime: SessionRuntimeManager
	private readonly pinned: PinnedMessagesManager
	private readonly worktrees: SessionWorktreeManager
	private readonly checkpoints: SessionCheckpointService
	private readonly catalog: SessionCatalog
	private readonly historyReplay: SessionHistoryReplayer
	private readonly promptRunner: PromptTurnRunner
	private readonly lifecycle: SessionLifecycleManager

	constructor(options: DiracAgentOptions) {
		this.options = options
		this.authentication = new AcpAuthenticationManager({ diracDir: options.diracDir, cwd: options.cwd })
		setRuntimeHooksDir(options.hooksDir)
		// ctx is initialized lazily in initialize() so that IO failures (e.g. an
		// unwritable --config path) surface as a JSON-RPC error response on
		// `initialize` rather than killing the process before the client can
		// observe anything.

		// Collaborator deps are lambdas resolved at call time, so wiring order
		// does not matter here.
		this.updates = new SessionUpdateJournal((sessionId) => this.emitterForSession(sessionId))
		this.steering = new PromptSteeringQueue({
			sessionStates: this.sessionStates,
			emitterForSession: (sessionId) => this.emitterForSession(sessionId),
		})
		this.permissions = new SessionPermissionManager({
			sessions: this.sessions,
			getController: (session) => this.#sessionControllers.get(session),
		})
		this.runtime = new SessionRuntimeManager({
			options,
			sessions: this.sessions,
			sessionStates: this.sessionStates,
			getTask: (session) => this.#sessionControllers.get(session)?.task,
			getDataDir: () => this.ctx.DATA_DIR,
			sessionConfig: this.sessionConfig,
			emitSessionUpdate: (sessionId, update) => this.updates.emitSessionUpdate(sessionId, update),
		})
		this.pinned = new PinnedMessagesManager({
			sessions: this.sessions,
			getController: (session) =>
				this.#sessionControllers.get(session) ?? (session as DiracAcpSession & { controller?: Controller }).controller,
			emitterForSession: (sessionId) => this.emitterForSession(sessionId),
			switchToActMode: (sessionId) => this.runtime.switchSessionToActMode(sessionId),
			bindPromptTask: (sessionId, task) => this.steering.bindPromptTask(sessionId, task),
			getActivePromptOverrides: (sessionId) => this.runtime.activePromptOverrides.get(sessionId),
		})
		this.worktrees = new SessionWorktreeManager({
			sessions: this.sessions,
			getController: (session) => this.#sessionControllers.get(session),
		})
		this.checkpoints = new SessionCheckpointService({
			sessions: this.sessions,
			getController: (session) => this.#sessionControllers.get(session),
			emitSessionInfoUpdate: (session) => this.updates.emitSessionInfoUpdate(session),
		})
		this.catalog = new SessionCatalog({
			options,
			sessions: this.sessions,
			emitSessionUpdate: (sessionId, update) => this.updates.emitSessionUpdate(sessionId, update),
			emitSessionInfoUpdate: (session) => this.updates.emitSessionInfoUpdate(session),
		})
		this.historyReplay = new SessionHistoryReplayer({
			sessions: this.sessions,
			getController: (session) => this.#sessionControllers.get(session),
			emitterForSession: (sessionId) => this.emitterForSession(sessionId),
			bridgeForSession: (sessionId) => this.bridgeForSession(sessionId),
			emitSessionUpdate: (sessionId, update) => this.updates.emitSessionUpdate(sessionId, update),
			emitPinnedMessagesUpdate: (sessionId, event) => this.pinned.emitPinnedMessagesUpdate(sessionId, event),
			getClientCapabilities: () => this.clientCapabilities,
		})
		this.promptRunner = new PromptTurnRunner({
			sessions: this.sessions,
			sessionStates: this.sessionStates,
			getController: (session) => this.#sessionControllers.get(session),
			runtime: this.runtime,
			steering: this.steering,
			permissions: this.permissions,
			pinned: this.pinned,
			sessionConfig: this.sessionConfig,
			bridgeForSession: (sessionId) => this.bridgeForSession(sessionId),
			emitSessionUpdate: (sessionId, update) => this.updates.emitSessionUpdate(sessionId, update),
			sendAvailableCommands: (sessionId, controller) => this.catalog.sendAvailableCommands(sessionId, controller),
			setSessionTitleFromFirstExchange: (session, promptText) =>
				this.catalog.setSessionTitleFromFirstExchange(session, promptText),
		})
		this.lifecycle = new SessionLifecycleManager({
			options,
			sessions: this.sessions,
			sessionStates: this.sessionStates,
			getDataDir: () => this.ctx.DATA_DIR,
			createController: (workspaceCwd) => new Controller(this.ctx.extensionContext, { workspaceCwd }),
			setController: (session, controller) => void this.#sessionControllers.set(session, controller),
			getController: (session) => this.#sessionControllers.get(session),
			runtime: this.runtime,
			sessionConfig: this.sessionConfig,
			worktrees: this.worktrees,
			catalog: this.catalog,
		})
	}

	async shutdown() {
		try {
			for (const sessionId of [...this.sessions.keys()]) {
				await this.releaseSessionResources(sessionId, true)
			}
		} finally {
			this.authentication.shutdown()
			DiracTempManager.stopPeriodicCleanup()
		}
	}

	/** Release active session resources while retaining all persisted history. */
	private async releaseSessionResources(sessionId: string, force = false): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			return
		}

		if (!force && this.runtime.isConfiguring(sessionId)) {
			throw new Error(`Session ${sessionId} is applying a runtime configuration change`)
		}
		if (this.sessionStates.get(sessionId)?.status === AcpSessionStatus.Processing) {
			await this.cancel({ sessionId })
		}

		await this.#sessionControllers.get(session)?.dispose()
		this.sessions.delete(sessionId)
		this.sessionStates.delete(sessionId)
		this.sessionEmitters.delete(sessionId)
		this.runtime.releaseSession(sessionId)
		this.bridges.delete(sessionId)
		this.steering.releasePromptSteeringOwnership(sessionId)
	}

	/** Delete a session's active resources, owned worktree, and persisted task history. */
	private async deleteSessionResources(sessionId: string): Promise<void> {
		await this.releaseSessionResources(sessionId)
		await this.worktrees.deleteOwnedWorktree(sessionId)

		const taskIds = getTaskIdsForSession(sessionId)
		const stateManager = StateManager.get()
		await withTaskHistoryInventoryLock(async () => {
			for (const taskId of taskIds) {
				await fs.rm(`${this.ctx.DATA_DIR}/tasks/${taskId}`, {
					recursive: true,
					force: true,
				})
			}
			stateManager.removeTaskHistoryItems(taskIds)
			await stateManager.flushPendingState()
		})
		deleteTasksForSession(sessionId)
		deleteSessionUpdates(sessionId)
		deletePinnedSessionMessages(sessionId)

		deleteSessionRuntimeConfig(this.ctx.DATA_DIR, sessionId)
	}

	private createTaskMessageBridge(): TaskMessageBridge {
		return new TaskMessageBridge({
			getSession: (sessionId: string) => this.sessions.get(sessionId),
			getController: (session: DiracAcpSession) => this.#sessionControllers.get(session),
			requestPermission: (sessionId, toolCall, options) => this.permissions.requestPermission(sessionId, toolCall, options),
			emitSessionUpdate: (sessionId, update) => this.updates.emitSessionUpdate(sessionId, update),
			persistPermissionRule: (sessionId, toolCall, action) =>
				this.permissions.persistPermissionRule(sessionId, toolCall, action),
			getClientCapabilities: () => this.clientCapabilities,
			requestElicitation: (request) => this.permissions.requestElicitation(request),
			emitSteeringStatus: (sessionId, steeringMessageId, status) =>
				this.steering.emitSteeringStatus(sessionId, steeringMessageId, status),
		})
	}

	private bridgeForSession(sessionId: string): TaskMessageBridge {
		let bridge = this.bridges.get(sessionId)
		if (!bridge) {
			bridge = this.createTaskMessageBridge()
			this.bridges.set(sessionId, bridge)
		}
		return bridge
	}

	/** Queue client guidance in the task selected by the active prompt. */
	async queueWhisper(params: Record<string, unknown>): Promise<void> {
		return this.steering.queueWhisper(params)
	}

	/** Persist a client control-plane event so a later session/load can replay it. */
	recordClientAnnotation(params: Record<string, unknown>): void {
		const sessionId = params.sessionId
		const annotation = params.annotation
		if (typeof sessionId !== "string" || !annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
			Logger.debug("[DiracAgent] Ignoring malformed dev.dirac/client_annotation notification")
			return
		}

		try {
			recordClientAnnotation(sessionId, annotation as Record<string, unknown>)
		} catch (error) {
			Logger.error("[DiracAgent] ACP journal persistence failed for client annotation:", error)
		}
	}

	/** Pin a persisted message snapshot so it remains in every compacted request context. */
	async pinMessage(sessionId: string, messageId: string): Promise<void> {
		return this.pinned.pinMessage(sessionId, messageId)
	}

	async unpinMessage(sessionId: string, messageId: string): Promise<void> {
		return this.pinned.unpinMessage(sessionId, messageId)
	}

	listPinnedMessages(sessionId: string): PinnedSessionMessage[] {
		return this.pinned.listPinnedMessages(sessionId)
	}

	/** List the workspace snapshots created at task and tool boundaries for a session. */
	async listWorkspaceCheckpoints(sessionId: string): Promise<WorkspaceCheckpoint[]> {
		return this.checkpoints.listWorkspaceCheckpoints(sessionId)
	}

	/** Restore both task history and workspace files to one previously listed checkpoint. */
	async restoreWorkspaceCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
		return this.checkpoints.restoreWorkspaceCheckpoint(sessionId, checkpointId)
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
		this.permissions.setPermissionHandler(handler)
	}

	/** Set the transport callback used for ACP elicitation. */
	setElicitationHandler(handler: ElicitationHandler): void {
		this.permissions.setElicitationHandler(handler)
	}

	/** List persisted project permission rules for an ACP session. */
	async listPermissionRules(sessionId: string): Promise<ToolPermissionRule[]> {
		return this.permissions.listPermissionRules(sessionId)
	}

	/** Delete one persisted project permission rule for an ACP session. */
	async deletePermissionRule(sessionId: string, rule: ToolPermissionRule): Promise<void> {
		return this.permissions.deletePermissionRule(sessionId, rule)
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
		this.ctx = initializeCliContext({
			diracDir: this.options.diracDir,
			workspaceDir: this.options.cwd,
		})
		DiracTempManager.startPeriodicCleanup()
		this.clientCapabilities = params.clientCapabilities
		this.initializeHostProvider(this.clientCapabilities, connection)
		// Shared with initializeCli — see initCoreServices for why both modes
		// must route through it.
		await initCoreServices({
			extensionDir: this.ctx.EXTENSION_DIR,
			storageContext: this.ctx.storageContext,
		})
		this.runtime.applyStartupProviderInfrastructure()
		const startupOverrides = this.runtime.createStartupSessionOverrides()
		const authMethods = this.authentication.listAuthenticationMethods(
			this.runtime.isStartupProviderConfigured(startupOverrides),
			this.clientCapabilities,
		)

		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				_meta: {
					"dev.dirac/session.close": true,
					"dev.dirac/session.delete": true,
					...(this.options.detached ? { "dev.dirac/detached_mode": true } : {}),
					"dev.dirac/auth.logout": true,

					"dev.dirac/seq": true,

					"dev.dirac/permissions.list": true,
					"dev.dirac/permissions.delete": true,

					"dev.dirac/whisper": true,
					"dev.dirac/steering_status": true,
					"dev.dirac/client_annotation": true,

					"dev.dirac/checkpoints.list": true,
					"dev.dirac/checkpoints.restore": true,
					"dev.dirac/messages.pin": true,
					"dev.dirac/messages.unpin": true,
					"dev.dirac/messages.pinned": true,
					"dev.dirac/pinned_messages_update": true,
					"dev.dirac/permission.effect_previews": true,
					"dev.dirac/worktree.provision": {
						requestMetaKey: "dev.dirac/worktree",
						requestShape: "true | { baseBranch?: string }",
					},
					"dev.dirac/worktree.integrate": true,
				},
				loadSession: true,
				auth: { logout: {} },
				providers: {},
				sessionCapabilities: {
					resume: {},
					close: {},
					delete: {},
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
			authMethods,
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
		const activeSessionIdResolver: ActiveAcpSessionIdResolver = () => this.promptRunner.currentPromptSessionId
		const hostBridgeClientProvider = new ACPHostBridgeClientProvider(
			connection,
			clientCapabilities,
			activeSessionIdResolver,
			() =>
				this.promptRunner.currentPromptSessionId
					? this.sessions.get(this.promptRunner.currentPromptSessionId)?.cwd
					: (this.options.cwd ?? process.cwd()),
			connection
				? (sessionId, update) => this.updates.persistAndSendSessionUpdate(connection, sessionId, update)
				: undefined,
			AGENT_VERSION,
		)

		HostProvider.initialize(
			"cli",
			() => new ExternalDiracWebviewProvider(this.ctx.extensionContext),
			() => {
				if (connection) {
					return new FileEditProvider(
						new ACPTextFileAccess(connection, clientCapabilities, activeSessionIdResolver, new NodeTextFileAccess()),
						false,
						false,
					)
				}
				return new FileEditProvider(new NodeTextFileAccess(), false)
			},
			() => new ExternalCommentReviewController(),
			() => {
				if (clientCapabilities?.terminal && connection) {
					return new AcpTerminalManager(connection, clientCapabilities, activeSessionIdResolver)
				}
				return new StandaloneTerminalManager()
			},
			hostBridgeClientProvider,
			(message: string) => Logger.info(message),
			async (path: string) => AuthHandler.getInstance().getCallbackUrl(path),
			getCliBinaryPath,
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
		return this.lifecycle.newSession(params)
	}

	/**
	 * Load an existing session from task history.
	 *
	 * The ACP LoadSessionRequest sessionId is treated as the historical task ID.
	 * The task is rehydrated lazily on first prompt to align with the ACP flow.
	 */
	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		return this.lifecycle.loadSession(params)
	}

	/**
	 * Resume an existing session without replaying historical session updates.
	 *
	 * Unlike `loadSession`, this restores the same persisted task context but leaves
	 * transcript ownership with the reattaching client.
	 */
	async unstable_resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
		return this.lifecycle.resumeSession(params)
	}

	/**
	 * Emit initial session updates that must happen after the ACP stdio wrapper
	 * has registered and subscribed to the session.
	 */
	async publishSessionSetupUpdates(sessionId: string): Promise<void> {
		return this.lifecycle.publishSessionSetupUpdates(sessionId)
	}

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		return this.runtime.setSessionConfigOption(params)
	}

	/**
	 * Handle a user prompt.
	 *
	 * This is the main entry point for user interaction. The agent
	 * processes the prompt and sends updates back via sessionUpdate.
	 */
	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		return this.promptRunner.prompt(params)
	}

	/**
	 * Cancel the current operation in a session.
	 *
	 * This is a notification (no response expected). The agent should
	 * stop any ongoing processing for the specified session.
	 */
	async cancel(params: acp.CancelNotification): Promise<void> {
		return this.promptRunner.cancel(params)
	}

	async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
		await this.releaseSessionResources(params.sessionId)
		return {}
	}

	async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
		await this.deleteSessionResources(params.sessionId)
		return {}
	}

	/** Set the mutually exclusive Plan/Act session mode without changing approval qualifiers. */
	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		Logger.debug("[DiracAgent] setSessionMode called:", {
			sessionId: params.sessionId,
			modeId: params.modeId,
		})
		await this.runtime.applySessionMode(params.sessionId, params.modeId)
		return {}
	}

	async listProviders(): Promise<acp.ListProvidersResponse> {
		return this.providerConfiguration.listProviders()
	}

	async setProvider(params: acp.SetProviderRequest): Promise<void> {
		await this.providerConfiguration.setProvider(params)
		await this.publishProviderConfigChanges()
	}

	async disableProvider(params: acp.DisableProviderRequest): Promise<void> {
		await this.providerConfiguration.disableProvider(params)
		await this.publishProviderConfigChanges()
	}

	async unstable_listProviders(params: acp.ListProvidersRequest): Promise<acp.ListProvidersResponse> {
		void params
		return this.listProviders()
	}

	async unstable_setProvider(params: acp.SetProviderRequest): Promise<void> {
		return this.setProvider(params)
	}

	async unstable_disableProvider(params: acp.DisableProviderRequest): Promise<void> {
		return this.disableProvider(params)
	}

	private async publishProviderConfigChanges(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((sessionId) => this.runtime.emitConfigOptionsUpdate(sessionId, true)))
	}

	async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		const response = await this.authentication.authenticate(params)
		await this.publishProviderConfigChanges()
		return response
	}

	async logout(): Promise<void> {
		await this.authentication.logout()
		await this.publishProviderConfigChanges()
	}

	/**
	 * Replay the historical messages for a loaded session as ACP sessionUpdate events.
	 * Called by AcpAgent after subscribing to session events, so the events reach the client.
	 */
	async replayLoadedSessionHistory(sessionId: string): Promise<void> {
		return this.historyReplay.replayLoadedSessionHistory(sessionId)
	}

	async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		return this.catalog.listSessions(params)
	}

	/** Merge a session-owned worktree branch into its requested target branch. */
	async integrateSessionWorktree(
		sessionId: string,
		targetBranch?: string,
		deleteAfterMerge = true,
	): Promise<{
		sourceBranch: string
		targetBranch: string
		worktreePath: string
	}> {
		return this.worktrees.integrateSessionWorktree(sessionId, targetBranch, deleteAfterMerge)
	}

	/**
	 * Restore a checkpoint in a session.
	 *
	 * Cancels any active task, finds the message matching the checkpoint
	 * ID (DiracMessage.id / toolCallId), and delegates to the controller's
	 */
	async checkpointRestore(sessionId: string, checkpointId: string, restoreType: string, offset?: number): Promise<void> {
		return this.checkpoints.checkpointRestore(sessionId, checkpointId, restoreType, offset)
	}
}
