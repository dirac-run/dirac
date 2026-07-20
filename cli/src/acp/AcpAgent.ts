/**
 * AcpAgent - Thin wrapper that bridges stdio connection to DiracAgent.
 *
 * This class wraps the DiracAgent and connects it to an ACP AgentSideConnection
 * for stdio-based communication. It:
 * - Wires up the permission handler to call connection.requestPermission()
 * - Subscribes to DiracAgent session events and forwards them to connection.sessionUpdate()
 * - Delegates all acp.Agent methods to the internal DiracAgent
 *
 * For programmatic usage without stdio, use DiracAgent directly.
 *
 * @module acp
 */

import type * as acp from "@agentclientprotocol/sdk"
import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk"
import { Logger } from "@/shared/services/Logger.js"
import { DiracAgent } from "../agent/DiracAgent.js"
import { type AcpAgentOptions, type ElicitationHandler, type PermissionHandler, type SessionUpdateType } from "../agent/types.js"

function permissionRuleFromParams(params: Record<string, unknown>): {
	tool: string
	pattern?: string
	action: "allow" | "deny"
} {
	const rule = params.rule
	if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
		throw RequestError.invalidParams(undefined, "rule is required")
	}

	const { tool, pattern, action } = rule as Record<string, unknown>
	if (
		typeof tool !== "string" ||
		(pattern !== undefined && typeof pattern !== "string") ||
		(action !== "allow" && action !== "deny")
	) {
		throw RequestError.invalidParams(undefined, "rule must contain a tool, optional pattern, and allow or deny action")
	}

	return { tool, ...(pattern === undefined ? {} : { pattern }), action }
}

function worktreeIntegrationParams(params: Record<string, unknown>): {
	targetBranch?: string
	deleteAfterMerge?: boolean
} {
	const targetBranch = params.targetBranch
	const deleteAfterMerge = params.deleteAfterMerge
	if (targetBranch !== undefined && typeof targetBranch !== "string") {
		throw RequestError.invalidParams(undefined, "targetBranch must be a string")
	}
	if (deleteAfterMerge !== undefined && typeof deleteAfterMerge !== "boolean") {
		throw RequestError.invalidParams(undefined, "deleteAfterMerge must be a boolean")
	}
	return {
		...(targetBranch === undefined ? {} : { targetBranch }),
		...(deleteAfterMerge === undefined ? {} : { deleteAfterMerge }),
	}
}

/**
 * ACP Agent wrapper that bridges stdio connection to DiracAgent.
 *
 * This is the class used by runAcpMode() for stdio-based ACP communication.
 * It creates an internal DiracAgent and wires up the connection for:
 * - Permission requests (via connection.requestPermission)
 * - Session updates (via connection.sessionUpdate)
 */
export class AcpAgent implements acp.Agent {
	private readonly connection: AgentSideConnection
	private readonly diracAgent: DiracAgent

	/** Track which sessions we've subscribed to for event forwarding */
	private readonly subscribedSessions: Set<string> = new Set()
	/** Track which sessions have already published initial ACP setup updates */
	private readonly initializedSessions: Set<string> = new Set()
	/** Deduplicate in-flight initial session setup update publication */
	private readonly sessionInitializationPromises: Map<string, Promise<void>> = new Map()
	/** Listener cleanup functions owned by this transport connection. */
	private readonly sessionEventCleanup = new Map<string, Array<() => void>>()
	/** A superseded detached transport must not continue serving RPCs. */
	private disconnected = false

	constructor(
		connection: acp.AgentSideConnection,
		options: AcpAgentOptions,
		diracAgent: DiracAgent = new DiracAgent(options),
		permissionHandler?: PermissionHandler,
	) {
		this.connection = connection
		this.diracAgent = diracAgent
		this.diracAgent.setPermissionHandler(permissionHandler ?? this.connectionPermissionHandler())

		this.diracAgent.setElicitationHandler(this.connectionElicitationHandler())
	}

	/** Request a permission decision from this transport's client. */
	requestPermission(request: Parameters<PermissionHandler>[0]): ReturnType<AgentSideConnection["requestPermission"]> {
		this.assertConnected()
		return this.connection.requestPermission(request)
	}

	private assertConnected(): void {
		if (this.disconnected) {
			throw new Error("ACP transport has been disconnected")
		}
	}

	private connectionPermissionHandler(): PermissionHandler {
		return (request, resolve) => {
			this.requestPermission(request)
				.then(resolve)
				.catch((error) => {
					Logger.debug("[AcpAgent] Error requesting permission:", error)
					resolve({ outcome: { outcome: "cancelled" } })
				})
		}
	}

	private connectionElicitationHandler(): ElicitationHandler {
		return (request, resolve) => {
			this.connection
				.unstable_createElicitation(request)
				.then(resolve)
				.catch((error) => {
					Logger.error("[AcpAgent] Error requesting elicitation:", error)
					resolve({ action: "cancel" })
				})
		}
	}

	private subscribeToSessionEvents(sessionId: string): void {
		if (this.subscribedSessions.has(sessionId)) {
			return
		}

		const emitter = this.diracAgent.emitterForSession(sessionId)
		const cleanup: Array<() => void> = []
		const subscribe = <K extends SessionUpdateType>(eventName: K, listener: (payload: Record<string, unknown>) => void) => {
			emitter.on(eventName, listener as never)
			cleanup.push(() => emitter.off(eventName, listener as never))
		}
		const forwardSessionUpdate = <K extends SessionUpdateType>(eventName: K) => {
			subscribe(eventName, (payload) => {
				const update = {
					sessionUpdate: eventName,
					...payload,
				} as acp.SessionUpdate
				this.connection.sessionUpdate({ sessionId, update }).catch((error) => {
					Logger.error(`[AcpAgent] Error forwarding ${eventName}:`, error)
				})
			})
		}

		forwardSessionUpdate("agent_message_chunk")
		forwardSessionUpdate("agent_thought_chunk")
		forwardSessionUpdate("tool_call")
		forwardSessionUpdate("tool_call_update")
		forwardSessionUpdate("available_commands_update")
		forwardSessionUpdate("plan")
		forwardSessionUpdate("current_mode_update")
		forwardSessionUpdate("user_message_chunk")
		forwardSessionUpdate("config_option_update")
		forwardSessionUpdate("session_info_update")

		const clientAnnotationListener = (payload: Record<string, unknown>) => {
			this.connection
				.extNotification("dev.dirac/client_annotation", {
					sessionId,
					...payload,
				})
				.catch((error) => {
					Logger.error("[AcpAgent] Error forwarding client annotation:", error)
				})
		}
		emitter.on("client_annotation", clientAnnotationListener)
		cleanup.push(() => emitter.off("client_annotation", clientAnnotationListener))

		const pinnedMessagesListener = (payload: Record<string, unknown>) => {
			this.connection
				.extNotification("dev.dirac/pinned_messages_update", {
					sessionId,
					...payload,
				})
				.catch((error) => {
					Logger.error("[AcpAgent] Error forwarding pinned-message update:", error)
				})
		}
		emitter.on("pinned_messages_update", pinnedMessagesListener)
		cleanup.push(() => emitter.off("pinned_messages_update", pinnedMessagesListener))

		const usageListener = (payload: Record<string, unknown>) => {
			this.connection.extNotification("dev.dirac/usage_update", { sessionId, ...payload }).catch((error) => {
				Logger.error("[AcpAgent] Error forwarding usage update:", error)
			})
		}
		emitter.on("usage_update", usageListener)
		cleanup.push(() => emitter.off("usage_update", usageListener))

		const errorListener = (error: Error) => Logger.error("[AcpAgent] Session error:", error)
		emitter.on("error", errorListener)
		cleanup.push(() => emitter.off("error", errorListener))

		this.sessionEventCleanup.set(sessionId, cleanup)
		this.subscribedSessions.add(sessionId)
	}

	private removeSessionSubscription(sessionId: string): void {
		for (const cleanup of this.sessionEventCleanup.get(sessionId) ?? []) {
			cleanup()
		}
		this.sessionEventCleanup.delete(sessionId)
		this.subscribedSessions.delete(sessionId)
	}

	/**
	 * Publish session setup updates once per session.
	 *
	 * This is intentionally separated from `newSession()` response handling so
	 * ACP clients such as Zed only receive command/config notifications after
	 * the session creation response has been delivered.
	 */
	private async ensureSessionSetupUpdates(sessionId: string): Promise<void> {
		if (this.initializedSessions.has(sessionId)) {
			return
		}

		const existingPromise = this.sessionInitializationPromises.get(sessionId)
		if (existingPromise) {
			await existingPromise
			return
		}

		const publishPromise = this.diracAgent
			.publishSessionSetupUpdates(sessionId)
			.then(() => {
				this.initializedSessions.add(sessionId)
			})
			.finally(() => {
				this.sessionInitializationPromises.delete(sessionId)
			})

		this.sessionInitializationPromises.set(sessionId, publishPromise)
		await publishPromise
	}

	private scheduleSessionSetupUpdates(sessionId: string): void {
		setImmediate(() => {
			void this.ensureSessionSetupUpdates(sessionId)
		})
	}

	// ============================================================
	// acp.Agent Interface Implementation - Delegate to DiracAgent
	// ============================================================

	async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		this.assertConnected()
		return await this.diracAgent.initialize(params, this.connection)
	}

	async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		this.assertConnected()
		if (method === "dev.dirac/auth.logout") {
			await this.diracAgent.logout()
			return {}
		}

		const sessionId = params.sessionId
		if (typeof sessionId !== "string") {
			throw RequestError.invalidParams(undefined, "sessionId is required")
		}

		switch (method) {
			case "dev.dirac/session.close":
				return await this.closeSession({ sessionId })
			case "dev.dirac/session.delete":
				return await this.deleteSession({ sessionId })
			case "dev.dirac/permissions.list":
				return { rules: await this.diracAgent.listPermissionRules(sessionId) }
			case "dev.dirac/permissions.delete": {
				const rule = permissionRuleFromParams(params)
				await this.diracAgent.deletePermissionRule(sessionId, rule)
				return {}
			}

			case "dev.dirac/messages.pin": {
				const messageId = params.messageId
				if (typeof messageId !== "string") {
					throw RequestError.invalidParams(undefined, "messageId is required")
				}
				await this.diracAgent.pinMessage(sessionId, messageId)
				return {}
			}
			case "dev.dirac/messages.unpin": {
				const messageId = params.messageId
				if (typeof messageId !== "string") {
					throw RequestError.invalidParams(undefined, "messageId is required")
				}
				await this.diracAgent.unpinMessage(sessionId, messageId)
				return {}
			}
			case "dev.dirac/messages.pinned":
				return { messages: this.diracAgent.listPinnedMessages(sessionId) }

			case "dev.dirac/checkpoints.list":
				return {
					checkpoints: await this.diracAgent.listWorkspaceCheckpoints(sessionId),
				}
			case "dev.dirac/checkpoints.restore": {
				const checkpointId = params.checkpointId
				if (typeof checkpointId !== "string") {
					throw RequestError.invalidParams(undefined, "checkpointId is required")
				}
				await this.diracAgent.restoreWorkspaceCheckpoint(sessionId, checkpointId)
				return {}
			}

			case "dev.dirac/worktree.integrate": {
				const { targetBranch, deleteAfterMerge } = worktreeIntegrationParams(params)
				return await this.diracAgent.integrateSessionWorktree(sessionId, targetBranch, deleteAfterMerge)
			}
			default:
				throw RequestError.methodNotFound(method)
		}
	}

	/** Handle Dirac vendor notifications; unknown JSON-RPC notifications remain ignored. */
	async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		this.assertConnected()
		if (method === "dev.dirac/whisper") {
			await this.diracAgent.queueWhisper(params)
			return
		}
		if (method === "dev.dirac/client_annotation") {
			this.diracAgent.recordClientAnnotation(params)
		}
	}

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		this.assertConnected()
		const response = await this.diracAgent.newSession(params)
		// Subscribe to events for this new session
		this.subscribeToSessionEvents(response.sessionId)
		this.scheduleSessionSetupUpdates(response.sessionId)
		return response
	}

	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		this.assertConnected()
		const response = await this.diracAgent.loadSession(params)
		this.subscribeToSessionEvents(params.sessionId)
		// Replay history after subscribing so events reach the client
		await this.diracAgent.replayLoadedSessionHistory(params.sessionId)
		this.scheduleSessionSetupUpdates(params.sessionId)
		return response
	}

	async unstable_resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
		this.assertConnected()
		const response = await this.diracAgent.unstable_resumeSession(params)
		this.subscribeToSessionEvents(params.sessionId)
		this.scheduleSessionSetupUpdates(params.sessionId)
		return response
	}

	async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		this.assertConnected()
		return this.diracAgent.unstable_listSessions(params)
	}

	async listProviders(params: acp.ListProvidersRequest): Promise<acp.ListProvidersResponse> {
		this.assertConnected()
		void params
		return this.diracAgent.listProviders()
	}

	async setProvider(params: acp.SetProviderRequest): Promise<void> {
		this.assertConnected()
		return this.diracAgent.setProvider(params)
	}

	async disableProvider(params: acp.DisableProviderRequest): Promise<void> {
		this.assertConnected()
		return this.diracAgent.disableProvider(params)
	}

	async unstable_listProviders(params: acp.ListProvidersRequest): Promise<acp.ListProvidersResponse> {
		return this.listProviders(params)
	}

	async unstable_setProvider(params: acp.SetProviderRequest): Promise<void> {
		return this.setProvider(params)
	}

	async unstable_disableProvider(params: acp.DisableProviderRequest): Promise<void> {
		return this.disableProvider(params)
	}

	async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
		this.assertConnected()
		const response = await this.diracAgent.closeSession(params)
		this.removeSessionSubscription(params.sessionId)
		this.initializedSessions.delete(params.sessionId)
		this.sessionInitializationPromises.delete(params.sessionId)

		return response
	}

	async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
		this.assertConnected()
		const response = await this.diracAgent.deleteSession(params)
		this.removeSessionSubscription(params.sessionId)
		this.initializedSessions.delete(params.sessionId)
		this.sessionInitializationPromises.delete(params.sessionId)

		return response
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		this.assertConnected()
		// Ensure we're subscribed to this session's events
		this.subscribeToSessionEvents(params.sessionId)
		await this.ensureSessionSetupUpdates(params.sessionId)
		return this.diracAgent.prompt(params)
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		this.assertConnected()
		return this.diracAgent.cancel(params)
	}

	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		this.assertConnected()
		return this.diracAgent.setSessionMode(params)
	}

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		this.assertConnected()
		return this.diracAgent.setSessionConfigOption(params)
	}

	async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		this.assertConnected()
		return this.diracAgent.authenticate(params)
	}

	/** Release only this client transport; active Dirac sessions remain running. */
	disconnect(): void {
		if (this.disconnected) return
		this.disconnected = true
		for (const cleanup of this.sessionEventCleanup.values()) {
			for (const unsubscribe of cleanup) {
				unsubscribe()
			}
		}
		this.sessionEventCleanup.clear()
		this.subscribedSessions.clear()
		this.initializedSessions.clear()
		this.sessionInitializationPromises.clear()
	}

	async shutdown(): Promise<void> {
		this.disconnect()
		return this.diracAgent.shutdown()
	}
}
