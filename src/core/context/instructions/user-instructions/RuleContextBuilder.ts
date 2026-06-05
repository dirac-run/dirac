import { HostProvider } from "@/hosts/host-provider"
import { DiracMessage } from "@shared/ExtensionMessage"
import { extractPathLikeStrings, RuleEvaluationContext, toWorkspaceRelativePosixPath } from "./rule-conditionals"

type WorkspaceRoot = { path: string }
type WorkspaceManagerLike = { getRoots(): WorkspaceRoot[] }

type DiracMessageLike = DiracMessage

type MessageStateHandlerLike = {
	getDiracMessages(): DiracMessageLike[]
	addToDiracMessages(message: DiracMessage): Promise<void>
	updateDiracMessage(index: number, updates: Partial<DiracMessage>): Promise<void>
	findMessageIndexById(id: string): number
	saveDiracMessagesAndUpdateHistory(): Promise<void>
	overwriteApiConversationHistory(history: any[]): Promise<void>
	getApiConversationHistory(): any[]
}

export type RuleContextBuilderDeps = {
	cwd: string
	messageStateHandler: MessageStateHandlerLike
	workspaceManager?: WorkspaceManagerLike
}

/**
 * Builds the evaluation context used for conditional Dirac Rules (e.g. YAML frontmatter `paths:`).
 *
 * Kept in the user-instructions domain so Task remains orchestration-focused.
 *
 * Path context is gathered from multiple sources in diracMessages:
 * - User messages (task, user_feedback)
 * - Visible/open tabs
 * - Tool results (say="tool") - completed operations
 * - Tool requests (ask="tool") - pending operations (captures intent before execution)
 */
export class RuleContextBuilder {
	/**
	 * Maximum number of path candidates to consider for rule activation.
	 * This cap prevents performance degradation in long-running tasks with many file operations.
	 */
	static readonly MAX_RULE_PATH_CANDIDATES = 100

	static async buildEvaluationContext(deps: RuleContextBuilderDeps): Promise<RuleEvaluationContext> {
		return {
			paths: await RuleContextBuilder.getRulePathContext(deps),
		}
	}

	private static async getRulePathContext(deps: RuleContextBuilderDeps): Promise<string[]> {
		const candidates: string[] = []
		const diracMessages = deps.messageStateHandler.getDiracMessages()

		// (1) Current-turn user message evidence:
		// Use the most recent user-authored text (initial task or subsequent feedback).
		// NOTE: We intentionally prefer the latest user_feedback over the original task to
		// support first-turn activation on later turns.
		const lastUserMsg = [...diracMessages]
			.reverse()
			.find((m) => m.content.type === "markdown" && typeof m.content.content === "string")
		if (lastUserMsg && lastUserMsg.content.type === "markdown") {
			candidates.push(...extractPathLikeStrings(lastUserMsg.content.content))
		}

		// (2) Visible + open tabs
		const roots = deps.workspaceManager?.getRoots().map((r) => r.path) ?? [deps.cwd]
		const rawVisiblePaths = (await HostProvider.window.getVisibleTabs({}))?.paths ?? []
		const rawOpenTabPaths = (await HostProvider.window.getOpenTabs({}))?.paths ?? []
		for (const abs of [...rawVisiblePaths, ...rawOpenTabPaths]) {
			for (const root of roots) {
				const rel = toWorkspaceRelativePosixPath(abs, root)
				if (rel) {
					candidates.push(rel)
					break
				}
			}
		}

		// (3) Files edited by Dirac during this task (completed operations):
		// Parse say="tool" messages for tool results indicating file operations.
		for (const msg of diracMessages) {
			if (msg.content.type !== "card" || !msg.content.card.body) continue
			try {
				const tool = JSON.parse(msg.content.card.body) as { tool?: string; path?: string }
				if (
					(tool.tool === "editedExistingFile" || tool.tool === "newFileCreated" || tool.tool === "fileDeleted") &&
					tool.path
				) {
					candidates.push(tool.path)
				}
			} catch {
				// ignore parse errors
			}
		}

		// (4) Tool requests (pending operations):
		// Parse ask="tool" messages to capture the assistant's intent BEFORE tool execution.
		// This enables rule activation even when:
		// - The tool hasn't completed yet
		// - The tool fails (intent was still expressed)
		// - Files don't exist yet (new file creation)
		for (const msg of diracMessages) {
			if (msg.content.type !== "card" || !msg.content.card.body) continue
			try {
				const tool = JSON.parse(msg.content.card.body) as {
					tool?: string
					path?: string
				}

				// Extract path from standard file tools
				if (tool.path) {
					candidates.push(tool.path)
				}
			} catch {
				// ignore parse errors
			}
		}

		// Normalize/dedupe/cap
		const seen = new Set<string>()
		const normalized: string[] = []
		for (const c of candidates) {
			const posix = c.replace(/\\/g, "/").replace(/^\//, "")
			if (!posix || posix === "/") continue
			if (seen.has(posix)) continue
			seen.add(posix)
			normalized.push(posix)
			if (normalized.length >= RuleContextBuilder.MAX_RULE_PATH_CANDIDATES) break
		}
		return normalized.sort()
	}
}
