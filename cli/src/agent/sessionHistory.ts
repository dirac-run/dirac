import type * as acp from "@agentclientprotocol/sdk"
import type { HistoryItem } from "@shared/HistoryItem"
import { StateManager } from "@/core/storage/StateManager"
import { arePathsEqual } from "@/utils/path"

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
