import * as fs from "node:fs/promises"
import type * as acp from "@agentclientprotocol/sdk"
import type { ApiConfiguration } from "@shared/api"
import { ApiConfigurationError, ApiConfigurationErrorCode, validateApiConfiguration } from "@/core/api"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger.js"
import { copyTaskRuntimeSettings, getSessionRuntimeConfig } from "../acp/acp-session-runtime-config.js"
import { getLatestTaskIdForSession } from "../acp/acp-session-tasks.js"
import { getSessionWorktree } from "../acp/acp-session-worktrees.js"
import type { DiracAcpSession, DiracAgentOptions } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import type { SessionCatalog } from "./sessionCatalog.js"
import type { SessionConfigManager } from "./sessionConfig.js"
import { getHistoryItemCwd } from "./sessionHistory.js"
import type { SessionRuntimeManager } from "./sessionRuntime.js"
import type { SessionWorktreeManager } from "./sessionWorktrees.js"
import { worktreeProvisioningRequest } from "./sessionWorktrees.js"
import type { AcpSessionState } from "./types.js"

interface SessionLifecycleDeps {
	options: DiracAgentOptions
	sessions: Map<string, DiracAcpSession>
	sessionStates: Map<string, AcpSessionState>
	getDataDir(): string
	createController(workspaceCwd: string): Controller
	setController(session: DiracAcpSession, controller: Controller): void
	getController(session: DiracAcpSession): Controller | undefined
	runtime: SessionRuntimeManager
	sessionConfig: SessionConfigManager
	worktrees: SessionWorktreeManager
	catalog: SessionCatalog
}

/**
 * Owns ACP session lifecycle: creating sessions (with optional provisioned
 * worktrees), loading persisted sessions from task history, resuming them, and
 * publishing post-subscription setup updates.
 */
export class SessionLifecycleManager {
	constructor(private readonly deps: SessionLifecycleDeps) {}

	/**
	 * Create a new session.
	 *
	 * A session represents a conversation/task with the agent. The client
	 * provides the working directory.
	 */
	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const sessionId = crypto.randomUUID()
		const sessionOverrides = this.deps.runtime.createStartupSessionOverrides()

		Logger.debug("[DiracAgent] newSession called:", {
			sessionId,
			cwd: params.cwd,
		})

		const worktreeRequest = worktreeProvisioningRequest(params)
		const worktree = worktreeRequest
			? await this.deps.worktrees.provisionSessionWorktree(sessionId, params.cwd, worktreeRequest)
			: undefined
		const sessionCwd = worktree?.worktreePath ?? params.cwd

		// Create Controller for this session
		const controller = this.deps.createController(sessionCwd)

		// Create session record with all resources
		const session: DiracAcpSession = {
			sessionId,
			cwd: sessionCwd,
			mode: sessionOverrides.mode as "act" | "plan",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			reservedTaskId: sessionId,
		}

		const configOptions = await this.deps.sessionConfig.getSessionConfigOptions(session, sessionOverrides)

		this.deps.setController(session, controller)

		this.deps.sessions.set(sessionId, session)
		this.deps.runtime.initializeSessionOverrides(sessionId, sessionOverrides)
		this.deps.runtime.persistSessionOverrides(sessionId)

		// Initialize session state
		const sessionState: AcpSessionState = {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		}

		this.deps.sessionStates.set(sessionId, sessionState)

		return {
			sessionId,
			modes: this.deps.sessionConfig.getSessionModeState(session.mode, sessionOverrides),
			configOptions,
			...(worktree
				? {
						_meta: {
							"dev.dirac/worktree": {
								path: worktree.worktreePath,
								branch: worktree.branch,
								...(worktree.targetBranch ? { targetBranch: worktree.targetBranch } : {}),
							},
						},
					}
				: {}),
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
		const existingSession = this.deps.sessions.get(sessionId)
		if (existingSession) {
			return this.deps.runtime.runSessionRuntimeMutation(sessionId, async () => {
				const configOptions = await this.deps.runtime.getNormalizedConfigOptions(existingSession)
				const sessionOverrides = this.deps.runtime.acpSessionOverrides.get(sessionId)!
				return {
					modes: this.deps.sessionConfig.getSessionModeState(existingSession.mode, sessionOverrides),
					configOptions,
				}
			})
		}

		Logger.debug("[DiracAgent] loadSession called:", { sessionId })

		const persistedRuntimeConfig = getSessionRuntimeConfig(this.deps.getDataDir(), sessionId)
		if (!persistedRuntimeConfig) {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.SessionRuntimeMissing,
				`Task runtime configuration not found for ACP session ${sessionId}; this session predates task-owned runtime configuration and cannot be loaded safely`,
				"Start a new session under the current provider and model settings.",
			)
		}
		const persistedMode = persistedRuntimeConfig.settings.mode
		if (persistedMode !== "plan" && persistedMode !== "act") {
			throw new ApiConfigurationError(
				ApiConfigurationErrorCode.SessionRuntimeMalformed,
				`Task runtime configuration for ACP session ${sessionId} has no valid mode`,
				"Start a new session or repair/remove the corrupted runtime record before retrying.",
			)
		}

		// Resolve the actual taskId: check the replacement-task map first (multi-task session),
		// then fall back to sessionId itself (the common single-task case where taskId === sessionId).
		const resolvedTaskId = getLatestTaskIdForSession(sessionId) ?? sessionId

		const persistedHistory = (StateManager.get().getGlobalStateKey("taskHistory") || []).find(
			(item) => item.id === resolvedTaskId,
		)

		const ownedWorktree = getSessionWorktree(sessionId)
		if (ownedWorktree) {
			try {
				await fs.access(ownedWorktree.worktreePath)
			} catch {
				throw new Error(
					`ACP session ${sessionId} owns a missing worktree at ${ownedWorktree.worktreePath}; restore it or delete the session before loading`,
				)
			}
		}

		const historyCwd =
			ownedWorktree?.worktreePath ??
			(persistedHistory
				? getHistoryItemCwd(persistedHistory, params.cwd, this.deps.options.cwd)
				: persistedRuntimeConfig.cwd || params.cwd || this.deps.options.cwd)
		if (!historyCwd) throw new Error(`Working directory not found for ACP session ${sessionId}`)

		const controller = this.deps.createController(historyCwd)

		const session: DiracAcpSession = {
			sessionId,
			cwd: historyCwd,
			mode: persistedMode,
			createdAt: persistedRuntimeConfig.createdAt ?? Date.now(),
			lastActivityAt: Date.now(),
			...(persistedHistory
				? {
						isLoadedFromHistory: true,
						loadedTaskId: resolvedTaskId,
					}
				: { reservedTaskId: sessionId }),
		}
		const sessionOverrides = copyTaskRuntimeSettings(persistedRuntimeConfig.settings)
		const configOptions = await this.deps.sessionConfig.getSessionConfigOptions(session, sessionOverrides)
		const loadRuntime = StateManager.get().captureEffectiveTaskConfiguration(sessionOverrides)
		validateApiConfiguration(loadRuntime.apiConfiguration as ApiConfiguration, persistedMode)

		if (persistedHistory) {
			await controller.getTaskWithId(resolvedTaskId)
		}

		this.deps.setController(session, controller)
		this.deps.sessions.set(sessionId, session)
		this.deps.runtime.acpSessionOverrides.set(sessionId, sessionOverrides)
		this.deps.sessionStates.set(sessionId, {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		})
		this.deps.runtime.writeSessionRuntimeConfig(session, sessionOverrides)

		return {
			modes: this.deps.sessionConfig.getSessionModeState(session.mode, sessionOverrides),
			configOptions,
		}
	}

	/**
	 * Resume an existing session without replaying historical session updates.
	 *
	 * Unlike `loadSession`, this restores the same persisted task context but leaves
	 * transcript ownership with the reattaching client.
	 */
	async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
		return this.loadSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers ?? [],
		})
	}

	/**
	 * Emit initial session updates that must happen after the ACP stdio wrapper
	 * has registered and subscribed to the session.
	 */
	async publishSessionSetupUpdates(sessionId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}

		const controller = this.deps.getController(session)
		if (!controller) {
			throw new Error("Controller not initialized for session. This is a bug in the ACP agent setup.")
		}

		await this.deps.catalog.sendAvailableCommands(sessionId, controller)
		await this.deps.runtime.emitConfigOptionsUpdate(sessionId)
	}
}
