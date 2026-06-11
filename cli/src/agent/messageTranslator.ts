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
import { DiracMessageType, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import type { DiracSayBrowserAction, DiracSayTool, MultiCommandState } from "@shared/proto/dirac/ui.js"
import type { AcpSessionState, TranslatedMessage } from "./types.js"
import { AcpSessionStatus } from "./types.js"

/**
 * Maps Dirac tool types to ACP ToolKind values.
 */
const TOOL_KIND_MAP: Record<string, acp.ToolKind> = {
	// File operations
	editFile: "edit",
	replaceSymbol: "edit",
	write_to_file: "edit", // Keep for backward compatibility if needed, but DiracSayTool uses camelCase
	newFileCreated: "edit",
	editedExistingFile: "edit",
	fileDeleted: "delete",
	readFile: "read",
	readLineRange: "read",
	listFilesTopLevel: "read",
	listFilesRecursive: "read",
	listCodeDefinitionNames: "read",
	searchFiles: "search",
	// Other
	summarizeTask: "think",
	useSkill: "other",
	listSkills: "read",
	useSubagents: "other",
	getFunction: "read",
	getFileSkeleton: "read",
	findSymbolReferences: "search",
	execute_command: "execute",
}

/**
 * Maps browser actions to ACP ToolKind values.
 */
const BROWSER_ACTION_KIND_MAP: Record<string, acp.ToolKind> = {
	launch: "execute",
	click: "execute",
	type: "execute",
	scroll_down: "execute",
	scroll_up: "execute",
	close: "execute",
}

/**
 * Generate a unique tool call ID.
 */
function generateToolCallId(): string {
	return crypto.randomUUID()
}

/**
 * Render a terminal error as a failed tool_call lifecycle so clients show
 * error styling instead of treating the message as normal model output.
 *
 * If a tool call is already in flight, the existing one is failed (preserving
 * the natural attribution). Otherwise a synthetic tool_call is emitted just to
 * carry the failure update.
 */
function pushFailureToolCall(
	updates: acp.SessionUpdate[],
	sessionState: AcpSessionState,
	title: string,
	displayText: string,
	rawOutput: Record<string, unknown>,
): void {
	if (sessionState.currentToolCallId) {
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId: sessionState.currentToolCallId,
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: displayText } }],
			rawOutput,
		})
		sessionState.currentToolCallId = undefined
		return
	}
	const toolCallId = generateToolCallId()
	updates.push({
		sessionUpdate: "tool_call",
		toolCallId,
		title,
		kind: "other",
		status: "in_progress",
	})
	updates.push({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "failed",
		content: [{ type: "content", content: { type: "text", text: displayText } }],
		rawOutput,
	})
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

/**
 * Result of parsing a unified diff.
 */
interface ParsedDiff {
	oldText: string
	newText: string
}

/**
 * Parse a unified diff format to extract old and new text.
 *
 * Unified diff format:
 * --- a/file.txt
 * +++ b/file.txt
 * @@ -1,3 +1,4 @@
 *  unchanged line
 * -removed line
 * +added line
 *  another unchanged line
 *
 * @param unifiedDiff - The unified diff string
 * @returns The parsed old and new text
 */
function parseUnifiedDiff(unifiedDiff: string): ParsedDiff {
	const lines = unifiedDiff.split("\n")
	const oldLines: string[] = []
	const newLines: string[] = []

	let inHunk = false

	for (const line of lines) {
		// Skip diff headers
		if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
			continue
		}

		// Detect hunk header
		if (line.startsWith("@@")) {
			inHunk = true
			continue
		}

		if (!inHunk) {
			continue
		}

		if (line.startsWith("-")) {
			// Line was removed (exists in old, not in new)
			oldLines.push(line.substring(1))
		} else if (line.startsWith("+")) {
			// Line was added (exists in new, not in old)
			newLines.push(line.substring(1))
		} else if (line.startsWith(" ") || line === "") {
			// Context line (exists in both) - remove the leading space
			const content = line.startsWith(" ") ? line.substring(1) : line
			oldLines.push(content)
			newLines.push(content)
		} else if (line.startsWith("\\")) {
		} else {
			// Unknown line format, treat as context
			oldLines.push(line)
			newLines.push(line)
		}
	}

	return {
		oldText: oldLines.join("\n"),
		newText: newLines.join("\n"),
	}
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
 * Translate a "say" type Dirac message to ACP updates.
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
			toolCallId = translateWebSearchMarkerMessage(webSearchQuery, message, sessionState, updates)
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _legacyTranslateSayMessage_unused(
	_message: DiracMessage,
	_sessionState: AcpSessionState,
	_options: TranslateMessageOptions | undefined,
	_updates: acp.SessionUpdate[],
	_toolCallId: string | undefined,
): void {}

function translateWebSearchMarkerMessage(
	query: string,
	message: DiracMessage,
	sessionState: AcpSessionState,
	updates: acp.SessionUpdate[],
): string {
	const toolCallId = sessionState.currentToolCallId || generateToolCallId()

	const isExistingToolCall = !!sessionState.currentToolCallId

	if (!isExistingToolCall) {
		sessionState.currentToolCallId = toolCallId
		updates.push({
			sessionUpdate: "tool_call",
			toolCallId,
			title: `Web Search: ${query}`,
			kind: "search",
			status: "in_progress",
			rawInput: { query },
		})
	} else if ((message as any).partial) {
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "in_progress",
			rawInput: { query },
		})
	}

	if (!(message as any).partial) {
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "completed",
			rawInput: { query },
			rawOutput: { query },
		})
		sessionState.currentToolCallId = undefined
	}

	return toolCallId
}

/**
 * Translate a "ask" type Dirac message to ACP updates.
 * Ask messages typically require permission from the client.
 */
// Alias for backward compat — new code uses translateCardMessage / translateMarkdownMessage
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

	const status = mapStatus(card.status)
	const isExisting = sessionState.pendingToolCalls.has(toolCallId)

	if (isExisting) {
		const existing = sessionState.pendingToolCalls.get(toolCallId)!
		existing.status = status
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status,
			rawOutput: card.body ? { body: card.body } : undefined,
		})
		if (isFinalStatus(card.status)) {
			sessionState.pendingToolCalls.delete(toolCallId)
		}
	} else {
		const toolCall: acp.ToolCall = {
			toolCallId,
			title: card.header,
			kind: TOOL_KIND_MAP[card.header] || "other",
			status,
			rawInput: card.body ? { body: card.body } : undefined,
		}
		updates.push({ sessionUpdate: "tool_call", ...toolCall })
		if (!isFinalStatus(card.status)) {
			sessionState.pendingToolCalls.set(toolCallId, toolCall)
		}
	}

	// Handle interaction requests (approval / feedback)
	if (card.status === CardStatus.WAITING_FOR_INPUT && (card.requireApproval || card.requireFeedback)) {
		const existingToolCall = sessionState.pendingToolCalls.get(toolCallId) || { toolCallId, title: card.header, kind: "other" as acp.ToolKind, status: "pending" as acp.ToolCallStatus }
		requiresPermission = true
		if (card.requireApproval) {
			permissionRequest = {
				toolCall: existingToolCall as acp.ToolCall,
				options: [
					{ kind: "allow_once", optionId: "allow_once", name: "Approve" },
					{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
				],
			}
		} else {
			// requireFeedback
			permissionRequest = {
				toolCall: existingToolCall as acp.ToolCall,
				options: [
					{ kind: "allow_once", optionId: DiracAskResponse_MESSAGE, name: "Submit" },
				],
			}
		}
	}

	return { updates, requiresPermission, permissionRequest, toolCallId }
}

const DiracAskResponse_MESSAGE = "messageResponse"

function translateAskMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	const ask = (message as any).ask!
	let requiresPermission = false
	let permissionRequest: TranslatedMessage["permissionRequest"]
	let toolCallId: string | undefined

	switch (ask) {
		case "followup":
		case "plan_mode_respond":
			// These are questions to the user - send as agent message and await next prompt
			if ((message as any).text) {
				let textToSend = (message as any).text

				// Try to parse JSON and extract the response/question field
				// plan_mode_respond uses { response: string, options?: string[] }
				// followup uses { question: string, options?: string[] }
				try {
					const parsed = JSON.parse((message as any).text)
					if (ask === "plan_mode_respond" && parsed.response !== undefined) {
						textToSend = parsed.response
					} else if (ask === "followup" && parsed.question !== undefined) {
						textToSend = parsed.question
					}
				} catch {
					// If parsing fails, use the raw text
				}

				if (textToSend) {
					updates.push({
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: textToSend },
					})
				}
			}
			break

		case "act_mode_respond":
			// act_mode_respond signals the turn is complete but its text content was already
			// sent via the say: "text" message. Don't send it again to avoid duplicate output.
			break

		case "command":
			// Command permission request → tool_call + request_permission
			{
				// Match this command to the streaming-preview tool call that was created
				// while its text was being typed (say:tool / ask:tool). The task executes
				// commands sequentially, so the active preview is always currentToolCallId.
				// We cannot match on ts: the handler flips between say:tool and ask:tool as
				// the command streams and each re-add mints a fresh ts. currentToolCallId is
				// stable for the command's lifetime and is cleared on completion
				// (translateCommandOutputMessage), so it reliably points at *this* command.
				const streamingPreviewId =
					!options?.existingToolCallId &&
					sessionState.currentToolCallId &&
					sessionState.pendingToolCalls.has(sessionState.currentToolCallId)
						? sessionState.currentToolCallId
						: undefined
				const isUpdate = !!options?.existingToolCallId || !!streamingPreviewId
				// Assign to outer toolCallId so processMessageWithDelta can track this message
				toolCallId = options?.existingToolCallId ?? streamingPreviewId ?? generateToolCallId()
				sessionState.currentToolCallId = toolCallId

				if (isUpdate) {
					// This is an update to an existing tool call.
					// When coming from existingToolCallId (same-ts or subsequent-update path):
					//   → update metadata only; permission was already requested on first encounter.
					// When coming from streamingPreviewId (first encounter of ask:command after
					//   ask:tool streaming): → also update title and request permission.
					const existingToolCall = sessionState.pendingToolCalls.get(toolCallId)
					const command = extractCommandFromText((message as any).text)
					if (existingToolCall) {
						existingToolCall.title = buildCommandTitle(command)
						existingToolCall.rawInput = { command }
					}
					if (streamingPreviewId) {
						// First encounter via streaming continuation — send title update and
						// request permission. Subsequent update events arrive with existingToolCallId
						// set (skipping this branch) so permission is only requested once.
						if (command) {
							updates.push({
								sessionUpdate: "tool_call_update",
								toolCallId,
								title: buildCommandTitle(command),
								rawInput: { command },
							})
						}
						if (!(message as any).partial) {
							const tc = sessionState.pendingToolCalls.get(toolCallId)
							if (tc) {
								requiresPermission = true
								permissionRequest = {
									toolCall: tc,
									options: [
										{ kind: "allow_once", optionId: "allow_once", name: "Allow Once" },
										{ kind: "allow_always", optionId: "allow_always", name: "Always Allow" },
										{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
									],
								}
							}
						}
					}
					// existingToolCallId path: metadata already updated above; no emit, no permission.
				} else {
					const toolCall: acp.ToolCall = {
						toolCallId,
						title: buildCommandTitle(extractCommandFromText((message as any).text)),
						kind: "execute",
						status: "pending",
						rawInput: { command: extractCommandFromText((message as any).text) },
					}

					updates.push({
						sessionUpdate: "tool_call",
						...toolCall,
					})

					sessionState.pendingToolCalls.set(toolCallId, toolCall)

					// Only request permission for non-partial (complete) command messages
					if (!(message as any).partial) {
						requiresPermission = true
						permissionRequest = {
							toolCall,
							options: [
								{ kind: "allow_once", optionId: "allow_once", name: "Allow Once" },
								{ kind: "allow_always", optionId: "allow_always", name: "Always Allow" },
								{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
							],
						}
					}
				}

				// Surface execution progress/output. execute_command never emits
				// say:command_output — it mutates *this* ask:command message in place,
				// carrying the command's output in multiCommandState and flipping
				// commandCompleted false (running) → true (done). commandCompleted is
				// undefined during the permission/preview phase handled above (no
				// output yet); once it is defined we emit tool_call_update(s) so the
				// client sees the output and a terminal completed/failed status,
				// instead of the tool_call freezing at pending/in_progress. The
				// permission/preview branches above are left untouched — this is
				// purely additive.
				if (toolCallId && message.multiCommandState && (message as any).commandCompleted !== undefined) {
					const existing = sessionState.pendingToolCalls.get(toolCallId)
					const alreadyTerminal = existing?.status === "completed" || existing?.status === "failed"
					if (!alreadyTerminal) {
						const exec = buildCommandExecutionUpdates(
							toolCallId,
							message.multiCommandState,
							(message as any).commandCompleted === true,
							options?.clientCapabilities,
						)
						updates.push(...exec.updates)
						if (existing) existing.status = exec.status
					}
				}
			}
			break

		case "tool":
			// Tool permission request → tool_call + request_permission
			{
				const toolInfo = (message as any).text ? parseToolInfo((message as any).text) : null
				// Reuse the active command's tool call across the say:tool↔ask:tool flips
				// that happen as a command streams: each flip re-adds the message under a
				// fresh ts, so existingToolCallId (keyed by ts) misses and we would otherwise
				// mint a duplicate tool call for the same command — polluting matching and
				// leaving an orphan "Execute: <partial>" entry in the client. currentToolCallId
				// is stable for the command's lifetime (cleared on completion).
				const reuseId =
					options?.existingToolCallId ??
					(sessionState.currentToolCallId && sessionState.pendingToolCalls.has(sessionState.currentToolCallId)
						? sessionState.currentToolCallId
						: undefined)
				const isUpdate = !!reuseId

				toolCallId = reuseId ?? generateToolCallId()
				sessionState.currentToolCallId = toolCallId

				if (isUpdate) {
					// This is an update to an existing streaming tool call - send tool_call_update
					updates.push({
						sessionUpdate: "tool_call_update",
						toolCallId,
						status: "pending",
						rawInput: toolInfo?.input,
						content: toolInfo?.path
							? [
									{
										type: "content",
										content: { type: "text", text: toolInfo.path },
									},
								]
							: undefined,
					})
					// Don't require permission again for updates - only for final non-partial message
					// Permission will be requested when partial=false
					if (!(message as any).partial) {
						const existingToolCall = sessionState.pendingToolCalls.get(toolCallId)
						if (existingToolCall) {
							// Update the existing tool call with latest info
							existingToolCall.rawInput = toolInfo?.input
							existingToolCall.locations = toolInfo?.path ? [{ path: toolInfo.path }] : undefined
							existingToolCall.title = toolInfo?.title || existingToolCall.title
							requiresPermission = true
							permissionRequest = {
								toolCall: existingToolCall,
								options: [
									{ kind: "allow_once", optionId: "allow_once", name: "Allow Once" },
									{ kind: "allow_always", optionId: "allow_always", name: "Always Allow" },
									{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
								],
							}
						}
					}
				} else {
					// For plain command strings (e.g. from handlePartialBlock streaming),
					// use execute kind so translatePlainCommandToolMessage can update it later.
					const plainCommand = !toolInfo ? extractCommandFromText((message as any).text) : undefined
					// This is a new tool call
					const toolCall: acp.ToolCall = {
						toolCallId,
						title: plainCommand ? buildCommandTitle(plainCommand) : (toolInfo?.title || "Tool operation"),
						kind: plainCommand ? "execute" : (toolInfo?.kind || "other"),
						status: "pending",
						rawInput: plainCommand ? { command: plainCommand } : toolInfo?.input,
						locations: toolInfo?.path ? [{ path: toolInfo.path }] : undefined,
					}

					updates.push({
						sessionUpdate: "tool_call",
						...toolCall,
					})

					sessionState.pendingToolCalls.set(toolCallId, toolCall)

					// Only request permission for non-partial messages (complete tool calls)
					if (!(message as any).partial) {
						requiresPermission = true
						permissionRequest = {
							toolCall,
							options: [
								{ kind: "allow_once", optionId: "allow_once", name: "Allow Once" },
								{ kind: "allow_always", optionId: "allow_always", name: "Always Allow" },
								{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
							],
						}
					}
				}
			}
			break

		case "browser_action_launch":
			// Browser launch permission
			{
				const toolCallId = generateToolCallId()
				sessionState.currentToolCallId = toolCallId

				const toolCall: acp.ToolCall = {
					toolCallId,
					title: "Browser",
					kind: "execute",
					status: "pending",
					rawInput: { url: (message as any).text },
				}

				updates.push({
					sessionUpdate: "tool_call",
					...toolCall,
				})

				sessionState.pendingToolCalls.set(toolCallId, toolCall)
				requiresPermission = true
				permissionRequest = {
					toolCall,
					options: [
						{ kind: "allow_once", optionId: "allow_once", name: "Allow Once" },
						{ kind: "reject_once", optionId: "reject_once", name: "Reject" },
					],
				}
			}
			break

		case "completion_result":
			// Completion result needs a leading newline to separate from previous content
			if ((message as any).text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "\n" + (message as any).text },
				})
			}
			break
		case "resume_task":
		case "resume_completed_task":
		case "new_task":
		case "condense":
		case "summarize_task":
		case "report_bug":
		case "command_output":
			// These are typically handled internally or shown as messages
			if ((message as any).text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: (message as any).text },
				})
			}
			break

		case "api_req_failed":
		case "mistake_limit_reached": {
			// streamingFailedMessage is a JSON envelope with a `message` field
			// carrying the human-readable summary; fall back to the raw text.
			if (!(message as any).text) break
			let displayText = (message as any).text
			try {
				const parsed = JSON.parse((message as any).text)
				if (typeof parsed?.message === "string") {
					displayText = parsed.message
				}
			} catch {
				// Not a JSON envelope — use raw text.
			}
			const title = (message as any).ask === "api_req_failed" ? "API request failed" : "Mistake limit reached"
			pushFailureToolCall(updates, sessionState, title, displayText, { rawMessage: (message as any).text })
			break
		}
	}

	return { updates, requiresPermission, permissionRequest, toolCallId }
}

/**
 * Translate a tool message to ACP tool_call updates.
 */
function translateToolMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	clientCapabilities?: acp.ClientCapabilities,
): acp.SessionUpdate[] {
	const updates: acp.SessionUpdate[] = []

	if (!(message as any).text) return updates

	try {
		const toolInfo = JSON.parse((message as any).text) as DiracSayTool
		const toolCallId = sessionState.currentToolCallId || generateToolCallId()

		// Determine tool kind
		const kind = TOOL_KIND_MAP[toolInfo.tool] || "other"

		// Determine status based on message state
		const status: acp.ToolCallStatus = (message as any).partial ? "in_progress" : "completed"

		// Build title
		const title = buildToolTitle(toolInfo)

		// Build content
		const content: acp.ToolCallContent[] = buildToolContent(toolInfo)
		if (toolInfo.diff) {
			// Parse the unified diff to extract old and new text
			const parsedDiff = parseUnifiedDiff(toolInfo.diff)
			content.push({
				type: "diff",
				path: toolInfo.path || "",
				oldText: parsedDiff.oldText,
				newText: parsedDiff.newText,
			})
		}

		// Build locations
		const locations: acp.ToolCallLocation[] = []
		if (toolInfo.path) {
			locations.push({ path: toolInfo.path })
		}

		if (!sessionState.currentToolCallId) {
			// New tool call. ACP clients behave better when execution always starts with
			// a tool_call lifecycle event, then completes via tool_call_update.
			sessionState.currentToolCallId = toolCallId
			updates.push({
				sessionUpdate: "tool_call",
				toolCallId,
				title,
				kind,
				status: "in_progress",
				rawInput: toolInfo,
				content: content.length > 0 ? content : undefined,
				locations: locations.length > 0 ? locations : undefined,
			})

			if (status === "completed") {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status,
					rawOutput: toolInfo,
					content: content.length > 0 ? content : undefined,
				})
			}
		} else {
			// Update existing tool call
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status,
				rawOutput: toolInfo,
				content: content.length > 0 ? content : undefined,
			})
		}

		// Clear current tool call ID if completed
		if (status === "completed") {
			sessionState.currentToolCallId = undefined
		}
	} catch {
		const commandUpdate = translatePlainCommandToolMessage(message, sessionState, clientCapabilities)
		if (commandUpdate) {
			updates.push(commandUpdate)
		}
		// No agent_message_chunk fallback: say:tool messages with non-JSON content are
		// partial streaming previews from handlePartialBlock. The real execute tool call
		// lifecycle arrives via ask:command when execute() runs — emitting text here
		// would produce cumulative command text spam in the client.
	}

	return updates
}

function translatePlainCommandToolMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	clientCapabilities?: acp.ClientCapabilities,
): acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" } | undefined {
	const command = extractCommandFromText((message as any).text)
	const toolCallId = sessionState.currentToolCallId
	if (!command || !toolCallId) return undefined

	const pendingToolCall = sessionState.pendingToolCalls.get(toolCallId)
	if (!pendingToolCall || pendingToolCall.kind !== "execute") return undefined

	pendingToolCall.status = "in_progress"
	pendingToolCall.rawInput = { ...(pendingToolCall.rawInput as Record<string, unknown> | undefined), command }
	pendingToolCall.title = buildCommandTitle(command)
	const supportsTerminalOutput = clientSupportsTerminalOutput(clientCapabilities)

	return {
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "in_progress",
		rawInput: { command },
		content: supportsTerminalOutput
			? [{ type: "terminal", terminalId: toolCallId }]
			: [
					{
						type: "content",
						content: { type: "text", text: `$ ${command}` },
					},
				],
		_meta: supportsTerminalOutput
			? {
					terminal_info: {
						terminal_id: toolCallId,
					},
				}
			: undefined,
	}
}

/**
 * Translate a command message to ACP tool_call.
 */
function translateCommandMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	clientCapabilities?: acp.ClientCapabilities,
): acp.SessionUpdate[] {
	const updates: acp.SessionUpdate[] = []

	const command = extractCommandFromText((message as any).text)
	const supportsTerminalOutput = clientSupportsTerminalOutput(clientCapabilities)

	// Reuse the existing pending tool call when one was already created by
	// ask:command (permission flow) or ask:tool (streaming preview). Generating
	// a fresh ID here would produce a second "in_progress" tool_call alongside
	// the existing "pending" one, showing two entries for the same command.
	const existingId =
		sessionState.currentToolCallId && sessionState.pendingToolCalls.has(sessionState.currentToolCallId)
			? sessionState.currentToolCallId
			: undefined

	if (existingId) {
		// Transition the existing pending tool call to in_progress now that the
		// command is actually running.
		const pendingToolCall = sessionState.pendingToolCalls.get(existingId)
		if (pendingToolCall) {
			pendingToolCall.status = "in_progress"
		}
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId: existingId,
			status: "in_progress",
			rawInput: { command },
			content: supportsTerminalOutput
				? [{ type: "terminal", terminalId: existingId }]
				: [{ type: "content", content: { type: "text", text: `$ ${command}` } }],
			_meta: supportsTerminalOutput ? { terminal_info: { terminal_id: existingId } } : undefined,
		})
		return updates
	}

	// No existing tool call — auto-approve path where ask:command was never sent.
	const toolCallId = generateToolCallId()
	sessionState.currentToolCallId = toolCallId

	updates.push({
		sessionUpdate: "tool_call",
		toolCallId,
		title: buildCommandTitle(command),
		kind: "execute",
		// Command execution finishes via command_output, so the initial lifecycle
		// event should stay in progress even for non-partial messages.
		status: "in_progress",
		rawInput: { command },
		content: supportsTerminalOutput
			? [{ type: "terminal", terminalId: toolCallId }]
			: [{ type: "content", content: { type: "text", text: `$ ${command}` } }],
		_meta: supportsTerminalOutput ? { terminal_info: { terminal_id: toolCallId } } : undefined,
	})

	return updates
}

/**
 * Translate command output to ACP tool_call_update.
 */
function translateCommandOutputMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	clientCapabilities?: acp.ClientCapabilities,
): acp.SessionUpdate[] {
	const updates: acp.SessionUpdate[] = []

	if (sessionState.currentToolCallId) {
		const toolCallId = sessionState.currentToolCallId
		const status: acp.ToolCallStatus = (message as any).commandCompleted ? "completed" : "in_progress"
		const supportsTerminalOutput = clientSupportsTerminalOutput(clientCapabilities)

		if (supportsTerminalOutput) {
			if ((message as any).text) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					_meta: {
						terminal_output: {
							terminal_id: toolCallId,
							data: (message as any).text,
						},
					},
				})
			}

			if ((message as any).commandCompleted) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status,
					rawOutput: (message as any).text ? { output: (message as any).text } : undefined,
					_meta: {
						terminal_exit: {
							terminal_id: toolCallId,
							exit_code: 0,
							signal: null,
						},
					},
				})
				sessionState.currentToolCallId = undefined
			}

			return updates
		}

		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status,
			// Store output in rawOutput and optionally as text content
			rawOutput: (message as any).text ? { output: (message as any).text } : undefined,
			content: (message as any).text
				? [
						{
							type: "content",
							content: { type: "text", text: formatCommandOutputContent((message as any).text) },
						},
					]
				: undefined,
		})

		if ((message as any).commandCompleted) {
			sessionState.currentToolCallId = undefined
		}
	} else {
		// No active tool call, show as message
		if ((message as any).text) {
			updates.push({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `Output:\n${(message as any).text}` },
			})
		}
	}

	return updates
}

function clientSupportsTerminalOutput(clientCapabilities?: acp.ClientCapabilities): boolean {
	return clientCapabilities?._meta?.terminal_output === true
}

function formatCommandOutputContent(output: string): string {
	return `\`\`\`console\n${output.trimEnd()}\n\`\`\``
}

/**
 * Aggregate the human-readable output of an execute_command run. The output is
 * stored per-command on multiCommandState (mutated in place as the command
 * runs): for a single command this is just its stdout/stderr; for several it
 * labels each segment.
 */
function formatMultiCommandOutput(multiCommandState: MultiCommandState): string {
	const many = multiCommandState.commands.length > 1
	const parts: string[] = []
	for (const cmd of multiCommandState.commands) {
		const out = (cmd.output ?? "").trimEnd()
		if (many) {
			parts.push(`$ ${(cmd as any).displayName || cmd.command}`)
			parts.push(out || "(no output)")
		} else if (out) {
			parts.push(out)
		}
	}
	return parts.join("\n")
}

/**
 * Translate an execute_command's in-place progress (carried on the ask:command
 * message via multiCommandState + commandCompleted) into tool_call_update(s).
 *
 * This is the only place a command's output and terminal completed/failed
 * status reach the client — execute_command never emits say:command_output, so
 * without this the command tool_call would freeze at "pending"/"in_progress"
 * with no output and the model would be the sole consumer of the result.
 */
function buildCommandExecutionUpdates(
	toolCallId: string,
	multiCommandState: MultiCommandState,
	completed: boolean,
	clientCapabilities?: acp.ClientCapabilities,
): { updates: acp.SessionUpdate[]; status: acp.ToolCallStatus } {
	const anyFailed = multiCommandState.commands.some((c) => c.status === "failed")
	const status: acp.ToolCallStatus = completed ? (anyFailed ? "failed" : "completed") : "in_progress"
	const output = formatMultiCommandOutput(multiCommandState)
	const updates: acp.SessionUpdate[] = []

	if (clientSupportsTerminalOutput(clientCapabilities)) {
		// Terminal-capable clients render output through the terminal channel.
		// execute_command delivers its output in one shot at completion (it is
		// not streamed incrementally), so emit the data + exit once on completion.
		if (completed) {
			if (output) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					_meta: { terminal_output: { terminal_id: toolCallId, data: output } },
				})
			}
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status,
				rawOutput: output ? { output } : undefined,
				_meta: { terminal_exit: { terminal_id: toolCallId, exit_code: anyFailed ? 1 : 0, signal: null } },
			})
		} else {
			updates.push({ sessionUpdate: "tool_call_update", toolCallId, status })
		}
		return { updates, status }
	}

	// Only include content when there is actual output to show.
	// Matches claude-agent-acp's pattern: empty Bash results return no content
	// field rather than a placeholder, so the client doesn't render stale text.
	const content: acp.ToolCallContent[] | undefined = output
		? [{ type: "content", content: { type: "text", text: formatCommandOutputContent(output) } }]
		: undefined

	updates.push({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status,
		rawOutput: output ? { output } : undefined,
		...(content ? { content } : {}),
	})
	return { updates, status }
}

/**
 * Translate browser action to ACP tool_call.
 */
function translateBrowserActionMessage(message: DiracMessage, sessionState: AcpSessionState): acp.SessionUpdate[] {
	const updates: acp.SessionUpdate[] = []

	try {
		const action = (message as any).text ? (JSON.parse((message as any).text) as DiracSayBrowserAction) : null
		const toolCallId = sessionState.currentToolCallId || generateToolCallId()

		if (!sessionState.currentToolCallId) {
			sessionState.currentToolCallId = toolCallId
		}
		const title = action ? `Browser ${action.action}` : "Browser"
		const kind = action ? BROWSER_ACTION_KIND_MAP[action.action] || "execute" : "execute"

		updates.push({
			sessionUpdate: "tool_call",
			toolCallId,
			title,
			kind,
			status: "in_progress",
			rawInput: action,
		})
	} catch {
		updates.push({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: (message as any).text || "Browser action" },
		})
	}

	return updates
}

/**
 * Translate task progress (focus chain/todos) to ACP plan update.
 */

/**
 * Parse markdown checklist format into ACP plan entries.
 *
 * Example input:
 * - [x] Completed task
 * - [ ] Pending task
 * - Currently working on this
 */

const READ_TOOL_KINDS = new Set<string | number>([
	"readFile", "read_file", "readLineRange", "read_line_range",
	"getFunction", "get_function", "getFileSkeleton", "get_file_skeleton",
	"newFileCreated",
	3, // DiracSayToolType.READ_FILE
	5, // DiracSayToolType.NEW_FILE_CREATED
])
const LIST_TOOL_KINDS = new Set<string | number>([
	"listFilesTopLevel", "list_files_top_level",
	"listFilesRecursive", "list_files_recursive",
	"listCodeDefinitionNames",
	4, // DiracSayToolType.LIST_FILES_TOP_LEVEL
	5, // DiracSayToolType.LIST_FILES_RECURSIVE (index may vary)
])

/**
 * Format tool call display content as markdown.
 *
 * Read tools show `* path: [File Hash: xxx]` bullets rather than raw source.
 * List tools convert the directory listing to a markdown bullet list.
 */
function buildToolContent(toolInfo: DiracSayTool): acp.ToolCallContent[] {
	if (!toolInfo.content) return []

	if (READ_TOOL_KINDS.has(toolInfo.tool)) {
		// Extract all [File Hash: ...] lines from the combined content blob
		const hashLines = toolInfo.content.split("\n").filter((l) => l.startsWith("[File Hash:"))

		// Gather the ordered list of paths from readFileResults, falling back to paths/path
		const paths = getDistinctPaths(toolInfo)

		if (paths.length > 0) {
			const bullets = paths
				.map((p, i) => {
					const hash = hashLines[i]
					return hash ? `* ${p}: ${hash}` : `* ${p}`
				})
				.join("\n")
			return [{ type: "content", content: { type: "text", text: bullets } }]
		}

		// No paths available — show hash lines only (or fall through to code-fence)
		if (hashLines.length > 0) {
			return [{ type: "content", content: { type: "text", text: hashLines.join("\n") } }]
		}

		return [{ type: "content", content: { type: "text", text: `\`\`\`\n${toolInfo.content}\n\`\`\`` } }]
	}

	if (LIST_TOOL_KINDS.has(toolInfo.tool)) {
		// Convert directory listing header + entries into a markdown bullet list
		const lines = toolInfo.content
			.split("\n")
			.filter(
				(l) =>
					l.trim() !== "" &&
					!l.startsWith("Contents of") &&
					!l.startsWith("[Note:") &&
					!/^\d+ out of \d+/.test(l),
			)
			.map((l) => `* ${l}`)
			.join("\n")
		return lines ? [{ type: "content", content: { type: "text", text: lines } }] : []
	}

	// Default: pass through as-is
	return [{ type: "content", content: { type: "text", text: toolInfo.content } }]
}

/**
 * Return the deduplicated ordered list of file paths referenced by a tool call,
 * preferring readFileResults order (which matches the actual reads) then paths, then path.
 */
function getDistinctPaths(toolInfo: DiracSayTool): string[] {
	const readFileResults = Array.isArray((toolInfo as any).readFileResults) ? (toolInfo as any).readFileResults : []
	const resultPaths: string[] = readFileResults
		.map((r: any) => (typeof r?.path === "string" ? r.path : ""))
		.filter(Boolean)

	const extraPaths: string[] = Array.isArray((toolInfo as any).paths)
		? (toolInfo as any).paths.filter((p: unknown) => typeof p === "string")
		: []

	const seen = new Set<string>()
	const ordered: string[] = []
	for (const p of [...resultPaths, ...extraPaths, ...(toolInfo.path ? [toolInfo.path] : [])]) {
		if (!seen.has(p)) {
			seen.add(p)
			ordered.push(p)
		}
	}
	return ordered
}

/**
 * Build a human-readable title for a tool operation.
 */
function buildToolTitle(toolInfo: DiracSayTool): string {
	const suffix = getToolTitleSuffix(toolInfo)
	const verb = getToolDisplayVerb(toolInfo.tool)
	return suffix ? `${verb} ${suffix}` : verb
}

function getToolDisplayVerb(toolName: string | number): string {
	switch (toolName) {
		case "editFile":
		case "editedExistingFile":
			return "Edit"
		case "replaceSymbol":
			return "Edit"
		case "newFileCreated":
			return "Create"
		case "fileDeleted" as any:
			return "Delete"
		case "readFile":
		case "readLineRange":
			return "Read"
		case "listFilesTopLevel":
		case "listFilesRecursive":
			return "List"
		case "listCodeDefinitionNames":
			return "List"
		case "searchFiles":
			return "Search"
		case "summarizeTask":
			return "Summarize"
		case "useSkill":
			return "Use Skill"
		case "listSkills":
			return "List Skills"
		case "use_subagents" as any:
			return "Use Subagents"
		case "getFunction":
			return "Read"
		case "getFileSkeleton":
			return "Read"
		case "findSymbolReferences":
			return "Search"
		case "diagnosticsScan" as any:
			return "Diagnostics"
		default:
			return "Tool"
	}
}

function getToolTitleSuffix(toolInfo: DiracSayTool): string {
	if ((toolInfo.tool as unknown) === "searchFiles" || (toolInfo.tool as unknown as number) === 7) { // 7 = DiracSayToolType.SEARCH_FILES
		const searchCandidate = (toolInfo as any).regex || (toolInfo as any).query || (toolInfo as any).pattern
		return typeof searchCandidate === "string" ? searchCandidate : ""
	}

	const pathList = getDistinctPaths(toolInfo)

	if (pathList.length > 0) {
		return pathList.join(", ")
	}

	const candidate = (toolInfo as any).regex || (toolInfo as any).query || (toolInfo as any).pattern
	return typeof candidate === "string" ? candidate : ""
}

function buildCommandTitle(command: string): string {
	return command ? `Execute: ${command}` : "Execute"
}

/**
 * Extract command text from a message.
 */
function extractCommandFromText(text?: string): string {
	if (!text) return ""
	// Remove any surrounding whitespace and potential formatting
	return text.trim()
}

/**
 * Parse tool info from message text.
 */
function parseToolInfo(text: string): { title: string; kind: acp.ToolKind; path?: string; input?: unknown } | null {
	try {
		const info = JSON.parse(text) as DiracSayTool
		return {
			title: buildToolTitle(info),
			kind: TOOL_KIND_MAP[info.tool] || "other",
			path: info.path,
			input: info,
		}
	} catch {
		return null
	}
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
