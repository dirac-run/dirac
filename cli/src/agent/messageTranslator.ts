/**
 * Message translator for converting Dirac messages to ACP session updates.
 *
 * This module handles the translation between Dirac's internal message format
 * (DiracMessage) and the ACP protocol's session update format.
 *
 * @module acp/messageTranslator
 */

import type * as acp from "@agentclientprotocol/sdk"
import { DiracMessageType, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { AcpSessionState, TranslatedMessage } from "./types.js"

/**
 * Maps Dirac tool types to ACP ToolKind values.
 * Note: In the new architecture, tools are identified by their header/icon,
 * but we still map common tool names for ACP compatibility.
 */
const TOOL_KIND_MAP: Record<string, acp.ToolKind> = {
	read_file: "read",
	edit_file: "edit",
	execute_command: "execute",
	search_files: "search",
	summarize_task: "think",
	use_skill: "other",
	list_skills: "read",
	use_subagents: "other",
	get_function: "read",
	get_file_skeleton: "read",
	find_symbol_references: "search",
	ask_followup_question: "other",
	attempt_completion: "other",
	browser_action: "execute",
	plan_mode_respond: "other",
	diagnostics_scan: "read",
	replace_symbol: "edit",
	rename_symbol: "edit",
	write_to_file: "edit",
}

/**
 * Generate a unique tool call ID.
 */
function generateToolCallId(): string {
	return crypto.randomUUID()
}


/**

/**
 * Translate a single Dirac message to ACP session updates.
 *
 * @param message - The Dirac message to translate
 * @param sessionState - The current session state for tracking tool calls
 * @returns The translated message with ACP updates and interaction requirements
 */
export function translateMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	let requiresPermission = false
	let permissionRequest: TranslatedMessage["permissionRequest"]
	let toolCallId: string | undefined

	const { content } = message

	switch (content.type) {
		case DiracMessageType.MARKDOWN: {
			const sessionUpdate = content.isReasoning ? "agent_thought_chunk" : "agent_message_chunk"
			if (content.content) {
				updates.push({
					sessionUpdate,
					content: { type: "text", text: content.content },
				})
			}
			break
		}

		case DiracMessageType.CARD: {
			const { card } = content
			toolCallId = card.id
			const status = mapCardStatusToAcp(card.status)

			// If it's a new card we haven't seen, send tool_call
			// Otherwise send tool_call_update
			const isNew = !sessionState.pendingToolCalls.has(toolCallId)

			const toolCall: acp.ToolCall = {
				toolCallId,
				title: card.header,
				kind: "other", // Default to other, could be refined by icon mapping
				status,
				rawInput: { header: card.header },
				content: card.body ? [{ type: "content", content: { type: "text", text: card.body } }] : undefined,
			}

			if (isNew) {
				updates.push({
					sessionUpdate: "tool_call",
					...toolCall,
				})
				sessionState.pendingToolCalls.set(toolCallId, toolCall)
			} else {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status,
					content: toolCall.content,
				})
			}

			// Handle interaction requests (approvals or feedback)
			if (card.status === CardStatus.WAITING_FOR_INPUT) {
				requiresPermission = true
				permissionRequest = {
					toolCall,
					options: card.requireApproval
						? [
								{ kind: "allow_once", optionId: DiracAskResponse.APPROVE, name: "Approve" },
								{ kind: "reject_once", optionId: DiracAskResponse.REJECT, name: "Reject" },
						  ]
						: [
								{ kind: "allow_once", optionId: "message", name: "Submit" },
						  ],
				}
			}

			if (isFinalStatus(card.status)) {
				sessionState.pendingToolCalls.delete(toolCallId)
			}
			break
		}

		case DiracMessageType.API_STATUS: {
			// API status can be shown as a thought chunk or ignored in ACP
			// For now, we'll skip it to avoid cluttering the ACP stream
			break
		}
	}

	return {
		updates,
		requiresPermission,
		permissionRequest,
		toolCallId,
	}
}

function mapCardStatusToAcp(status: CardStatus): acp.ToolCallStatus {
	switch (status) {
		case CardStatus.BUILDING:
		case CardStatus.PENDING:
			return "pending"
		case CardStatus.RUNNING:
			return "in_progress"
		case CardStatus.SUCCESS:
			return "completed"
		case CardStatus.ERROR:
			return "failed"
		case CardStatus.SKIPPED:
		case CardStatus.CANCELLED:
		case CardStatus.ABANDONED:
			return "failed"
		case CardStatus.WAITING_FOR_INPUT:
			return "pending"
		default:
			return "failed"
	}
}

/**
 * Translate multiple Dirac messages to ACP session updates.
 */
export function translateMessages(
	messages: DiracMessage[],
	sessionState: AcpSessionState,
): acp.SessionUpdate[] {
	const allUpdates: acp.SessionUpdate[] = []
	for (const message of messages) {
		const result = translateMessage(message, sessionState)
		allUpdates.push(...result.updates)
	}
	return allUpdates
}
