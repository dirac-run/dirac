import { ResponseInput, ResponseInputMessageContentList } from "openai/resources/responses/responses"
import {
    DiracAssistantRedactedThinkingBlock,
    DiracAssistantThinkingBlock,
    DiracAssistantToolUseBlock,
    DiracContent,
    DiracImageContentBlock,
    DiracStorageMessage,
    DiracTextContentBlock,
    DiracUserToolResultContentBlock,
} from "@/shared/messages/content"

/**
 * Converts an array of DiracStorageMessage objects (extension of Anthropic format) to a ResponseInput array to use with OpenAI's Responses API.
 *
 * ## Key Differences from Chat Completions API
 *
 * The Responses API has stricter requirements than the Chat Completions API:
 *
 * ### Chat Completions API:
 * - Messages are simple role/content pairs
 * - System prompts are separate messages with role="system"
 * - No explicit reasoning item structure
 * - More forgiving about message ordering
 *
 * ### Responses API:
 * - Uses an "input" array of heterogeneous items (messages, reasoning, function_calls, etc.)
 * - System prompts go in an "instructions" field, not as messages
 * - Reasoning items MUST be immediately followed by a message or function_call
 * - Strict ordering requirements match training data distribution
 *
 * ## The Reasoning Item Constraint
 *
 * **THE CRITICAL ERROR:** "Item 'rs_...' of type 'reasoning' was provided without its required following item"
 *
 * This error occurs when reasoning items are orphaned or separated from their corresponding output.
 *
 * ### What Causes This Error:
 * ```
 * ❌ WRONG - Reasoning orphaned between turns:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },  // ← ORPHANED!
 *   { type: "message", role: "assistant", content: [...] },
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * ### The Fix - Keep Complete Assistant Turns Together:
 * ```
 * ✅ CORRECT - Reasoning paired with its message:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },
 *   { type: "message", role: "assistant", content: [...] },  // ← Immediately follows reasoning
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * **Per OpenAI Engineering Guidance:**
 * - ❌ WRONG: `content += filter(lambda x: x.type == "reasoning", resp.output)`
 * - ✅ CORRECT: `content += resp.output`
 *
 * Never extract only reasoning items - always include the complete output sequence
 * (reasoning + message/function_call) as provided by the API.
 *
 * ## Implementation Strategy
 *
 * 1. **Separate processing for assistant vs user messages** - Assistant turns need special
 *    handling to maintain reasoning-message pairing
 * 2. **Collect all assistant items together** - Gather reasoning, messages, and function_calls
 *    for the entire assistant turn before validating
 * 3. **Validate pairing within each turn** - Ensure each reasoning item is immediately followed
 *    by a message or function_call, inserting placeholders if needed
 * 4. **Flush complete turns atomically** - Add all items from an assistant turn together to
 *    maintain proper sequencing
 *
 * @link https://community.openai.com/t/openai-api-error-function-call-was-provided-without-its-required-reasoning-item-the-real-issue/1355347
 *
 * @param messages - Array of DiracStorageMessage objects to be converted
 * @returns ResponseInput array containing the transformed messages with proper reasoning pairing
 */
export function convertToOpenAIResponsesInput(
	_messages: DiracStorageMessage[],
	options?: { usePreviousResponseId?: boolean },
): {
	input: ResponseInput
	previousResponseId?: string
} {
	// Chain from the latest stored Responses API assistant message when available.
	// When chaining, only send new items after that assistant turn.
	let previousResponseId: string | undefined
	let messages = _messages
	if (options?.usePreviousResponseId) {
		for (let i = _messages.length - 1; i >= 0; i--) {
			const msg = _messages[i]
			if (msg.role === "assistant") {
				// Must be less than 24 hours old to be considered for chaining as the previous Id is only valid for 24 hours.
				// Set to 23 hours to account for any potential delays in processing.
				const isLessThan23HoursOld = msg.ts ? Date.now() - msg.ts < 23 * 60 * 60 * 1000 : false
				if (msg.id && isLessThan23HoursOld) {
					previousResponseId = msg.id
					messages = _messages.slice(i + 1)
				}
				// Always break after the first assistant message we find, whether it has a usable ID or not.
				break
			}
		}
	}

	const allItems: any[] = []
	const toolUseIdToCallId = new Map<string, string>()

	for (const m of messages) {
		if (typeof m.content === "string") {
			allItems.push({ role: m.role, content: [{ type: "input_text", text: m.content }] })
			continue
		}
		if (m.role === "assistant") {
			allItems.push(...convertAssistantTurnItems(m.content as DiracContent[], toolUseIdToCallId))
		} else {
			allItems.push(...convertUserTurnItems(m.content as DiracContent[], m.role, toolUseIdToCallId, allItems))
		}
	}

	return { input: allItems, previousResponseId }
}

// Extracts the call_id (Responses API) or id (Anthropic) used to group assistant turn parts.
function getPartCallId(part: DiracContent): string | undefined {
	if ("call_id" in part && typeof part.call_id === "string") return part.call_id
	if ("id" in part && typeof part.id === "string") return part.id
	return undefined
}

// Processes an assistant turn: groups parts by call_id, sorts by hex ID, and ensures
// every reasoning item is immediately followed by a message or function_call (inserts
// placeholder messages where needed).
function convertAssistantTurnItems(content: DiracContent[], toolUseIdToCallId: Map<string, string>): any[] {
	const assistantTurnItems = new Map<string, any>()
	const itemOrder: string[] = []

	for (const _part of content) {
		const part = _part as DiracContent
		const call_id = getPartCallId(part)
		if (!call_id) continue
		if (!assistantTurnItems.has(call_id)) itemOrder.push(call_id)
		let item = assistantTurnItems.get(call_id)

		switch (part.type) {
			case "thinking": {
				const thinkingBlock = part as DiracAssistantThinkingBlock
				const hasThinkingContent = thinkingBlock.thinking && thinkingBlock.thinking.trim().length > 0
				const hasSummaryContent =
					thinkingBlock.summary && Array.isArray(thinkingBlock.summary) && thinkingBlock.summary.length > 0
				if (!item) {
					item = { type: "reasoning", summary: [] }
					assistantTurnItems.set(call_id, item)
				}
				if (hasSummaryContent) item.summary = thinkingBlock.summary
				else if (hasThinkingContent) item.summary = [{ type: "summary_text", text: thinkingBlock.thinking }]
				break
			}
			case "redacted_thinking": {
				const redactedBlock = part as DiracAssistantRedactedThinkingBlock
				if (!item) {
					item = { type: "reasoning", summary: [] }
					assistantTurnItems.set(call_id, item)
				}
				if (redactedBlock.data) item.encrypted_content = redactedBlock.data
				break
			}
			case "text":
				assistantTurnItems.set(call_id, {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: (part as DiracTextContentBlock).text || "" }],
				})
				break
			case "image": {
				const imageSource = (part as DiracImageContentBlock).source
				assistantTurnItems.set(call_id, {
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: `[image:${imageSource.type === "base64" ? imageSource.media_type : "url"}]`,
						},
					],
				})
				break
			}
			case "tool_use": {
				const toolUseBlock = part as DiracAssistantToolUseBlock
				const id = toolUseBlock.call_id || toolUseBlock.id
				if (toolUseBlock.call_id) toolUseIdToCallId.set(toolUseBlock.id, toolUseBlock.call_id)
				assistantTurnItems.set(id, {
					type: "function_call",
					call_id: id,
					name: toolUseBlock.name,
					arguments: JSON.stringify(toolUseBlock.input ?? {}),
				})
				break
			}
		}
	}

	// Sort by raw hex suffix to restore generation sequence
	const sortedIds = itemOrder.sort((a, b) => {
		const rawA = a.includes("_") ? a.split("_")[1] : a
		const rawB = b.includes("_") ? b.split("_")[1] : b
		return rawA.localeCompare(rawB)
	})

	// Ensure strict pairing: every reasoning must be followed by a message or function_call
	const finalized: any[] = []
	for (let i = 0; i < sortedIds.length; i++) {
		const item = assistantTurnItems.get(sortedIds[i])
		finalized.push(item)
		if (item.type === "reasoning") {
			const nextItem = sortedIds[i + 1] ? assistantTurnItems.get(sortedIds[i + 1]) : null
			if (!nextItem || nextItem.type === "reasoning") {
				finalized.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] })
			}
		}
	}
	return finalized
}

// Processes a user turn: collects text/image content into messages, and tool_result
// parts into function_call_output items (flushing pending content first).
function convertUserTurnItems(
	content: DiracContent[],
	role: string,
	toolUseIdToCallId: Map<string, string>,
	allItems: any[],
): any[] {
	const newItems: any[] = []
	const messageContent: ResponseInputMessageContentList = []

	for (const _part of content) {
		const part = _part as DiracContent
		switch (part.type) {
			case "text":
				messageContent.push({ type: "input_text", text: (part as DiracTextContentBlock).text || "" })
				break
			case "image": {
				const imageBlock = part as DiracImageContentBlock
				messageContent.push({
					type: "input_image",
					detail: "auto",
					image_url:
						imageBlock.source.type === "base64"
							? `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`
							: imageBlock.source.url,
				})
				break
			}
			case "tool_result": {
				const toolResultBlock = part as DiracUserToolResultContentBlock
				if (messageContent.length > 0) {
					newItems.push({ role, content: [...messageContent] })
					messageContent.length = 0
				}
				const call_id =
					toolResultBlock.call_id || toolUseIdToCallId.get(toolResultBlock.tool_use_id) || toolResultBlock.tool_use_id
				newItems.push({
					type: "function_call_output",
					call_id,
					output:
						typeof toolResultBlock.content === "string"
							? toolResultBlock.content
							: JSON.stringify(toolResultBlock.content),
				})
				break
			}
		}
	}
	if (messageContent.length > 0) newItems.push({ role, content: [...messageContent] })
	return newItems
}
