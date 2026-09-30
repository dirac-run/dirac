import type * as acp from "@agentclientprotocol/sdk"
import { CLI_ONLY_COMMANDS, VSCODE_ONLY_COMMANDS } from "@shared/slashCommands"
import type { Controller } from "@/core/controller"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { Logger } from "@/shared/services/Logger.js"
import type { DiracAcpSession, DiracAgentOptions } from "./public-types.js"
import { ACP_REVIEW_COMMANDS } from "./review.js"
import { historyItemToSessionInfo, listLatestConversationHistoryItems } from "./sessionHistory.js"

const SESSION_TITLE_MAX_LENGTH = 80

function summarizeSessionTitle(promptText: string): string {
	const firstLine = promptText.trim().split("\n")[0].replace(/\s+/g, " ")
	return firstLine.length <= SESSION_TITLE_MAX_LENGTH
		? firstLine
		: `${firstLine.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
}

interface SessionCatalogDeps {
	options: DiracAgentOptions
	sessions: Map<string, DiracAcpSession>
	emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void>
	emitSessionInfoUpdate(session: DiracAcpSession): Promise<void>
}

/**
 * Publishes session metadata to ACP clients: the available-commands list sent
 * before each turn, the first-exchange title, and the merged persisted/active
 * session listing.
 */
export class SessionCatalog {
	constructor(private readonly deps: SessionCatalogDeps) {}

	async sendAvailableCommands(sessionId: string, controller: Controller): Promise<void> {
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
			await this.deps.emitSessionUpdate(sessionId, {
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

	async setSessionTitleFromFirstExchange(session: DiracAcpSession, promptText: string): Promise<void> {
		if (session.title || !promptText.trim()) {
			return
		}

		session.title = summarizeSessionTitle(promptText)
		await this.deps.emitSessionInfoUpdate(session)
	}

	async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		const persistedSessions = listLatestConversationHistoryItems(params.cwd, this.deps.options.cwd).map((historyItem) =>
			historyItemToSessionInfo(historyItem, params.cwd, this.deps.options.cwd),
		)
		const persistedSessionIds = new Set(persistedSessions.map((session) => session.sessionId))
		const activeOnlySessions = [...this.deps.sessions.values()]
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
}
