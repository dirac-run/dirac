import * as fs from "node:fs/promises"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { withTaskHistoryInventoryLock } from "@/core/storage/taskHistory"
import type { HistoryItem, TaskHistoryItem } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"
import { StateManager } from "@/core/storage/StateManager"
import { arePathsEqual } from "@/utils/path"
import { copyTaskRuntimeSettings, getSessionRuntimeConfig } from "../acp/acp-session-runtime-config.js"
import { getLatestTaskIdForSession } from "../acp/acp-session-tasks.js"
import { copySessionUpdates } from "../acp/acp-session-updates.js"
import type { DiracAcpSession } from "./public-types.js"

export type HistorySessionResolution = {
	sessionId: string
	taskId: string
	historyItem: HistoryItem
}

export function getHistoryItemSessionId(historyItem: HistoryItem): string {
	return historyItem.ulid || historyItem.id
}

export function getHistoryItemCwd(historyItem: HistoryItem, fallbackCwd?: string | null, defaultCwd?: string): string {
	return (
		historyItem.cwdOnTaskInitialization ||
		historyItem.workspaceRootPath ||
		historyItem.shadowGitConfigWorkTree ||
		fallbackCwd ||
		defaultCwd ||
		process.cwd()
	)
}

export function historyItemToSessionInfo(
	historyItem: HistoryItem,
	fallbackCwd?: string | null,
	defaultCwd?: string,
): acp.SessionInfo {
	return {
		sessionId: getHistoryItemSessionId(historyItem),
		cwd: getHistoryItemCwd(historyItem, fallbackCwd, defaultCwd),
		title: historyItem.task || null,
		updatedAt: historyItem.ts ? new Date(historyItem.ts).toISOString() : null,
	}
}

function getTaskHistory(): HistoryItem[] {
	return (StateManager.get().getGlobalStateKey("taskHistory") || []) as HistoryItem[]
}

export function resolveHistorySession(sessionId: string, taskId?: string): HistorySessionResolution | undefined {
	const taskHistory = getTaskHistory()
	const historyItem = taskId
		? taskHistory.find((item) => item.id === taskId)
		: taskHistory.filter((item) => item.ulid === sessionId).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] ||
			taskHistory.find((item) => item.id === sessionId)

	if (!historyItem) {
		if (taskId) throw new Error(`Task ${taskId} not found for ACP session ${sessionId}`)
		return undefined
	}

	return {
		sessionId,
		taskId: historyItem.id,
		historyItem,
	}
}

export function listLatestConversationHistoryItems(cwd?: string | null, defaultCwd?: string): HistoryItem[] {
	const latestByConversationId = new Map<string, HistoryItem>()
	for (const item of getTaskHistory()) {
		if (!item.id || !item.task || !item.ts) {
			continue
		}
		if (cwd && !arePathsEqual(getHistoryItemCwd(item, cwd, defaultCwd), cwd)) {
			continue
		}

		const conversationId = getHistoryItemSessionId(item)
		const existingItem = latestByConversationId.get(conversationId)
		if (!existingItem || (item.ts || 0) > (existingItem.ts || 0)) {
			latestByConversationId.set(conversationId, item)
		}
	}

	return Array.from(latestByConversationId.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0))
}


/** Return every persisted task ID belonging to an ACP session. */
export function getTaskIdsForSession(sessionId: string): string[] {
	return getTaskHistory()
		.filter((item) => getHistoryItemSessionId(item) === sessionId)
		.map((item) => item.id)
}

export interface ForkSourceState {
	sourceOverrides: Partial<Settings>
	sourceMode: "act" | "plan"
	sourceTaskId?: string
	sourceTitle?: string
	sourceCwd: string
	sourceHistoryItem?: HistoryItem
}

/** Resolve the working directory for a forked session using explicit request, active session, or persisted history fallbacks. */
export function resolveForkSourceCwd(options: {
	requestedCwd?: string
	activeSessionCwd?: string
	resolvedHistory?: HistorySessionResolution
	persistedConfigCwd?: string
	defaultCwd?: string
}): string {
	return (
		options.requestedCwd ||
		options.activeSessionCwd ||
		(options.resolvedHistory
			? getHistoryItemCwd(options.resolvedHistory.historyItem, options.requestedCwd, options.defaultCwd)
			: undefined) ||
		options.persistedConfigCwd ||
		options.defaultCwd ||
		process.cwd()
	)
}

/** Extract the source session's runtime overrides, mode, backing task ID, and working directory for forking. */
export function resolveForkSourceState(options: {
	dataDir: string
	sourceSessionId: string
	requestedCwd?: string
	defaultCwd?: string
	activeSource?: DiracAcpSession
	activeOverrides?: Partial<Settings>
}): ForkSourceState {
	const { dataDir, sourceSessionId, requestedCwd, defaultCwd, activeSource, activeOverrides } = options
	const persistedConfig = activeSource ? undefined : getSessionRuntimeConfig(dataDir, sourceSessionId)
	if (!activeSource && !persistedConfig) {
		throw new Error(`Source session ${sourceSessionId} not found`)
	}

	const rawOverrides = activeSource ? activeOverrides : persistedConfig?.settings
	if (!rawOverrides) {
		throw new Error(`Source session ${sourceSessionId} has no runtime overrides`)
	}

	const sourceMode: "act" | "plan" = activeSource?.mode ?? (rawOverrides.mode === "plan" ? "plan" : "act")
	const resolvedHistory = activeSource
		? resolveHistorySession(sourceSessionId)
		: resolveHistorySession(sourceSessionId, persistedConfig?.taskId ?? getLatestTaskIdForSession(sourceSessionId))
	const sourceTaskId =
		activeSource?.taskId ?? activeSource?.loadedTaskId ?? resolvedHistory?.taskId ?? persistedConfig?.taskId
	const sourceTitle = activeSource?.title ?? resolvedHistory?.historyItem.task
	const sourceCwd = resolveForkSourceCwd({
		requestedCwd,
		activeSessionCwd: activeSource?.cwd,
		resolvedHistory,
		persistedConfigCwd: persistedConfig?.cwd,
		defaultCwd,
	})

	return {
		sourceOverrides: copyTaskRuntimeSettings(rawOverrides),
		sourceMode,
		sourceTaskId,
		sourceTitle,
		sourceCwd,
		sourceHistoryItem: resolvedHistory?.historyItem,
	}
}

/** Clone a source session's backing task directory, taskHistory entry, and ACP update journal onto a new session ID. */
export async function cloneForkedSessionArtifacts(options: {
	dataDir: string
	sourceSessionId: string
	newSessionId: string
	sourceState: ForkSourceState
	forkTitle: string
}): Promise<string | undefined> {
	const { dataDir, sourceSessionId, newSessionId, sourceState, forkTitle } = options
	const { sourceTaskId } = sourceState
	if (!sourceTaskId) return undefined

	// Hold the task-history inventory lock across filesystem copy, history upsert, and journal copy to prevent concurrent deletion.
	return await withTaskHistoryInventoryLock(async () => {
		const newTaskId = crypto.randomUUID()
		const sourceTaskDir = path.join(dataDir, "tasks", sourceTaskId)
		const newTaskDir = path.join(dataDir, "tasks", newTaskId)
		await fs.mkdir(path.dirname(newTaskDir), { recursive: true })
		await fs.cp(sourceTaskDir, newTaskDir, { recursive: true })

		const sourceTaskHistory = sourceState.sourceHistoryItem as TaskHistoryItem | undefined
		const historyItem: TaskHistoryItem = {
			id: newTaskId,
			ulid: newSessionId,
			ts: Date.now(),
			task: forkTitle,
			tokensIn: sourceTaskHistory?.tokensIn ?? 0,
			tokensOut: sourceTaskHistory?.tokensOut ?? 0,
			totalCost: sourceTaskHistory?.totalCost ?? 0,
			cwdOnTaskInitialization: sourceState.sourceCwd,
			workspaceRootPath: sourceState.sourceCwd,
			runKind: "task",
		}
		const stateManager = StateManager.get()
		stateManager.upsertTaskHistoryItem(historyItem)
		await stateManager.flushPendingState()
		copySessionUpdates(sourceSessionId, newSessionId)
		return newTaskId
	})
}
