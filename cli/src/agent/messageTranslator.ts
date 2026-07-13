/**
 * Message translator for converting Dirac messages to ACP session updates.
 *
 * This module handles the translation between Dirac's internal message format
 * (DiracMessage) and the ACP protocol's session update format. A single Dirac
 * message may produce multiple ACP updates.
 *
 * @module acp/messageTranslator
 */

import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { CardStatus, DiracMessageType, isFinalStatus } from "@shared/ExtensionMessage"
import { getBrowserActionKind } from "./browserActionTranslator.js"
import type { AcpSessionState, TranslatedMessage } from "./types.js"
import { AcpSessionStatus } from "./types.js"

/**
 * Maps Dirac tool types to ACP ToolKind values.
 */
const TOOL_KIND_MAP: Record<string, acp.ToolKind> = {
	// File operations
	edit_file: "edit",
	editFile: "edit",
	replace_symbol: "edit",
	replaceSymbol: "edit",
	rename_symbol: "edit",
	write_to_file: "edit",
	new_rule: "edit",
	newFileCreated: "edit",
	editedExistingFile: "edit",
	fileDeleted: "delete",
	read_file: "read",
	readFile: "read",
	read_line_range: "read",
	readLineRange: "read",
	list_files: "read",
	listFilesTopLevel: "read",
	listFilesRecursive: "read",
	list_skills: "read",
	listSkills: "read",
	list_code_definition_names: "read",
	listCodeDefinitionNames: "read",
	get_function: "read",
	getFunction: "read",
	get_file_skeleton: "read",
	getFileSkeleton: "read",
	search_files: "search",
	searchFiles: "search",
	find_symbol_references: "search",
	findSymbolReferences: "search",
	// Other
	summarize_task: "think",
	summarizeTask: "think",
	use_skill: "other",
	useSkill: "other",
	use_subagents: "other",
	useSubagents: "other",
	execute_command: "execute",
}

/**
 * Generate a unique tool call ID.
 */
function generateToolCallId(): string {
	return crypto.randomUUID()
}

const WEB_SEARCH_MARKER_PATTERN = /^\s*\[Web Search:\s*([\s\S]*?)\]\s*$/
const WEB_SEARCH_FALLBACK_QUERY = "Searching..."

/**
 * Parse Codex's text-only web-search marker.
 *
 * The marker is emitted by the Responses provider as assistant text. ACP has a
 * native search tool-call surface, so the ACP adapter converts exact marker
 * chunks while leaving ordinary prose untouched.
 */
export function parseWebSearchMarkerText(text: string | undefined): string | undefined {
	const match = text?.match(WEB_SEARCH_MARKER_PATTERN)
	if (!match) return undefined

	const query = match[1]?.trim()
	return query || WEB_SEARCH_FALLBACK_QUERY
}

function toolKindForCard(header: string): acp.ToolKind {
	return TOOL_KIND_MAP[header] ?? getBrowserActionKind(header) ?? "other"
}


/**
 * Options for translating a message.
 */
export interface TranslateMessageOptions {
	/**
	 * An existing toolCallId to use for tool messages.
	 * If provided, updates will be sent as tool_call_update instead of new tool_call.
	 * This is used when updating a streaming tool call that was already created.
	 */
	existingToolCallId?: string
	/**
	 * Capabilities advertised by the ACP client during initialize.
	 */
	clientCapabilities?: acp.ClientCapabilities
}

/**
 * Translate a single Dirac message to ACP session updates.
 *
 * @param message - The Dirac message to translate
 * @param sessionState - The current session state for tracking tool calls
 * @param options - Optional translation options (e.g., existing toolCallId for updates)
 * @returns The translated message with ACP updates and permission requirements
 */
export function translateMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	let requiresPermission = false
	let permissionRequest: TranslatedMessage["permissionRequest"]
	let toolCallId: string | undefined

	if (message.content.type === DiracMessageType.MARKDOWN) {
		const sayResult = translateMarkdownMessage(message, sessionState, options)
		updates.push(...sayResult.updates)
		toolCallId = sayResult.toolCallId
	} else if (message.content.type === DiracMessageType.CARD) {
		const cardResult = translateCardMessage(message, sessionState, options)
		updates.push(...cardResult.updates)
		requiresPermission = cardResult.requiresPermission ?? false
		permissionRequest = cardResult.permissionRequest
		toolCallId = cardResult.toolCallId
	} else if (message.content.type === DiracMessageType.API_STATUS || message.content.type === DiracMessageType.CHECKPOINT) {
		// API status and checkpoint messages produce no ACP updates
	}

	return {
		updates,
		requiresPermission,
		permissionRequest,
		toolCallId,
	}
}

/**
 * Translate a MARKDOWN type Dirac message to ACP updates.
 */
function translateMarkdownMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	let toolCallId: string | undefined
	if (message.content.type !== DiracMessageType.MARKDOWN) {
		return { updates: [] }
	}
	const content = message.content
	const text = content.content
	const isReasoning = content.isReasoning
	const isCompletion = content.isCompletion
	const role = content.role

	// Route by content properties
	if (role === "user") {
		// User messages — already visible to user, don't echo
		return { updates: [] }
	}

	if (isReasoning) {
		// Reasoning → agent_thought_chunk
		if (text) {
			updates.push({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text },
			})
		}
		return { updates }
	}

	if (isCompletion) {
		// Completion result → agent_message_chunk with leading newline
		if (text) {
			updates.push({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "\n" + text },
			})
		}
		return { updates }
	}

	// Regular text → check for web search marker, then agent_message_chunk
	if (text) {
		const webSearchQuery = parseWebSearchMarkerText(text)
		if (webSearchQuery) {
			toolCallId = translateWebSearchMarkerMessage(webSearchQuery, sessionState, updates)
			return { updates, toolCallId }
		}

		// Clear retry tool call when streaming begins
		if (sessionState.retryToolCallId) {
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId: sessionState.retryToolCallId,
				status: "completed",
			})
			sessionState.retryToolCallId = undefined
		}

		updates.push({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
		})
	}

	return { updates, toolCallId }
}

/**
 * Translate a web search marker to ACP tool_call lifecycle.
 *
 * Web search markers are complete text chunks (the regex requires a closing `]`),
 * so they are always emitted with a terminal "completed" status.
 */
function translateWebSearchMarkerMessage(query: string, sessionState: AcpSessionState, updates: acp.SessionUpdate[]): string {
	const toolCallId = sessionState.currentToolCallId || generateToolCallId()

	const isExistingToolCall = !!sessionState.currentToolCallId

	if (!isExistingToolCall) {
		sessionState.currentToolCallId = toolCallId
		updates.push({
			sessionUpdate: "tool_call",
			toolCallId,
			title: `Web Search: ${query}`,
			kind: "search",
			status: "pending",
			rawInput: { query },
		})
	}

	if (!isExistingToolCall) {
		updates.push({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" })
	}

	updates.push({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "completed",
		rawInput: { query },
		rawOutput: { query },
	})
	sessionState.currentToolCallId = undefined

	return toolCallId
}

const DiracAskResponse_MESSAGE = "messageResponse"

/**
 * Translate a CARD type Dirac message to ACP updates.
 */
function translateCardMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	if (message.content.type !== DiracMessageType.CARD) {
		return { updates: [], requiresPermission: false }
	}
	const card = message.content.card
	const toolCallId = card.id
	const updates: acp.SessionUpdate[] = []
	let requiresPermission = false
	let permissionRequest: TranslatedMessage["permissionRequest"]

	// Map CardStatus to ACP ToolCallStatus
	const mapStatus = (s: CardStatus): acp.ToolCallStatus => {
		switch (s) {
			case CardStatus.RUNNING:
			case CardStatus.BUILDING:
			case CardStatus.PENDING:
				return "in_progress"
			case CardStatus.SUCCESS:
				return "completed"
			case CardStatus.ERROR:
			case CardStatus.CANCELLED:
			case CardStatus.ABANDONED:
			case CardStatus.SKIPPED:
				return "failed"
			case CardStatus.WAITING_FOR_INPUT:
				return "pending"
			default:
				return "in_progress"
		}
	}

	const actualStatus = mapStatus(card.status)
	const status = actualStatus === "in_progress" ? "pending" : actualStatus
	const locations = card.locations?.map((location) => ({
		path: location.path,
		...(location.line === undefined ? {} : { line: location.line }),
	}))
	const isExisting = sessionState.pendingToolCalls.has(toolCallId)
	const kind = toolKindForCard(card.header)
	const content = card.diffs?.map((diff) => ({ type: "diff" as const, ...diff }))
	const rawInput = card.rawInput ?? (card.body ? { body: card.body } : undefined)
	const rawOutput = card.rawOutput ?? (card.body ? { body: card.body } : undefined)
	if (isExisting) {
		const existing = sessionState.pendingToolCalls.get(toolCallId)!
		existing.status = actualStatus
		existing.title = card.header
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			title: card.header,
			status: actualStatus,
			locations,
			content,
			rawInput,
			rawOutput,
		})
		if (isFinalStatus(card.status)) {
			sessionState.pendingToolCalls.delete(toolCallId)
		}
	} else {
		const toolCall: acp.ToolCall = {
			toolCallId,
			title: card.header,
			kind,
			status,
			locations,
			content,
			rawInput,
			rawOutput,
		}
		updates.push({ sessionUpdate: "tool_call", ...toolCall })
		if (actualStatus === "in_progress") {
			updates.push({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", locations })
		}
		if (!isFinalStatus(card.status)) {
			sessionState.pendingToolCalls.set(toolCallId, toolCall)
		}
	}

	// Handle interaction requests (approval / feedback)
	if (card.status === CardStatus.WAITING_FOR_INPUT && (card.requireApproval || card.requireFeedback)) {
		const existingToolCall = sessionState.pendingToolCalls.get(toolCallId) || {
			toolCallId,
			title: card.header,
			kind,
			status: "pending" as acp.ToolCallStatus,
			locations,
		}
		requiresPermission = true
		if (card.requireApproval) {
			permissionRequest = {
				toolCall: existingToolCall as acp.ToolCall,
				options: [
					{ kind: "allow_once", optionId: "allow_once", name: "Approve once" },
					{ kind: "allow_always", optionId: "allow_always", name: "Always approve" },
					{ kind: "reject_once", optionId: "reject_once", name: "Reject once" },
					{ kind: "reject_always", optionId: "reject_always", name: "Always reject" },
				],
			}
		} else {
			// requireFeedback
			permissionRequest = {
				toolCall: existingToolCall as acp.ToolCall,
				options: [{ kind: "allow_once", optionId: DiracAskResponse_MESSAGE, name: "Submit" }],
			}
		}
	}

	return { updates, requiresPermission, permissionRequest, toolCallId }
}

/**
 * Translate multiple Dirac messages to ACP session updates.
 *
 * @param messages - Array of Dirac messages to translate
 * @param sessionState - The current session state
 * @returns Combined array of ACP session updates
 */
export function translateMessages(
	messages: DiracMessage[],
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): acp.SessionUpdate[] {
	const allUpdates: acp.SessionUpdate[] = []

	for (const message of messages) {
		const result = translateMessage(message, sessionState, options)
		allUpdates.push(...result.updates)
	}

	return allUpdates
}

/**
 * Create an initial session state for tracking tool calls.
 */
export function createSessionState(sessionId: string): AcpSessionState {
	return {
		sessionId,
		status: AcpSessionStatus.Idle,
		pendingToolCalls: new Map(),
	}
}
