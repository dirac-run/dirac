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
import type { DiracMessage, DiracSayBrowserAction, DiracSayTool, MultiCommandState } from "@shared/ExtensionMessage"
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

	if (message.type === "say" && message.say) {
		const sayResult = translateSayMessage(message, sessionState, options)
		updates.push(...sayResult.updates)
		toolCallId = sayResult.toolCallId
	} else if (message.type === "ask" && message.ask) {
		const askResult = translateAskMessage(message, sessionState, options)
		updates.push(...askResult.updates)
		requiresPermission = askResult.requiresPermission ?? false
		permissionRequest = askResult.permissionRequest
		toolCallId = askResult.toolCallId
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
function translateSayMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	let toolCallId: string | undefined
	const say = message.say!

	switch (say) {
		case "text":
			// Codex web-search markers → ACP search tool lifecycle.
			if (message.text) {
				const webSearchQuery = parseWebSearchMarkerText(message.text)
				if (webSearchQuery) {
					toolCallId = translateWebSearchMarkerMessage(webSearchQuery, message, sessionState, updates)
					break
				}
			}

			// A retry chain ends successfully when the API actually starts
			// returning content. Mark the open "Retrying API request" tool_call
			// as completed so it doesn't linger as in_progress forever.
			if (sessionState.retryToolCallId && message.text) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.retryToolCallId,
					status: "completed",
				})
				sessionState.retryToolCallId = undefined
			}

			// Text messages → agent_message_chunk
			if (message.text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.text },
				})
			}
			break

		case "user_feedback":
		case "user_feedback_diff":
			// User feedback messages - don't echo the user's input back to them
			// The ACP client already displays what the user typed
			break

		case "reasoning":
			// Reasoning/thinking → agent_thought_chunk
			if (message.reasoning || message.text) {
				updates.push({
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: message.reasoning || message.text || "" },
				})
			}
			break

		case "tool":
			// Tool execution → tool_call with status updates
			updates.push(...translateToolMessage(message, sessionState, options?.clientCapabilities))
			break

		case "command":
			// Command execution → tool_call (kind: execute)
			updates.push(...translateCommandMessage(message, sessionState, options?.clientCapabilities))
			break

		case "command_output":
			// Command output → tool_call_update with terminal content
			updates.push(...translateCommandOutputMessage(message, sessionState, options?.clientCapabilities))
			break

		case "completion_result":
			// Task completion - no direct update needed, handled by stopReason in prompt response
			// But we can send a final message chunk with a leading newline to separate from previous content
			if (message.text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "\n" + message.text },
				})
			}
			break

		case "error":
		case "diff_error":
		case "diracignore_error": {
			// Surface as a failed tool_call lifecycle so clients render error
			// styling instead of plain white agent text.
			if (!message.text) break
			const title =
				message.say === "diff_error"
					? "File edit failed"
					: message.say === "diracignore_error"
						? "Access blocked by .diracignore"
						: "Task error"
			pushFailureToolCall(updates, sessionState, title, message.text, { error: message.text })
			break
		}

		case "error_retry": {
			// `error_retry` payload is JSON: {failed, attempt, maxAttempts, errorMessage}.
			// In-flight retries collapse into a single evolving tool_call so the
			// client shows one "Retrying API request" item that updates per
			// attempt rather than three white text lines. The terminal
			// "retries exhausted" message fails that same tool_call.
			if (!message.text) break
			const retry = (() => {
				try {
					return JSON.parse(message.text) as {
						failed?: boolean
						attempt?: number
						maxAttempts?: number
						errorMessage?: string
					}
				} catch {
					return null
				}
			})()
			// errorMessage is sometimes itself a JSON object — unwrap one level.
			let errMsg = retry?.errorMessage ?? ""
			if (errMsg) {
				try {
					const inner = JSON.parse(errMsg) as { message?: string }
					errMsg = inner.message ?? errMsg
				} catch {}
			}
			const attemptN = retry?.attempt ?? "?"
			const maxN = retry?.maxAttempts ?? "?"
			const reasonText = errMsg || "request failed"

			if (retry?.failed) {
				const display = `Failed after ${maxN} retries: ${reasonText}`
				if (sessionState.retryToolCallId) {
					updates.push({
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.retryToolCallId,
						status: "failed",
						content: [{ type: "content", content: { type: "text", text: display } }],
						rawOutput: { error: message.text },
					})
					sessionState.retryToolCallId = undefined
				} else {
					pushFailureToolCall(updates, sessionState, "Request failed", display, {
						error: message.text,
					})
				}
				break
			}

			const display = retry
				? `Retrying... (attempt ${attemptN}/${maxN}): ${reasonText}`
				: `Error: ${message.text}`
			if (!sessionState.retryToolCallId) {
				sessionState.retryToolCallId = generateToolCallId()
				updates.push({
					sessionUpdate: "tool_call",
					toolCallId: sessionState.retryToolCallId,
					title: "Retrying API request",
					kind: "other",
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: display } }],
				})
			} else {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.retryToolCallId,
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: display } }],
				})
			}
			break
		}

		case "browser_action_launch":
		case "browser_action":
			// Browser actions → tool_call (kind: execute)
			updates.push(...translateBrowserActionMessage(message, sessionState))
			break

		case "browser_action_result":
			// Browser action result → tool_call_update
			if (sessionState.currentToolCallId) {
				const result = message.text ? JSON.parse(message.text) : {}
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.currentToolCallId,
					status: "completed",
					rawOutput: result,
				})
				sessionState.currentToolCallId = undefined
			}
			break

		case "api_req_started":
			// API request started - could be shown as agent thinking
			// updates.push({
			// 	sessionUpdate: "agent_thought_chunk",
			// 	content: { type: "text", text: "Making API Request" },
			// })
			//
			// Turn boundary: each assistant turn runs at most one tool, and a tool's
			// result is fed back in the *next* turn's request. execute_command in ACP
			// never emits a command_output/say:command completion event (the result is
			// swallowed into this api_req_started payload), so currentToolCallId would
			// otherwise never clear and every command in the task would collapse onto the
			// first command's tool call.
			//
			// Only release currentToolCallId when a NEW api_req_started begins (different
			// ts). The same api_req_started keeps streaming partial token/cost updates
			// across the whole turn — clearing on those would fire *between* a command's
			// streaming preview and its ask:command, splitting one command into two tool
			// calls. A new ts means the previous turn (and its command) is done, so the
			// next command's preview mints a fresh tool call and its permission aligns.
			if (message.ts !== sessionState.lastApiReqStartedTs) {
				sessionState.lastApiReqStartedTs = message.ts
				sessionState.currentToolCallId = undefined
			}
			break

		case "api_req_finished":
			// API request finished - no specific update needed
			break

		case "subagent_usage":
			// Hidden aggregate metrics event used for task-level accounting.
			break

		case "task":
			// Task started - don't echo the user's prompt back to them
			// The ACP client already knows what they typed
			break


		case "hook_status":
			// Format hook status as a human-readable message
			if (message.text) {
				try {
					const hookInfo = JSON.parse(message.text) as { hookName: string; status: string; toolName?: string }
					const target = hookInfo.toolName ? ` for ${hookInfo.toolName}` : ""
					let statusText: string
					switch (hookInfo.status) {
						case "running":
							statusText = `Running ${hookInfo.hookName} hook${target}...`
							break
						case "completed":
							statusText = `${hookInfo.hookName} hook completed`
							break
						case "cancelled":
							statusText = `${hookInfo.hookName} hook cancelled`
							break
						default:
							statusText = `${hookInfo.hookName} hook: ${hookInfo.status}`
					}
					updates.push({
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: statusText },
					})
				} catch {
					// If parsing fails, skip the message rather than showing raw JSON
				}
			}
			break

		case "hook_output_stream":
			// Suppress hook output streams in ACP mode - these are debug details
			// that clutter the conversation. The hook_status message provides
			// sufficient user-facing feedback.
			break

		case "info":
		case "shell_integration_warning":
		case "shell_integration_warning_with_suggestion":
		case "checkpoint_created":
		case "deleted_api_reqs":
		case "api_req_retried":
		case "command_permission_denied":
		case "generate_explanation":
		case "conditional_rules_applied":
			// Informational messages - optionally shown as agent messages
			if (message.text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.text },
				})
			}
			break
	}

	return { updates, toolCallId }
}

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
	} else if (message.partial) {
		updates.push({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "in_progress",
			rawInput: { query },
		})
	}

	if (!message.partial) {
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
function translateAskMessage(
	message: DiracMessage,
	sessionState: AcpSessionState,
	options?: TranslateMessageOptions,
): TranslatedMessage {
	const updates: acp.SessionUpdate[] = []
	const ask = message.ask!
	let requiresPermission = false
	let permissionRequest: TranslatedMessage["permissionRequest"]
	let toolCallId: string | undefined

	switch (ask) {
		case "followup":
		case "plan_mode_respond":
			// These are questions to the user - send as agent message and await next prompt
			if (message.text) {
				let textToSend = message.text

				// Try to parse JSON and extract the response/question field
				// plan_mode_respond uses { response: string, options?: string[] }
				// followup uses { question: string, options?: string[] }
				try {
					const parsed = JSON.parse(message.text)
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
					const command = extractCommandFromText(message.text)
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
						if (!message.partial) {
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
						title: buildCommandTitle(extractCommandFromText(message.text)),
						kind: "execute",
						status: "pending",
						rawInput: { command: extractCommandFromText(message.text) },
					}

					updates.push({
						sessionUpdate: "tool_call",
						...toolCall,
					})

					sessionState.pendingToolCalls.set(toolCallId, toolCall)

					// Only request permission for non-partial (complete) command messages
					if (!message.partial) {
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
				if (toolCallId && message.multiCommandState && message.commandCompleted !== undefined) {
					const existing = sessionState.pendingToolCalls.get(toolCallId)
					const alreadyTerminal = existing?.status === "completed" || existing?.status === "failed"
					if (!alreadyTerminal) {
						const exec = buildCommandExecutionUpdates(
							toolCallId,
							message.multiCommandState,
							message.commandCompleted === true,
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
				const toolInfo = message.text ? parseToolInfo(message.text) : null
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
					if (!message.partial) {
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
					const plainCommand = !toolInfo ? extractCommandFromText(message.text) : undefined
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
					if (!message.partial) {
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
					rawInput: { url: message.text },
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
			if (message.text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "\n" + message.text },
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
			if (message.text) {
				updates.push({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.text },
				})
			}
			break

		case "api_req_failed":
		case "mistake_limit_reached": {
			// streamingFailedMessage is a JSON envelope with a `message` field
			// carrying the human-readable summary; fall back to the raw text.
			if (!message.text) break
			let displayText = message.text
			try {
				const parsed = JSON.parse(message.text)
				if (typeof parsed?.message === "string") {
					displayText = parsed.message
				}
			} catch {
				// Not a JSON envelope — use raw text.
			}
			const title = message.ask === "api_req_failed" ? "API request failed" : "Mistake limit reached"
			pushFailureToolCall(updates, sessionState, title, displayText, { rawMessage: message.text })
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

	if (!message.text) return updates

	try {
		const toolInfo = JSON.parse(message.text) as DiracSayTool
		const toolCallId = sessionState.currentToolCallId || generateToolCallId()

		// Determine tool kind
		const kind = TOOL_KIND_MAP[toolInfo.tool] || "other"

		// Determine status based on message state
		const status: acp.ToolCallStatus = message.partial ? "in_progress" : "completed"

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
	const command = extractCommandFromText(message.text)
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

	const command = extractCommandFromText(message.text)
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
		const status: acp.ToolCallStatus = message.commandCompleted ? "completed" : "in_progress"
		const supportsTerminalOutput = clientSupportsTerminalOutput(clientCapabilities)

		if (supportsTerminalOutput) {
			if (message.text) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					_meta: {
						terminal_output: {
							terminal_id: toolCallId,
							data: message.text,
						},
					},
				})
			}

			if (message.commandCompleted) {
				updates.push({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status,
					rawOutput: message.text ? { output: message.text } : undefined,
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
			rawOutput: message.text ? { output: message.text } : undefined,
			content: message.text
				? [
						{
							type: "content",
							content: { type: "text", text: formatCommandOutputContent(message.text) },
						},
					]
				: undefined,
		})

		if (message.commandCompleted) {
			sessionState.currentToolCallId = undefined
		}
	} else {
		// No active tool call, show as message
		if (message.text) {
			updates.push({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `Output:\n${message.text}` },
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
			parts.push(`$ ${cmd.displayName || cmd.command}`)
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
		const action = message.text ? (JSON.parse(message.text) as DiracSayBrowserAction) : null
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
			content: { type: "text", text: message.text || "Browser action" },
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

const READ_TOOL_KINDS = new Set([
	"readFile", "read_file", "readLineRange", "read_line_range",
	"getFunction", "get_function", "getFileSkeleton", "get_file_skeleton",
	"newFileCreated",
])
const LIST_TOOL_KINDS = new Set([
	"listFilesTopLevel", "list_files_top_level",
	"listFilesRecursive", "list_files_recursive",
	"listCodeDefinitionNames",
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

function getToolDisplayVerb(toolName: string): string {
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
	if (toolInfo.tool === "searchFiles") {
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
