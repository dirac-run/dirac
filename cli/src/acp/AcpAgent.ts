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
import { Logger } from "@/shared/services/Logger.js"
import { DiracAgent } from "../agent/DiracAgent.js"
import { type AcpAgentOptions, type SessionUpdateType } from "../agent/types.js"

/**
 * ACP Agent wrapper that bridges stdio connection to DiracAgent.
 *
 * This is the class used by runAcpMode() for stdio-based ACP communication.
 * It creates an internal DiracAgent and wires up the connection for:
 * - Permission requests (via connection.requestPermission)
 * - Session updates (via connection.sessionUpdate)
 */
export class AcpAgent implements acp.Agent {
	private readonly connection: acp.AgentSideConnection
	private readonly diracAgent: DiracAgent

	/** Track which sessions we've subscribed to for event forwarding */
	private readonly subscribedSessions: Set<string> = new Set()
	/** Track which sessions have already published initial ACP setup updates */
	private readonly initializedSessions: Set<string> = new Set()
	/** Deduplicate in-flight initial session setup update publication */
	private readonly sessionInitializationPromises: Map<string, Promise<void>> = new Map()

	constructor(connection: acp.AgentSideConnection, options: AcpAgentOptions) {
		this.connection = connection

		// Create the internal DiracAgent
		this.diracAgent = new DiracAgent(options)

		// Wire up the permission handler to use the connection
		this.diracAgent.setPermissionHandler((request, resolve) => {
			this.connection
				.requestPermission({
					sessionId: request.sessionId,
					toolCall: request.toolCall,
					options: request.options,
				})
				.then(resolve)
				.catch((error) => {
					Logger.debug("[AcpAgent] Error requesting permission:", error)
					resolve({ outcome: { outcome: "cancelled" } })
				})
		})
	}

	/**
	 * Subscribe to session events and forward them to the connection.
	 */
	private subscribeToSessionEvents(sessionId: string): void {
		if (this.subscribedSessions.has(sessionId)) {
			return
		}

		const emitter = this.diracAgent.emitterForSession(sessionId)

		// Forward session update by adding the sessionUpdate discriminator
		const forwardSessionUpdate = <K extends SessionUpdateType>(eventName: K) => {
			emitter.on(eventName, (payload: Record<string, unknown>) => {
				const update = {
					sessionUpdate: eventName,
					...payload,
				} as acp.SessionUpdate
				this.connection.sessionUpdate({ sessionId, update }).catch((error) => {
					Logger.error(`[AcpAgent] Error forwarding ${eventName}:`, error)
				})
			})
		}

		// Forward all standard session updates
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

		// Handle errors specially (not part of ACP SessionUpdate)
		emitter.on("error", (error) => {
			Logger.error("[AcpAgent] Session error:", error)
		})

		this.subscribedSessions.add(sessionId)
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
		return await this.diracAgent.initialize(params, this.connection)
	}

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const response = await this.diracAgent.newSession(params)
		// Subscribe to events for this new session
		this.subscribeToSessionEvents(response.sessionId)
		this.scheduleSessionSetupUpdates(response.sessionId)
		return response
	}

	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		const response = await this.diracAgent.loadSession(params)
		this.subscribeToSessionEvents(params.sessionId)
		// Replay history after subscribing so events reach the client
		await this.diracAgent.replayLoadedSessionHistory(params.sessionId)
		this.scheduleSessionSetupUpdates(params.sessionId)
		return response
	}

	async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		return this.diracAgent.unstable_listSessions(params)
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		// Ensure we're subscribed to this session's events
		this.subscribeToSessionEvents(params.sessionId)
		await this.ensureSessionSetupUpdates(params.sessionId)
		return this.diracAgent.prompt(params)
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		return this.diracAgent.cancel(params)
	}

	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		return this.diracAgent.setSessionMode(params)
	}

	async unstable_setSessionModel(params: acp.SetSessionModelRequest): Promise<acp.SetSessionModelResponse> {
		return this.diracAgent.unstable_setSessionModel(params)
	}

	async unstable_setSessionConfigOption(
		params: acp.SetSessionConfigOptionRequest,
	): Promise<acp.SetSessionConfigOptionResponse> {
		return this.diracAgent.unstable_setSessionConfigOption(params)
	}

	async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		return this.diracAgent.authenticate(params)
	}

	async shutdown(): Promise<void> {
		this.subscribedSessions.clear()
		this.initializedSessions.clear()
		this.sessionInitializationPromises.clear()
		return this.diracAgent.shutdown()
	}
}
