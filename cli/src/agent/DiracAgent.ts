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
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk"
import { modelSupportsInferenceSpeed, providerSupportsInferenceSpeed, type ApiConfiguration, type ApiProvider } from "@shared/api"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { isPlanResponseCard } from "@shared/responseTool"
import { CLI_ONLY_COMMANDS, VSCODE_ONLY_COMMANDS } from "@shared/slashCommands"
import { getExplicitDiracSettingsFromEnv, getProviderFromEnv, getSettingsFromEnv } from "@shared/storage/env-config"
import { getProviderModelIdKey, getProviderModelInfoKey } from "@shared/storage/provider-keys"
import {
	INFERENCE_SPEED_OPTIONS,
	isInferenceSpeed,
	isOpenaiReasoningEffort,
	OPENAI_REASONING_EFFORT_OPTIONS,
} from "@shared/storage/types"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import simpleGit from "simple-git"
import { ApiConfigurationError, ApiConfigurationErrorCode, validateApiConfiguration } from "@/core/api"
import { Controller } from "@/core/controller"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController.js"
import type { ToolPermissionRule } from "@/core/permissions/types.js"
import { getSavedDiracMessages, setRuntimeHooksDir } from "@/core/storage/disk"
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
import type { Settings } from "@/shared/storage/state-keys"
import { createWorktree, deleteWorktree, getGitRootPath } from "@/utils/git-worktree"
import { version as AGENT_VERSION } from "../../package.json"
import { ACPHostBridgeClientProvider } from "../acp/ACPHostBridgeClientProvider.js"
import { ACPTextFileAccess } from "../acp/ACPTextFileAccess.js"
import { AcpTerminalManager } from "../acp/AcpTerminalManager.js"
import {
	deletePinnedSessionMessages,
	getPinnedSessionMessages,
	type PinnedSessionMessage,
	pinSessionMessage,
	unpinSessionMessage,
} from "../acp/acp-session-pins.js"
import {
	copyTaskRuntimeSettings,
	deleteSessionRuntimeConfig,
	getSessionRuntimeConfig,
	setSessionRuntimeConfig,
	TASK_RUNTIME_SETTINGS_KEYS,
} from "../acp/acp-session-runtime-config.js"
import { deleteTasksForSession, getLatestTaskIdForSession, recordTaskForSession } from "../acp/acp-session-tasks.js"
import {
	deleteSessionUpdates,
	getSessionUpdates,
	recordClientAnnotation,
	recordSessionUpdate,
	SEQUENCE_META_KEY,
} from "../acp/acp-session-updates.js"
import {
	deleteSessionWorktree,
	getSessionWorktree,
	type SessionWorktree,
	setSessionWorktree,
} from "../acp/acp-session-worktrees.js"
import type { ActiveAcpSessionIdResolver } from "../acp/active-session.js"
import { initCoreServices } from "../initCoreServices.js"
import { isSelectedProviderConfigured } from "../utils/auth.js"
import { getDefaultModelId } from "../utils/model-metadata.js"
import { getCliBinaryPath } from "../utils/path.js"
import { isValidCliProvider } from "../utils/providers.js"
import { CliContextResult, initializeCliContext } from "../vscode-context.js"
import { AcpAuthenticationManager } from "./AcpAuthenticationManager.js"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { translateMessage } from "./messageTranslator.js"
import { parsePromptContent } from "./promptContent.js"
import { ProviderConfigurationManager } from "./providerConfiguration.js"
import type { DiracAcpSession, DiracAgentOptions, ElicitationHandler, PermissionHandler } from "./public-types.js"
import { AcpSessionStatus } from "./public-types.js"
import { ACP_REVIEW_COMMANDS, handleAcpReviewCommand } from "./review.js"
import { type AcpModeId, SessionConfigManager } from "./sessionConfig.js"
import {
	getHistoryItemCwd,
	getTaskIdsForSession,
	historyItemToSessionInfo,
	listLatestConversationHistoryItems,
	resolveHistorySession,
} from "./sessionHistory.js"
import { TaskMessageBridge } from "./taskMessageBridge.js"
import { type AcpSessionState } from "./types.js"

const SESSION_TITLE_MAX_LENGTH = 80

function summarizeSessionTitle(promptText: string): string {
	const firstLine = promptText.trim().split("\n")[0].replace(/\s+/g, " ")
	return firstLine.length <= SESSION_TITLE_MAX_LENGTH
		? firstLine
		: `${firstLine.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
}

type WorkspaceCheckpoint = {
	id: string
	createdAt: string
	messageId: string
	commitHash: string
}

function workspaceCheckpointsFromMessages(messages: DiracMessage[]): WorkspaceCheckpoint[] {
	return messages
		.filter((message) => message.lastCheckpointHash)
		.map((message) => ({
			id: message.id,
			createdAt: new Date(message.ts).toISOString(),
			messageId: message.id,
			commitHash: message.lastCheckpointHash!,
		}))
		.reverse()
}

type WorktreeProvisioningRequest = {
	baseBranch?: string
}

function worktreeProvisioningRequest(params: acp.NewSessionRequest): WorktreeProvisioningRequest | undefined {
	const requested = params._meta?.["dev.dirac/worktree"]
	if (requested === undefined || requested === false) {
		return undefined
	}
	if (requested === true) {
		return {}
	}
	if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
		throw new Error("dev.dirac/worktree must be true or an object with an optional baseBranch")
	}

	const baseBranch = (requested as Record<string, unknown>).baseBranch
	if (baseBranch !== undefined && typeof baseBranch !== "string") {
		throw new Error("dev.dirac/worktree.baseBranch must be a string")
	}
	return { ...(baseBranch === undefined ? {} : { baseBranch }) }
}

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

		if (!force && this.configuringSessions.has(sessionId)) {
			throw new Error(`Session ${sessionId} is applying a runtime configuration change`)
		}
		if (this.sessionStates.get(sessionId)?.status === AcpSessionStatus.Processing) {
			await this.cancel({ sessionId })
		}

		await this.#sessionControllers.get(session)?.dispose()
		this.sessions.delete(sessionId)
		this.sessionStates.delete(sessionId)
		this.sessionEmitters.delete(sessionId)
		this.acpSessionOverrides.delete(sessionId)
		this.activePromptOverrides.delete(sessionId)
		this.configuringSessions.delete(sessionId)
		this.sessionRuntimeMutationTails.delete(sessionId)
		this.bridges.delete(sessionId)
		this.releasePromptSteeringOwnership(sessionId)
	}

	/** Delete a session's active resources, owned worktree, and persisted task history. */
	private async deleteSessionResources(sessionId: string): Promise<void> {
		await this.releaseSessionResources(sessionId)

		const worktree = getSessionWorktree(sessionId)
		if (worktree) {
			const removal = await deleteWorktree(worktree.sourceCwd, worktree.worktreePath, true)
			if (!removal.success) {
				throw new Error(removal.message)
			}
			deleteSessionWorktree(sessionId)
		}

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

	/** Create a branch-backed git worktree owned exclusively by one ACP session. */
	private async provisionSessionWorktree(
		sessionId: string,
		cwd: string,
		request: WorktreeProvisioningRequest,
	): Promise<SessionWorktree> {
		const sourceCwd = await getGitRootPath(cwd)
		if (!sourceCwd) {
			throw new Error("dev.dirac/worktree requires cwd to be inside a git repository")
		}

		const git = simpleGit(sourceCwd)
		const checkedOutBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
		const targetBranch = request.baseBranch ?? (checkedOutBranch === "HEAD" ? undefined : checkedOutBranch)
		const branch = `dirac/acp-${sessionId}`
		const worktreeDirectory = path.join(path.dirname(sourceCwd), ".dirac-worktrees")
		const worktreePath = path.join(worktreeDirectory, `${path.basename(sourceCwd)}-${sessionId}`)
		await fs.mkdir(worktreeDirectory, { recursive: true })

		const result = await createWorktree(sourceCwd, worktreePath, {
			branch,
			baseBranch: targetBranch,
			createNewBranch: true,
		})
		if (!result.success || !result.worktree) {
			throw new Error(result.message)
		}

		const worktree = {
			sourceCwd,
			worktreePath: result.worktree.path,
			branch: result.worktree.branch,
			...(targetBranch ? { targetBranch } : {}),
		}
		setSessionWorktree(sessionId, worktree)
		return worktree
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
		const worktree = getSessionWorktree(sessionId)
		if (!worktree) {
			throw new Error(`Session ${sessionId} has no Dirac-provisioned worktree`)
		}

		const activeSession = this.sessions.get(sessionId)
		const activeController = activeSession ? this.#sessionControllers.get(activeSession) : undefined
		if (activeController?.task) {
			throw new Error(`Cannot integrate ACP session ${sessionId} while its task is active; close the session first`)
		}

		const branch = targetBranch ?? worktree.targetBranch
		if (!branch) {
			throw new Error("targetBranch is required when the session was created from a detached HEAD")
		}

		const targetGit = simpleGit(worktree.sourceCwd)
		const checkedOutBranch = (await targetGit.revparse(["--abbrev-ref", "HEAD"])).trim()
		if (checkedOutBranch !== branch) {
			throw new Error(`Target branch ${branch} is not checked out at ${worktree.sourceCwd}`)
		}
		if (!(await targetGit.status()).isClean()) {
			throw new Error(`Target branch ${branch} has uncommitted changes`)
		}

		const worktreeGit = simpleGit(worktree.worktreePath)
		if (!(await worktreeGit.status()).isClean()) {
			throw new Error("Session worktree has uncommitted changes; commit or stash them before integrating")
		}

		await targetGit.merge([worktree.branch, "--no-edit"])
		if (deleteAfterMerge) {
			await targetGit.raw(["worktree", "remove", "--force", worktree.worktreePath])
			await targetGit.deleteLocalBranch(worktree.branch)
			deleteSessionWorktree(sessionId)
		}

		return {
			sourceBranch: worktree.branch,
			targetBranch: branch,
			worktreePath: worktree.worktreePath,
		}
	}
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

	/** Permission handler callback for requesting user permission */
	private permissionHandler?: PermissionHandler

	/** Elicitation handler supplied by the ACP transport. */
	private elicitationHandler?: ElicitationHandler

	/** Client capabilities received during initialization */
	private clientCapabilities?: acp.ClientCapabilities

	/** Per-session bridges isolate message, tool-call, and streaming state. */
	private readonly bridges: Map<string, TaskMessageBridge> = new Map()

	/** Whispers received while a processing prompt has not yet bound its target task. */
	private readonly pendingWhispers = new Map<string, string[]>()

	/** The task selected for the active prompt. Undefined means task selection is still in progress. */
	private readonly promptTasks = new Map<string, NonNullable<Controller["task"]>>()

	private unbindPromptTask(sessionId: string): void {
		this.promptTasks.delete(sessionId)
	}

	private releasePromptSteeringOwnership(sessionId: string): void {
		this.pendingWhispers.delete(sessionId)
		this.unbindPromptTask(sessionId)
	}

	private createTaskMessageBridge(): TaskMessageBridge {
		return new TaskMessageBridge({
			getSession: (sessionId: string) => this.sessions.get(sessionId),
			getController: (session: DiracAcpSession) => this.#sessionControllers.get(session),
			requestPermission: (sessionId, toolCall, options) => this.requestPermission(sessionId, toolCall, options),
			emitSessionUpdate: (sessionId, update) => this.emitSessionUpdate(sessionId, update),
			persistPermissionRule: (sessionId, toolCall, action) => this.persistPermissionRule(sessionId, toolCall, action),
			getClientCapabilities: () => this.clientCapabilities,
			requestElicitation: (request) => this.requestElicitation(request),
			emitSteeringStatus: (sessionId, steeringMessageId, status) =>
				this.emitSteeringStatus(sessionId, steeringMessageId, status),
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
		const sessionId = params.sessionId
		const text = params.text
		if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) {
			Logger.debug("[DiracAgent] Ignoring malformed dev.dirac/whisper notification")
			return
		}
		if (this.sessionStates.get(sessionId)?.status !== AcpSessionStatus.Processing) {
			Logger.debug("[DiracAgent] Ignoring whisper outside an active turn:", sessionId)
			return
		}

		const task = this.promptTasks.get(sessionId)
		if (!task) {
			this.bufferWhisper(sessionId, text)
			return
		}

		if (!task.canAcceptSteeringMessage()) {
			if (task.taskState.abort || task.taskState.pendingTaskReplacement) {
				this.unbindPromptTask(sessionId)
			}
			this.bufferWhisper(sessionId, text)
			return
		}

		try {
			const steeringMessageId = await task.enqueueSteeringMessage(text)
			this.emitSteeringStatus(sessionId, steeringMessageId, "queued")
		} catch (error) {
			if (task.canAcceptSteeringMessage()) throw error
			this.unbindPromptTask(sessionId)
			this.bufferWhisper(sessionId, text)
		}
	}

	private bufferWhisper(sessionId: string, text: string): void {
		const whispers = this.pendingWhispers.get(sessionId) ?? []
		whispers.push(text.trim())
		this.pendingWhispers.set(sessionId, whispers)
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
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		const controller =
			this.#sessionControllers.get(session) ?? (session as DiracAcpSession & { controller?: Controller }).controller
		const task = controller?.task
		const message = task?.messageStateHandler.getMessageById(messageId)
		if (!message) throw new Error(`Message not found: ${messageId}`)
		const content = this.pinnedContentFromMessage(message)
		if (!content) throw new Error(`Message cannot be pinned: ${messageId}`)
		pinSessionMessage(sessionId, {
			messageId,
			content,
			pinnedAt: new Date().toISOString(),
		})
		this.applyPinnedContext(task, sessionId)
		await this.emitPinnedMessagesUpdate(sessionId, "pinned")
	}

	async unpinMessage(sessionId: string, messageId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		if (!unpinSessionMessage(sessionId, messageId)) throw new Error(`Message is not pinned: ${messageId}`)
		this.applyPinnedContext(
			(this.#sessionControllers.get(session) ?? (session as DiracAcpSession & { controller?: Controller }).controller)
				?.task,
			sessionId,
		)
		await this.emitPinnedMessagesUpdate(sessionId, "unpinned")
	}

	listPinnedMessages(sessionId: string): PinnedSessionMessage[] {
		if (!this.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
		return getPinnedSessionMessages(sessionId)
	}
	private pinnedContentFromMessage(message: DiracMessage): string | undefined {
		if (message.content.type === DiracMessageType.MARKDOWN) return message.content.content || undefined
		if (message.content.type === DiracMessageType.CARD) return message.content.card.body || message.content.card.header
		return undefined
	}
	private pinnedContextForSession(sessionId: string): string | undefined {
		const pins = getPinnedSessionMessages(sessionId)
		if (pins.length === 0) return undefined
		return [
			"<pinned_messages>",
			...pins.map((pin) => `<message id="${pin.messageId}">\n${pin.content}\n</message>`),
			"</pinned_messages>",
		].join("\n")
	}

	private pinnedContextInitializationOptions(sessionId: string, runtimeOverrides?: Partial<Settings>) {
		return {
			pinnedContext: this.pinnedContextForSession(sessionId),
			onContextCompacted: () => void this.emitPinnedMessagesUpdate(sessionId, "compacted"),
			switchToActMode: () => this.switchSessionToActMode(sessionId),
			enqueueSteeringMessages: (task: NonNullable<Controller["task"]>) => this.bindPromptTask(sessionId, task),
			...(runtimeOverrides ? { runtimeConfigurationOverrides: copyTaskRuntimeSettings(runtimeOverrides) } : {}),
		}
	}

	private activePromptInitializationOptions(sessionId: string) {
		const activeOverrides = this.activePromptOverrides.get(sessionId)
		if (!activeOverrides) throw new Error(`Active prompt runtime configuration not found: ${sessionId}`)
		return this.pinnedContextInitializationOptions(sessionId, activeOverrides)
	}

	private async bindPromptTask(sessionId: string, task: NonNullable<Controller["task"]>): Promise<void> {
		this.promptTasks.set(sessionId, task)
		const session = this.sessions.get(sessionId)!
		if (session.taskId !== task.taskId) {
			session.taskId = task.taskId
			this.persistSessionOverrides(sessionId)
		}
		if (!task.canAcceptSteeringMessage()) return

		const whispers = this.pendingWhispers.get(sessionId)
		if (!whispers) return

		while (whispers.length > 0) {
			const steeringMessageId = await task.enqueueSteeringMessage(whispers[0])
			this.emitSteeringStatus(sessionId, steeringMessageId, "queued")
			whispers.shift()
		}
		this.pendingWhispers.delete(sessionId)
	}

	private emitSteeringStatus(sessionId: string, steeringMessageId: string, status: "queued" | "sent"): void {
		this.emitterForSession(sessionId).emit("steering_status", { steeringMessageId, status })
	}

	private applyPinnedContext(
		task:
			| {
				taskState: { pinnedContext?: string }
				setContextCompactionObserver: (observer: () => void) => void
			}
			| undefined,
		sessionId: string,
	): void {
		if (!task) return
		task.taskState.pinnedContext = this.pinnedContextForSession(sessionId)
		task.setContextCompactionObserver(() => void this.emitPinnedMessagesUpdate(sessionId, "compacted"))
	}
	private async emitPinnedMessagesUpdate(sessionId: string, event: "pinned" | "unpinned" | "compacted"): Promise<void> {
		this.emitterForSession(sessionId).emit("pinned_messages_update", {
			event,
			messages: getPinnedSessionMessages(sessionId),
		})
	}

	/** List the workspace snapshots created at task and tool boundaries for a session. */
	async listWorkspaceCheckpoints(sessionId: string): Promise<WorkspaceCheckpoint[]> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}

		const controller = this.#sessionControllers.get(session)
		if (!controller) {
			throw new Error(`Controller not found for session: ${sessionId}`)
		}

		const task = controller.task
		if (task) {
			return workspaceCheckpointsFromMessages(task.messageStateHandler.getDiracMessages())
		}

		const taskId = session.loadedTaskId ?? getLatestTaskIdForSession(sessionId) ?? sessionId
		await controller.getTaskWithId(taskId)
		const messages = await getSavedDiracMessages(taskId)
		return workspaceCheckpointsFromMessages(messages)
	}

	/** Restore both task history and workspace files to one previously listed checkpoint. */
	async restoreWorkspaceCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
		await this.checkpointRestore(sessionId, checkpointId, "taskAndWorkspace")

		const session = this.sessions.get(sessionId)
		if (session) {
			session.lastActivityAt = Date.now()
			await this.emitSessionInfoUpdate(session)
		}
	}

	/** Provider routing configured through ACP's provider provisioning methods. */
	private readonly providerConfiguration = new ProviderConfigurationManager()

	/** Session config manager for mode, model, provider, reasoning effort, and thinking budget */
	private readonly sessionConfig = new SessionConfigManager(this.providerConfiguration)

	/**
	 * Legacy host services remain process-global, so prompt execution is still
	 * serialized. Task operational configuration itself is session/task-owned.
	 */
	private activePrompt: Promise<void> = Promise.resolve()

	/** Session currently owning the serialized host-service prompt path. */
	private activePromptSessionId?: string

	/** Authoritative committed, persisted runtime choices for each ACP session. */
	private readonly acpSessionOverrides: Map<string, Partial<Settings>> = new Map()

	/** Session-owned mirror of the configuration currently committed to the active Task. */
	private readonly activePromptOverrides: Map<string, Partial<Settings>> = new Map()

	/** Config mutations are serialized independently from prompt lifecycle state. */
	private readonly configuringSessions: Set<string> = new Set()

	/** Per-session barriers ensure runtime snapshots are read and committed in order. */
	private readonly sessionRuntimeMutationTails: Map<string, Promise<void>> = new Map()

	/**
	 * Highest persisted journal sequence per session for this process, used to
	 * synthesize a monotonic sequence when journal persistence fails so the live
	 * ACP emit can continue without crashing the session.
	 */
	private readonly lastJournalSequence = new Map<string, number>()

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
		{
			resolve: (response: acp.PromptResponse) => void
			resolved: { value: boolean }
		}
	> = new Map()

	/** Pending permission requests, so session/cancel can abort the client interaction. */
	private readonly pendingPermissionResolvers: Map<string, (response: acp.RequestPermissionResponse) => void> = new Map()

	/** Pending elicitation requests, so session/cancel can abort the client interaction. */
	private readonly pendingElicitationResolvers: Map<string, (response: acp.CreateElicitationResponse) => void> = new Map()

	constructor(options: DiracAgentOptions) {
		this.options = options
		this.authentication = new AcpAuthenticationManager({ diracDir: options.diracDir, cwd: options.cwd })
		setRuntimeHooksDir(options.hooksDir)
		// ctx is initialized lazily in initialize() so that IO failures (e.g. an
		// unwritable --config path) surface as a JSON-RPC error response on
		// `initialize` rather than killing the process before the client can
		// observe anything.
	}

	private applyStartupProviderInfrastructure(): void {
		const { provider, model, mode, thinkingBudgetTokens, reasoningEffort, inferenceSpeed } = this.options

		if (mode && !["plan", "act"].includes(mode)) {
			throw RequestError.invalidParams(undefined, `Invalid startup mode: ${mode}`)
		}
		if (thinkingBudgetTokens !== undefined && (!Number.isFinite(thinkingBudgetTokens) || thinkingBudgetTokens < 0)) {
			throw RequestError.invalidParams(undefined, `Invalid --thinking value: ${thinkingBudgetTokens}`)
		}
		if (reasoningEffort !== undefined && !isOpenaiReasoningEffort(reasoningEffort)) {
			throw RequestError.invalidParams(
				undefined,
				`Invalid --reasoning-effort value: ${reasoningEffort}. Expected one of: ${OPENAI_REASONING_EFFORT_OPTIONS.join(", ")}`,
			)
		}
		if (inferenceSpeed !== undefined && !isInferenceSpeed(inferenceSpeed)) {
			throw RequestError.invalidParams(
				undefined,
				`Invalid --speed value: ${inferenceSpeed}. Expected one of: ${INFERENCE_SPEED_OPTIONS.join(", ")}`,
			)
		}
		if (provider && !model) {
			throw RequestError.invalidParams(undefined, "--provider requires --model to be specified")
		}
		if (provider && !provider.startsWith("http://") && !provider.startsWith("https://") && !isValidCliProvider(provider)) {
			throw RequestError.invalidParams(undefined, `Invalid provider: ${provider}`)
		}

		if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
			StateManager.get().setApiConfiguration({ openAiBaseUrl: provider })
		}
	}

	private createStartupSessionOverrides(): Partial<Settings> {
		const { provider, model, mode: startupMode, autoApprove, yolo, thinkingBudgetTokens, reasoningEffort, inferenceSpeed } =
			this.options
		const stateManager = StateManager.get()
		const environmentSettings = getSettingsFromEnv()
		const effectiveDefaults: Partial<Settings> = {}

		for (const key of TASK_RUNTIME_SETTINGS_KEYS) {
			const systemDefault = stateManager.getSystemDefaultSettingsKey(key)
				; (effectiveDefaults as Record<keyof Settings, unknown>)[key] = systemDefault ?? environmentSettings[key]
		}
		Object.assign(effectiveDefaults, getExplicitDiracSettingsFromEnv())
		const environmentProvider = getProviderFromEnv()
		if (environmentProvider && isValidCliProvider(environmentProvider)) {
			effectiveDefaults.actModeApiProvider ??= environmentProvider
			effectiveDefaults.planModeApiProvider ??= environmentProvider
		}

		const overrides = copyTaskRuntimeSettings(effectiveDefaults)
		overrides.mode ??= "act"
		overrides.autoApproveAllToggled ??= false
		overrides.yoloModeToggled ??= false
		overrides.planActSeparateModelsSetting ??= false

		if (startupMode) overrides.mode = startupMode
		if (autoApprove !== undefined) overrides.autoApproveAllToggled = autoApprove
		if (yolo !== undefined) overrides.yoloModeToggled = yolo

		for (const mode of ["plan", "act"] as const) {
			const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			const defaultProvider = overrides[providerKey] as ApiProvider | undefined
			if (!defaultProvider) throw new Error(`No default API provider is configured for ${mode} mode`)

			const modelKey = getProviderModelIdKey(defaultProvider, mode)
			if (defaultProvider === "openai") {
				const profileNameKey = mode === "act" ? "actModeOpenAiProfileName" : "planModeOpenAiProfileName"
				const profileName = overrides[profileNameKey]
				const profiles =
					stateManager.getSystemDefaultSettingsKey("openAiCompatibleProfiles") ??
					environmentSettings.openAiCompatibleProfiles
				const profile = profileName ? profiles?.find((candidate) => candidate.name === profileName) : undefined
				if (profile) {
					const runtimeValues = overrides as Record<string, unknown>
					runtimeValues[modelKey] ||= profile.modelId
					const modelInfoKey = getProviderModelInfoKey(defaultProvider, mode)!
					runtimeValues[modelInfoKey] ||= structuredClone(profile.modelInfo)
				}
			}
			; (overrides as Record<string, unknown>)[modelKey] =
				(overrides[modelKey] as string | undefined) || getDefaultModelId(defaultProvider)

			const thinkingKey = mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"
			const reasoningKey = mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"
			const inferenceSpeedKey = mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
				; (overrides as Record<string, unknown>)[thinkingKey] ??= 0
				; (overrides as Record<string, unknown>)[reasoningKey] ??= "medium"
				; (overrides as Record<string, unknown>)[inferenceSpeedKey] ??= "default"
		}

		if (model) {
			let targetProvider: ApiProvider | undefined
			if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
				targetProvider = "openai"
			} else if (provider) {
				if (!isValidCliProvider(provider)) throw new Error(`Invalid provider: ${provider}`)
				targetProvider = provider as ApiProvider
			} else {
				const currentMode = overrides.mode
				targetProvider = overrides[currentMode === "act" ? "actModeApiProvider" : "planModeApiProvider"] as
					| ApiProvider
					| undefined
			}
			if (!targetProvider) throw new Error("--model requires a configured provider or an explicit --provider")

			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				; (overrides as Record<string, unknown>)[mode === "act" ? "actModeApiProvider" : "planModeApiProvider"] =
					targetProvider
					; (overrides as Record<string, unknown>)[getProviderModelIdKey(targetProvider, mode)] = model
				const modelInfoKey = getProviderModelInfoKey(targetProvider, mode)
				if (modelInfoKey) overrides[modelInfoKey] = undefined
				if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
					overrides[mode === "act" ? "actModeOpenAiProfileName" : "planModeOpenAiProfileName"] = undefined
				}
			}
		}

		if (thinkingBudgetTokens !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				overrides[mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"] = thinkingBudgetTokens
			}
		}
		if (reasoningEffort !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				overrides[mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"] = reasoningEffort
			}
		}
		if (inferenceSpeed !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				const provider = overrides[mode === "act" ? "actModeApiProvider" : "planModeApiProvider"] as ApiProvider
				const modelId = overrides[getProviderModelIdKey(provider, mode)] as string
				if (inferenceSpeed === "standard" && !providerSupportsInferenceSpeed(provider)) {
					throw new Error(`Provider ${provider} does not support inference speed controls`)
				}
				if (inferenceSpeed === "fast" && !modelSupportsInferenceSpeed(provider, modelId)) {
					throw new Error(`Model ${modelId} does not support Fast mode`)
				}
				overrides[mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"] = inferenceSpeed
			}
		}
		return overrides
	}

	private isStartupProviderConfigured(overrides: Partial<Settings>): boolean {
		const mode = overrides.mode === "plan" ? "plan" : "act"
		const configuration = StateManager.get().captureEffectiveTaskConfiguration(overrides).apiConfiguration
		return isSelectedProviderConfigured(configuration as ApiConfiguration, mode)
	}

	private initializeSessionOverrides(sessionId: string, persisted?: Partial<Settings>): Partial<Settings> {
		const overrides = copyTaskRuntimeSettings(persisted ?? this.createStartupSessionOverrides())
		this.acpSessionOverrides.set(sessionId, overrides)
		return overrides
	}

	private persistSessionOverrides(sessionId: string): void {
		const overrides = this.acpSessionOverrides.get(sessionId)
		if (!overrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Session not found: ${sessionId}`)
		this.writeSessionRuntimeConfig(session, overrides)
	}

	private writeSessionRuntimeConfig(session: DiracAcpSession, overrides: Partial<Settings>): void {
		setSessionRuntimeConfig(this.ctx.DATA_DIR, session.sessionId, {
			settings: overrides,
			cwd: session.cwd,
			createdAt: session.createdAt,
			taskId: session.taskId,
		})
	}

	private async runSessionRuntimeMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
		if (!this.sessionStates.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)

		const previousMutation = this.sessionRuntimeMutationTails.get(sessionId) ?? Promise.resolve()
		let releaseMutation!: () => void
		const mutationBarrier = new Promise<void>((resolve) => {
			releaseMutation = resolve
		})
		const mutationTail = previousMutation.then(() => mutationBarrier)
		this.sessionRuntimeMutationTails.set(sessionId, mutationTail)
		this.configuringSessions.add(sessionId)

		await previousMutation
		try {
			if (!this.sessionStates.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
			return await mutation()
		} finally {
			releaseMutation()
			if (this.sessionRuntimeMutationTails.get(sessionId) === mutationTail) {
				this.sessionRuntimeMutationTails.delete(sessionId)
				this.configuringSessions.delete(sessionId)
			}
		}
	}

	private resolveSessionTaskRuntime(
		overrides: Partial<Settings>,
		mode: "act" | "plan",
		task?: NonNullable<Controller["task"]>,
	) {
		if (task) {
			// Existing tasks retain their captured credentials and unrelated defaults.
			// Task synchronizes API-handler setting keys from this exact session patch.
			return { settings: overrides }
		}

		const captured = StateManager.get().captureEffectiveTaskConfiguration(overrides)
		validateApiConfiguration(captured.apiConfiguration as ApiConfiguration, mode)
		return {
			settings: overrides,
			apiConfiguration: captured.apiConfiguration as ApiConfiguration,
		}
	}

	private async refreshSessionProviderRuntime(session: DiracAcpSession): Promise<void> {
		const task = this.#sessionControllers.get(session)?.task
		if (!task) return
		const overrides = this.acpSessionOverrides.get(session.sessionId)
		if (!overrides) throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		const mode = overrides.mode
		if (mode !== "plan" && mode !== "act") throw new Error(`Invalid session mode: ${mode}`)
		const captured = StateManager.get().captureEffectiveTaskConfiguration(overrides)
		validateApiConfiguration(captured.apiConfiguration as ApiConfiguration, mode)
		await task.applyWorkingConfigurationUpdate({
			apiConfiguration: captured.apiConfiguration as ApiConfiguration,
		})
	}

	private async commitClientSessionRuntime(session: DiracAcpSession, nextOverrides: Partial<Settings>): Promise<void> {
		const nextMode = nextOverrides.mode
		if (nextMode !== "plan" && nextMode !== "act") throw new Error(`Invalid session mode: ${nextMode}`)

		if (!this.activePromptOverrides.has(session.sessionId)) {
			await this.replaceSessionRuntimeConfig(session, nextOverrides, nextMode)
			return
		}

		await this.applyActivePromptRuntime(
			session,
			nextOverrides,
			nextMode,
			() => this.writeSessionRuntimeConfig(session, nextOverrides),
		)
		this.acpSessionOverrides.set(session.sessionId, nextOverrides)
	}

	private async applyActivePromptRuntime(
		session: DiracAcpSession,
		nextOverrides: Partial<Settings>,
		nextMode: "act" | "plan",
		beforeCommit: () => void | Promise<void>,
	): Promise<void> {
		const task = this.#sessionControllers.get(session)?.task
		const runtime = this.resolveSessionTaskRuntime(nextOverrides, nextMode, task)
		if (task) await task.applyWorkingConfigurationUpdate(runtime, beforeCommit)
		else await beforeCommit()
		this.activePromptOverrides.set(session.sessionId, nextOverrides)
		session.mode = nextMode
	}

	private async refreshTaskRuntime(session: DiracAcpSession, overrides: Partial<Settings>): Promise<void> {
		const task = this.#sessionControllers.get(session)?.task
		if (!task) return
		const mode = overrides.mode
		if (mode !== "plan" && mode !== "act") throw new Error(`Invalid session mode: ${mode}`)
		await task.applyWorkingConfigurationUpdate(this.resolveSessionTaskRuntime(overrides, mode, task))
	}

	private async replaceSessionRuntimeConfig(
		session: DiracAcpSession,
		nextOverrides: Partial<Settings>,
		nextMode: "act" | "plan",
	): Promise<void> {
		if (!this.acpSessionOverrides.has(session.sessionId)) {
			throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		}

		const task = this.#sessionControllers.get(session)?.task
		const runtime = this.resolveSessionTaskRuntime(nextOverrides, nextMode, task)
		const persist = () => this.writeSessionRuntimeConfig(session, nextOverrides)

		if (task) await task.applyWorkingConfigurationUpdate(runtime, persist)
		else persist()

		this.acpSessionOverrides.set(session.sessionId, nextOverrides)
		session.mode = nextMode
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

	/** Set the transport callback used for ACP elicitation. */
	setElicitationHandler(handler: ElicitationHandler): void {
		this.elicitationHandler = handler
	}

	private async requestElicitation(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
		if (!this.elicitationHandler) {
			return { action: "cancel" }
		}

		const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined
		return await new Promise((resolve) => {
			let settled = false
			const settle = (response: acp.CreateElicitationResponse) => {
				if (settled) return
				settled = true
				if (sessionId && this.pendingElicitationResolvers.get(sessionId) === settle) {
					this.pendingElicitationResolvers.delete(sessionId)
				}
				resolve(response)
			}
			if (sessionId) {
				this.pendingElicitationResolvers.get(sessionId)?.({ action: "cancel" })
				this.pendingElicitationResolvers.set(sessionId, settle)
			}
			this.elicitationHandler!(request, settle)
		})
	}

	/**
	 * Stores ACP “always” decisions in the project's `.dirac/permissions.json`.
	 * The rule applies to the matching tool across every session opened for this workspace.
	 */
	private async persistPermissionRule(
		sessionId: string,
		toolCall: acp.ToolCall | acp.ToolCallUpdate,
		action: "allow" | "deny",
	): Promise<void> {
		const task = this.permissionTaskForSession(sessionId)

		const rawInput = toolCall.rawInput as Record<string, unknown> | undefined
		const commands = rawInput?.commands
		const command =
			Array.isArray(commands) && commands.length === 1 && typeof commands[0] === "object" && commands[0] !== null
				? (commands[0] as Record<string, unknown>).command
				: undefined

		const rule: ToolPermissionRule =
			typeof command === "string"
				? { tool: "execute_command", pattern: command, action }
				: { tool: this.permissionRuleToolName(toolCall), action }

		await task.addPermissionRule(rule)
	}

	/** List persisted project permission rules for an ACP session. */
	async listPermissionRules(sessionId: string): Promise<ToolPermissionRule[]> {
		const task = this.activePermissionTaskForSession(sessionId)
		if (task) {
			return await task.listPermissionRules()
		}

		return await this.withSessionPermissionController(sessionId, (controller) => controller.listRules())
	}

	/** Delete one persisted project permission rule for an ACP session. */
	async deletePermissionRule(sessionId: string, rule: ToolPermissionRule): Promise<void> {
		const task = this.activePermissionTaskForSession(sessionId)
		if (task) {
			await task.deletePermissionRule(rule)
			return
		}

		await this.withSessionPermissionController(sessionId, (controller) => controller.deleteRule(rule))
	}

	private activePermissionTaskForSession(sessionId: string) {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`)
		}
		return this.#sessionControllers.get(session)?.task
	}

	private async withSessionPermissionController<T>(
		sessionId: string,
		operation: (controller: CommandPermissionController) => Promise<T>,
	): Promise<T> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`)
		}

		const controller = new CommandPermissionController()
		await controller.initialize(session.cwd)
		try {
			return await operation(controller)
		} finally {
			await controller.dispose()
		}
	}

	private permissionTaskForSession(sessionId: string) {
		const task = this.activePermissionTaskForSession(sessionId)
		if (!task) {
			throw new Error("Cannot persist a permission rule without an active session task")
		}
		return task
	}

	private permissionRuleToolName(toolCall: acp.ToolCall | acp.ToolCallUpdate): string {
		if (!toolCall.title) {
			throw new Error("Cannot persist a permission rule without a tool title")
		}
		return toolCall.title
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
			const settle = (response: acp.RequestPermissionResponse) => {
				if (this.pendingPermissionResolvers.get(sessionId) === settle) {
					this.pendingPermissionResolvers.delete(sessionId)
				}
				resolve(response)
			}
			this.pendingPermissionResolvers.set(sessionId, settle)
			this.permissionHandler!({ sessionId, toolCall, options: options || [] }, settle)
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
		this.applyStartupProviderInfrastructure()
		const startupOverrides = this.createStartupSessionOverrides()
		const authMethods = this.authentication.listAuthenticationMethods(
			this.isStartupProviderConfigured(startupOverrides),
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
		const activeSessionIdResolver: ActiveAcpSessionIdResolver = () => this.activePromptSessionId
		const hostBridgeClientProvider = new ACPHostBridgeClientProvider(
			connection,
			clientCapabilities,
			activeSessionIdResolver,
			() =>
				this.activePromptSessionId
					? this.sessions.get(this.activePromptSessionId)?.cwd
					: (this.options.cwd ?? process.cwd()),
			connection ? (sessionId, update) => this.persistAndSendSessionUpdate(connection, sessionId, update) : undefined,
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
		const sessionId = crypto.randomUUID()
		const sessionOverrides = this.createStartupSessionOverrides()

		Logger.debug("[DiracAgent] newSession called:", {
			sessionId,
			cwd: params.cwd,
		})

		const worktreeRequest = worktreeProvisioningRequest(params)
		const worktree = worktreeRequest ? await this.provisionSessionWorktree(sessionId, params.cwd, worktreeRequest) : undefined
		const sessionCwd = worktree?.worktreePath ?? params.cwd

		// Create Controller for this session
		const controller = new Controller(this.ctx.extensionContext, {
			workspaceCwd: sessionCwd,
		})

		// Create session record with all resources
		const session: DiracAcpSession = {
			sessionId,
			cwd: sessionCwd,
			mode: sessionOverrides.mode as "act" | "plan",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		}

		const configOptions = await this.sessionConfig.getSessionConfigOptions(session, sessionOverrides)

		this.#sessionControllers.set(session, controller)

		this.sessions.set(sessionId, session)
		this.initializeSessionOverrides(sessionId, sessionOverrides)
		this.persistSessionOverrides(sessionId)

		// Initialize session state
		const sessionState: AcpSessionState = {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		}

		this.sessionStates.set(sessionId, sessionState)

		return {
			sessionId,
			modes: this.sessionConfig.getSessionModeState(session.mode, sessionOverrides),
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
	 * Resolve the stable conversation ID to its latest backing task.
	 * The task is rehydrated lazily on first prompt to align with the ACP flow.
	 */
	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		const sessionId = params.sessionId
		const existingSession = this.sessions.get(sessionId)
		if (existingSession) {
			return this.runSessionRuntimeMutation(sessionId, async () => {
				const configOptions = await this.getNormalizedConfigOptions(existingSession)
				const sessionOverrides = this.acpSessionOverrides.get(sessionId)!
				return {
					modes: this.sessionConfig.getSessionModeState(existingSession.mode, sessionOverrides),
					configOptions,
				}
			})
		}

		Logger.debug("[DiracAgent] loadSession called:", { sessionId })

		const persistedRuntimeConfig = getSessionRuntimeConfig(this.ctx.DATA_DIR, sessionId)
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

		const history = resolveHistorySession(sessionId, persistedRuntimeConfig.taskId ?? getLatestTaskIdForSession(sessionId))
		if (
			!history &&
			getSessionUpdates(sessionId).some(
				(entry) =>
					entry.kind === "session_update" &&
					["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update"].includes(
						entry.update.sessionUpdate,
					),
			)
		) {
			throw new Error(`Persisted conversation history not found for ACP session ${sessionId}`)
		}
		const persistedHistory = history?.historyItem

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
				? getHistoryItemCwd(persistedHistory, params.cwd, this.options.cwd)
				: persistedRuntimeConfig.cwd || params.cwd || this.options.cwd)
		if (!historyCwd) throw new Error(`Working directory not found for ACP session ${sessionId}`)

		const controller = new Controller(this.ctx.extensionContext, {
			workspaceCwd: historyCwd,
		})

		const session: DiracAcpSession = {
			sessionId,
			cwd: historyCwd,
			mode: persistedMode,
			createdAt: persistedRuntimeConfig.createdAt ?? Date.now(),
			lastActivityAt: Date.now(),
			...(persistedHistory
				? {
					isLoadedFromHistory: true,
					loadedTaskId: history!.taskId,
					taskId: history!.taskId,
				}
				: {}),
		}
		const sessionOverrides = copyTaskRuntimeSettings(persistedRuntimeConfig.settings)
		const configOptions = await this.sessionConfig.getSessionConfigOptions(session, sessionOverrides)
		const loadRuntime = StateManager.get().captureEffectiveTaskConfiguration(sessionOverrides)
		validateApiConfiguration(loadRuntime.apiConfiguration as ApiConfiguration, persistedMode)

		if (history) {
			await controller.getTaskWithId(history.taskId)
		}

		this.#sessionControllers.set(session, controller)
		this.sessions.set(sessionId, session)
		this.acpSessionOverrides.set(sessionId, sessionOverrides)
		this.sessionStates.set(sessionId, {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		})
		this.writeSessionRuntimeConfig(session, sessionOverrides)

		return {
			modes: this.sessionConfig.getSessionModeState(session.mode, sessionOverrides),
			configOptions,
		}
	}

	/**
	 * Resume an existing session without replaying historical session updates.
	 *
	 * Unlike `loadSession`, this restores the same persisted task context but leaves
	 * transcript ownership with the reattaching client.
	 */
	async unstable_resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
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

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId)
		if (!session) throw new Error(`Session not found: ${params.sessionId}`)

		Logger.debug("[DiracAgent] setSessionConfigOption called:", {
			sessionId: params.sessionId,
			configId: params.configId,
			value: params.value,
		})

		if (params.configId === "mode") {
			if (typeof params.value !== "string") throw new Error("Mode must be a select value")
			return { configOptions: await this.applySessionMode(params.sessionId, params.value) }
		}

		return this.runSessionRuntimeMutation(params.sessionId, async () => {
			const currentOverrides = this.acpSessionOverrides.get(params.sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${params.sessionId}`)
			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			let configOptions: acp.SessionConfigOption[] | undefined

			switch (params.configId) {
				case "auto_approve":
					if (typeof params.value !== "boolean") throw new Error("Auto-approve must be a boolean value")
					nextOverrides.autoApproveAllToggled = params.value
					break
				case "yolo":
					if (typeof params.value !== "boolean") throw new Error("YOLO must be a boolean value")
					nextOverrides.yoloModeToggled = params.value
					break
				case "provider":
					if (typeof params.value !== "string") throw new Error("Provider must be a select value")
					configOptions = await this.sessionConfig.applyProviderConfigOption(session, params.value, nextOverrides)
					break
				case "model":
					if (typeof params.value !== "string") throw new Error("Model must be a select value")
					configOptions = await this.sessionConfig.applyModelConfigOption(session, params.value, nextOverrides)
					break
				case "reasoning_effort":
					if (typeof params.value !== "string") throw new Error("Reasoning effort must be a select value")
					this.sessionConfig.applyReasoningEffortConfigOption(session, params.value, nextOverrides)
					break
				case "inference_speed":
					if (typeof params.value !== "string") throw new Error("Inference speed must be a select value")
					this.sessionConfig.applyInferenceSpeedConfigOption(session, params.value, nextOverrides)
					break
				case "thinking_budget":
					if (typeof params.value !== "string") throw new Error("Thinking budget must be a select value")
					this.sessionConfig.applyThinkingBudgetConfigOption(session, params.value, nextOverrides)
					break
				default:
					throw new Error(`Unknown session config option: ${params.configId}`)
			}

			configOptions ??= await this.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)
			session.lastActivityAt = Date.now()
			await this.emitSessionUpdate(params.sessionId, { sessionUpdate: "config_option_update", configOptions })
			return { configOptions }
		})
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

		const controller = this.#sessionControllers.get(session)
		if (!controller) {
			throw new Error("Controller not initialized for session. This is a bug in the ACP agent setup.")
		}

		const activeOverrides = await this.runSessionRuntimeMutation(params.sessionId, async () => {
			if (sessionState.status !== AcpSessionStatus.Idle) {
				throw new Error(`Session ${params.sessionId} is busy with another operation`)
			}
			const sessionOverrides = this.acpSessionOverrides.get(params.sessionId)
			if (!sessionOverrides) throw new Error(`Session runtime configuration not found: ${params.sessionId}`)
			const overrides = copyTaskRuntimeSettings(sessionOverrides)
			await this.sessionConfig.assertTaskRuntimeAvailable(session, overrides)
			await this.refreshTaskRuntime(session, overrides)
			this.activePromptOverrides.set(params.sessionId, overrides)
			this.unbindPromptTask(params.sessionId)
			sessionState.status = AcpSessionStatus.Processing
			session.lastActivityAt = Date.now()
			return overrides
		})

		Logger.debug("[DiracAgent] prompt called:", {
			sessionId: params.sessionId,
			promptLength: params.prompt.length,
		})
		const previousPrompt = this.activePrompt
		let releasePrompt!: () => void
		this.activePrompt = new Promise<void>((resolve) => {
			releasePrompt = resolve
		})
		await previousPrompt
		this.activePromptSessionId = params.sessionId

		// A session can be cancelled while queued behind another session's prompt.
		// Do not begin task initialization once it reaches the front of that queue.
		if ((sessionState.status as AcpSessionStatus) === AcpSessionStatus.Cancelled) {
			this.activePromptOverrides.delete(params.sessionId)
			releasePrompt()
			sessionState.status = AcpSessionStatus.Idle
			this.activePromptSessionId = undefined
			return this.bridgeForSession(params.sessionId).promptResponse("cancelled")
		}

		// Clear only this session's delta and tool-call tracking state.
		const bridge = this.bridgeForSession(params.sessionId)
		bridge.clearPromptState()

		// Track cleanup functions for subscriptions
		const cleanupFunctions: (() => void)[] = []

		// Promise that settles when the task completes, is cancelled, needs input,
		// or encounters an internal failure.
		let resolvePrompt: (response: acp.PromptResponse) => void
		let rejectPrompt: (error: Error) => void
		const promptPromise = new Promise<acp.PromptResponse>((resolve, reject) => {
			resolvePrompt = resolve
			rejectPrompt = reject
		})

		// Track if we've already resolved/rejected (object for pass-by-reference)
		const promptResolved = { value: false }

		// Register the resolver so cancel() can resolve the in-flight prompt with
		// `stopReason: "cancelled"`. Cleared in the finally block.
		this.pendingPromptResolvers.set(params.sessionId, {
			resolve: resolvePrompt!,
			resolved: promptResolved,
		})

		let subscribedTask: object | undefined
		const subscribeToCurrentTask = () => {
			const task = controller.task
			if (!task || subscribedTask === task) return
			bridge.subscribeToTaskMessages(
				controller,
				params.sessionId,
				sessionState,
				resolvePrompt!,
				rejectPrompt!,
				promptResolved,
				cleanupFunctions,
				controller.taskRunPromise,
			)
			subscribedTask = task
		}
		const removeTaskReplacementListener = controller.onTaskReplaced(async (taskId) => {
			await bridge.cancelInFlightToolCalls(params.sessionId, sessionState)
			await recordTaskForSession(params.sessionId, taskId)
			session.taskId = taskId
			this.persistSessionOverrides(params.sessionId)
			subscribedTask = undefined
			const replacementTask = controller.task
			if (!replacementTask) return
			await this.bindPromptTask(params.sessionId, replacementTask)
			const replayEndIndex = replacementTask.messageStateHandler.getDiracMessages().length
			subscribeToCurrentTask()
			await bridge.replayTaskMessages(
				controller,
				params.sessionId,
				sessionState,
				resolvePrompt!,
				rejectPrompt!,
				promptResolved,
				0,
				replayEndIndex,
			)
		})
		cleanupFunctions.push(removeTaskReplacementListener)

		try {
			// Extract text content from prompt
			const { textContent, imageContent, fileResources } = parsePromptContent(params.prompt)

			// Command availability may depend on skills and workflows added after the
			// session was created. Republish the complete current set before each turn.
			await this.sendAvailableCommands(params.sessionId, controller)
			await this.setSessionTitleFromFirstExchange(session, textContent)

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
				return {
					...interceptedReviewResponse,
					...bridge.promptResponse(interceptedReviewResponse.stopReason),
				}
			}

			// Determine if this is a new task, continuation, or loaded session resume
			const hasActiveTask = controller.task !== undefined
			const isLoadedSession = session.isLoadedFromHistory === true

			if (session.awaitingCancelledTaskResume && hasActiveTask && controller.task) {
				// cancelTask() reinitializes persisted history and leaves its replacement task
				// waiting in resumeTaskFromHistory(). ACP has no historical resume-card
				// requirement, so wake that flow directly rather than replacing the task.
				Logger.debug("[DiracAgent] Resuming task reinitialized after cancellation:", controller.task.taskId)
				subscribeToCurrentTask()
				await this.bindPromptTask(params.sessionId, controller.task)
				await controller.task.submitCardResponse("", DiracAskResponse.MESSAGE, textContent, imageContent, fileResources)
				session.awaitingCancelledTaskResume = false
			} else if (isLoadedSession) {
				// Reinitialization returns only once the persisted conversation is restored.
				const taskIdToResume = session.loadedTaskId!
				await controller.reinitExistingTaskFromId(
					taskIdToResume,
					this.activePromptInitializationOptions(params.sessionId),
				)
				const task = controller.task!
				subscribeToCurrentTask()
				await this.bindPromptTask(params.sessionId, task)
				await task.submitCardResponse("", DiracAskResponse.MESSAGE, textContent, imageContent, fileResources)
			} else if (hasActiveTask && controller.task) {
				// Continue existing task - respond to pending ask
				Logger.debug("[DiracAgent] Continuing existing task:", controller.task.taskId)

				const waitingCardId = controller.task.taskState.lastWaitingCardId
				const waitingCard = waitingCardId
					? controller.task.messageStateHandler
						.getDiracMessages()
						.find(
							(message) =>
								message.content.type === DiracMessageType.CARD &&
								message.content.card.id === waitingCardId &&
								message.content.card.status === CardStatus.WAITING_FOR_INPUT,
						)
					: undefined

				if (waitingCard) {
					subscribeToCurrentTask()
					await controller.task.submitCardResponse(
						waitingCardId!,
						DiracAskResponse.MESSAGE,
						textContent,
						imageContent,
						fileResources,
					)
				} else {
					// Restoration can clear the live task on failure; retain its ID for the next prompt's retry.
					session.isLoadedFromHistory = true
					session.loadedTaskId = controller.task.taskId
					const task = await controller.prepareTaskForFollowUp(this.activePromptInitializationOptions(params.sessionId))
					subscribeToCurrentTask()
					await this.bindPromptTask(params.sessionId, task)
					await task.submitCardResponse("", DiracAskResponse.MESSAGE, textContent, imageContent, fileResources)
				}
			} else {
				// The ACP session ID is the stable conversation ULID, not the backing task ID.
				Logger.debug("[DiracAgent] Starting new task")
				await controller.initTask(
					textContent,
					imageContent,
					fileResources,
					undefined,
					undefined,
					params.sessionId,
					undefined,
					this.activePromptInitializationOptions(params.sessionId),
				)
				session.taskId = controller.task?.taskId
				this.persistSessionOverrides(params.sessionId)
			}
			session.isLoadedFromHistory = false
			session.loadedTaskId = undefined

			if (controller.task && !subscribedTask) {
				const replayEndIndex = controller.task.messageStateHandler.getDiracMessages().length
				subscribeToCurrentTask()
				await bridge.replayTaskMessages(
					controller,
					params.sessionId,
					sessionState,
					resolvePrompt!,
					rejectPrompt!,
					promptResolved,
					0,
					replayEndIndex,
				)
			}

			// Existing continuations subscribe before waking the task; newly created
			// tasks subscribe and replay the messages emitted during initialization.
			subscribeToCurrentTask()

			// Pins were installed during task construction. This preserves the observer
			// for task implementations that do not consume initialization options.

			// Return the promise that will resolve when task completes
			return await promptPromise
		} catch (error) {
			if (!promptResolved.value) {
				promptResolved.value = true
				const internalError = error instanceof Error ? error : new Error(String(error))
				try {
					await this.emitSessionUpdate(params.sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: `Error: ${internalError.message}`,
						},
					})
				} catch (emitError) {
					Logger.error("[DiracAgent] Failed to emit internal prompt error:", emitError)
				}
				throw internalError
			}
			throw error
		} finally {
			this.activePromptOverrides.delete(params.sessionId)
			releasePrompt()
			this.activePromptSessionId = undefined

			// Clean up subscriptions
			for (const cleanup of cleanupFunctions) {
				try {
					cleanup()
				} catch (error) {
					Logger.debug("[DiracAgent] Error during cleanup:", error)
				}
			}
			this.pendingPromptResolvers.delete(params.sessionId)
			this.unbindPromptTask(params.sessionId)

			// Task-owned steering remains in the transcript. Pre-task guidance remains session-owned until a task binds.
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

			// Abort a permission request that is currently waiting on the client. Its
			// normal response path turns this into a rejected Dirac card response.
			this.pendingPermissionResolvers.get(params.sessionId)?.({
				outcome: { outcome: "cancelled" },
			})

			const bridge = this.bridgeForSession(params.sessionId)
			bridge.invalidatePendingInteractions()
			this.pendingElicitationResolvers.get(params.sessionId)?.({
				action: "cancel",
			})

			try {
				// If we have an active controller task, cancel it before resolving prompt.
				const controller = this.#sessionControllers.get(session)
				if (controller?.task) {
					try {
						await controller.cancelTask()

						// TaskController.cancelTask() recreates persisted tasks and starts their
						// resume flow. Mark that handoff explicitly so the next ACP prompt can
						// submit to it without depending on a historical card.
						if (controller.task) {
							session.taskId = controller.task.taskId
							session.awaitingCancelledTaskResume = true
						}
					} catch (error) {
						Logger.debug("[DiracAgent] Error cancelling task:", error)
					}

					await bridge.waitForMessageWork()
				}

				// ACP clients retain tool calls until a terminal update arrives. Close
				// every outstanding call, including one awaiting permission, before the
				// cancelled prompt response is emitted.
				await bridge.cancelInFlightToolCalls(params.sessionId, sessionState)
			} catch (error) {
				Logger.error("[DiracAgent] Error finalizing ACP cancellation:", error)
			} finally {
				// Cancellation owns this resolver once claimed. Cleanup failures must not
				// strand the original session/prompt request.
				if (cancelClaimed) {
					pending!.resolve(bridge.promptResponse("cancelled"))
				}
			}
		}
	}

	/** Set the mutually exclusive Plan/Act session mode without changing approval qualifiers. */
	async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
		await this.releaseSessionResources(params.sessionId)
		return {}
	}

	async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
		await this.deleteSessionResources(params.sessionId)
		return {}
	}

	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		Logger.debug("[DiracAgent] setSessionMode called:", {
			sessionId: params.sessionId,
			modeId: params.modeId,
		})
		await this.applySessionMode(params.sessionId, params.modeId)
		return {}
	}

	private async applySessionMode(sessionId: string, modeId: string): Promise<acp.SessionConfigOption[]> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Session not found: ${sessionId}`)
		const validModes: AcpModeId[] = ["plan", "act"]
		if (!validModes.includes(modeId as AcpModeId)) {
			throw new Error(`Invalid mode: ${modeId}. Valid modes are: ${validModes.join(", ")}`)
		}

		return this.runSessionRuntimeMutation(sessionId, async () => {
			const currentOverrides = this.acpSessionOverrides.get(sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			nextOverrides.mode = modeId as AcpModeId

			const configOptions = await this.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)
			session.lastActivityAt = Date.now()
			await this.emitCurrentModeUpdate(sessionId)
			await this.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
			return configOptions
		})
	}

	private async switchSessionToActMode(sessionId: string): Promise<boolean> {
		return this.runSessionRuntimeMutation(sessionId, async () => {
			const session = this.sessions.get(sessionId)
			if (!session) throw new Error(`Session not found: ${sessionId}`)
			const currentOverrides = this.acpSessionOverrides.get(sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
			const activeOverrides = this.activePromptOverrides.get(sessionId)
			if ((activeOverrides?.mode ?? session.mode) === "act") {
				return this.#sessionControllers.get(session)?.task !== undefined
			}

			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			nextOverrides.mode = "act"
			const configOptions = await this.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)

			session.lastActivityAt = Date.now()
			await this.emitCurrentModeUpdate(sessionId)
			await this.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
			return this.#sessionControllers.get(session)?.task !== undefined
		})
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
		await Promise.all([...this.sessions.keys()].map((sessionId) => this.emitConfigOptionsUpdate(sessionId, true)))
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

	private async emitCurrentModeUpdate(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}
		const sessionOverrides = this.acpSessionOverrides.get(sessionId)
		if (!sessionOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)

		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "current_mode_update",
			currentModeId: this.sessionConfig.computeCurrentAcpModeId(session.mode, sessionOverrides),
		})
	}

	private async persistAndSendSessionUpdate(
		connection: acp.AgentSideConnection,
		sessionId: string,
		update: acp.SessionUpdate,
	): Promise<void> {
		const persistedUpdate = this.persistSessionUpdate(sessionId, update)
		await connection.sessionUpdate({ sessionId, update: persistedUpdate })
	}

	private async emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void> {
		const emitter = this.emitterForSession(sessionId)
		const persistedUpdate = this.persistSessionUpdate(sessionId, update)

		try {
			emitter.emit(persistedUpdate.sessionUpdate, persistedUpdate)
		} catch (error) {
			Logger.debug("[DiracAgent] Error emitting session update:", error)
			emitter.emit("error", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/**
	 * Persist a session update, falling back to an ephemeral, in-process sequence
	 * when the journal cannot be written. A persistence failure must not take down
	 * the live ACP session, so the caller can still emit the update to the client.
	 *
	 * NOTE: the fallback sequence is a best-effort degradation, not durable
	 * ordering. It is only seeded from a successful write, so when persistence
	 * fails from the very first call (e.g. an already over-cap journal) it starts
	 * at 1 and counts up in memory — colliding with the sequence numbers already
	 * persisted in the journal, and resetting on process restart. Acceptable as an
	 * immediate unblock; Step 2 (append-only journal) removes this entirely.
	 */
	private persistSessionUpdate(sessionId: string, update: acp.SessionUpdate): ReturnType<typeof recordSessionUpdate> {
		try {
			const persisted = recordSessionUpdate(sessionId, update)
			const sequence = persisted._meta?.[SEQUENCE_META_KEY]
			if (typeof sequence === "number") {
				this.lastJournalSequence.set(sessionId, sequence)
			}
			return persisted
		} catch (error) {
			Logger.error("[DiracAgent] ACP journal persistence failed; emitting session update ephemerally:", error)
			const sequence = (this.lastJournalSequence.get(sessionId) ?? 0) + 1
			this.lastJournalSequence.set(sessionId, sequence)
			return {
				...update,
				_meta: {
					...(update as acp.SessionUpdate & { _meta?: Record<string, unknown> })._meta,
					[SEQUENCE_META_KEY]: sequence,
				},
			}
		}
	}

	private async getNormalizedConfigOptions(session: DiracAcpSession): Promise<acp.SessionConfigOption[]> {
		const currentOverrides = this.acpSessionOverrides.get(session.sessionId)
		if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
		const configOptions = await this.sessionConfig.getSessionConfigOptions(session, nextOverrides)
		await this.commitClientSessionRuntime(session, nextOverrides)
		return configOptions
	}

	private async emitConfigOptionsUpdate(sessionId: string, refreshProviderRuntime = false): Promise<void> {
		if (!this.sessionStates.has(sessionId)) return
		await this.runSessionRuntimeMutation(sessionId, async () => {
			const session = this.sessions.get(sessionId)
			if (!session) throw new Error(`Session not found: ${sessionId}`)
			const configOptions = await this.getNormalizedConfigOptions(session)
			if (refreshProviderRuntime) await this.refreshSessionProviderRuntime(session)
			await this.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
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

		const taskId = session.loadedTaskId ?? controller.task?.taskId
		if (!taskId) return
		let uiMessages: DiracMessage[]
		try {
			await controller.getTaskWithId(taskId)
			uiMessages = await getSavedDiracMessages(taskId)
		} catch (error) {
			Logger.debug("[DiracAgent] replayLoadedSessionHistory: could not read ui_messages:", error)
			return
		}

		const bridge = this.bridgeForSession(sessionId)
		const persistedUpdates = getSessionUpdates(sessionId)
		if (persistedUpdates.length > 0) {
			const emitter = this.emitterForSession(sessionId)
			for (const persistedUpdate of persistedUpdates) {
				if (persistedUpdate.kind === "session_update") {
					emitter.emit(persistedUpdate.update.sessionUpdate, persistedUpdate.update)
				} else if (persistedUpdate.kind === "client_annotation") {
					emitter.emit("client_annotation", persistedUpdate.annotation)
				}
			}

			const hasPersistedUsageUpdate = persistedUpdates.some(
				(persistedUpdate) =>
					persistedUpdate.kind === "session_update" && persistedUpdate.update.sessionUpdate === "usage_update",
			)
			await bridge.restoreUsage(sessionId, uiMessages, !hasPersistedUsageUpdate)
			await this.emitPinnedMessagesUpdate(sessionId, "compacted")
			return
		}

		// Use a fresh session state for replay — don't pollute the live session's tool call tracking
		const replayState: AcpSessionState = {
			sessionId,
			status: AcpSessionStatus.Idle,
			pendingToolCalls: new Map(),
		}

		for (const message of uiMessages) {
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

				await this.emitPlanFromMessage(sessionId, message)
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
		await bridge.restoreUsage(sessionId, uiMessages, true)
	}

	private async emitPlanFromMessage(sessionId: string, message: DiracMessage): Promise<void> {
		const plan = this.planFromMessage(message)
		if (!plan) return

		await this.emitSessionUpdate(sessionId, { sessionUpdate: "plan", ...plan })
	}

	private planFromMessage(message: DiracMessage): acp.Plan | undefined {
		if (message.content.type !== DiracMessageType.CARD || !isPlanResponseCard(message.content.card)) {
			return undefined
		}

		const body = message.content.card.body
		if (!body) return undefined

		const planText = this.planTextFromCard(body).trim()
		const numberedItems = planText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[-*]\s+|^\d+[.)]\s+/.test(line))
			.map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim())
			.filter(Boolean)
		const planItems = numberedItems.length > 0 ? numberedItems : planText ? [planText] : []
		const status = this.planStatusFromCard(message.content.card.status)
		const entries: acp.PlanEntry[] = planItems.map((content, index) => ({
			content,
			priority: index === 0 ? "high" : "medium",
			status,
		}))

		return entries.length > 0 ? { entries } : undefined
	}

	private planStatusFromCard(status: CardStatus): acp.PlanEntryStatus {
		if (status === CardStatus.SUCCESS) return "completed"
		if (status === CardStatus.RUNNING || status === CardStatus.BUILDING) return "in_progress"
		return "pending"
	}

	private planTextFromCard(body: string): string {
		try {
			const parsed = JSON.parse(body) as { response?: unknown }
			return typeof parsed.response === "string" ? parsed.response : body
		} catch {
			return body
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

	private async setSessionTitleFromFirstExchange(session: DiracAcpSession, promptText: string): Promise<void> {
		if (session.title || !promptText.trim()) {
			return
		}

		session.title = summarizeSessionTitle(promptText)
		await this.emitSessionInfoUpdate(session)
	}

	private async emitSessionInfoUpdate(session: DiracAcpSession): Promise<void> {
		await this.emitSessionUpdate(session.sessionId, {
			sessionUpdate: "session_info_update",
			title: session.title ?? null,
			updatedAt: new Date(session.lastActivityAt).toISOString(),
		})
	}

	async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		return this.unstable_listSessions_internal(params)
	}

	private async unstable_listSessions_internal(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		const persistedSessions = listLatestConversationHistoryItems(params.cwd, this.options.cwd).map((historyItem) =>
			historyItemToSessionInfo(historyItem, params.cwd, this.options.cwd),
		)
		const persistedSessionIds = new Set(persistedSessions.map((session) => session.sessionId))
		const activeOnlySessions = [...this.sessions.values()]
			.filter((session) => !persistedSessionIds.has(session.sessionId))
			.filter((session) => !params.cwd || session.cwd === params.cwd)
			.map((session) => ({
				sessionId: session.sessionId,
				cwd: session.cwd,
				title: session.title ?? null,
				updatedAt: new Date(session.lastActivityAt).toISOString(),
			}))
			.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))

		return {
			sessions: [...persistedSessions, ...activeOnlySessions].sort((left, right) =>
				(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
			),
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
		const message = controller.task?.messageStateHandler.getMessageById(checkpointId)

		if (message && controller.task?.checkpointManager) {
			await controller.task.checkpointManager.restoreCheckpoint(message.id, restoreType as any, offset)
		} else {
			throw new Error(`Checkpoint not found for id: ${checkpointId}`)
		}
	}
}
