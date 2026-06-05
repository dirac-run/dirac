import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "@core/api"
import { DiracMessage } from "@shared/ExtensionMessage"
import cloneDeep from "clone-deep"
import { Logger } from "@/shared/services/Logger"
import { getContextWindowInfo } from "./context-window-utils"


export class ContextManager {
	// mapping from the apiMessages outer index to the inner message index to a list of actual changes, ordered by timestamp
	// timestamp is required in order to support full checkpointing, where the changes we apply need to be able to be undone when
	// moving to an earlier conversation history checkpoint - this ordering intuitively allows for binary search on truncation
	// there is also a number stored for each (EditType) which defines which message type it is, for custom handling


	constructor() {}

	/**
	 * Extracts text from a content block, handling both regular text blocks and tool_result wrappers.
	 * For tool_result blocks, extracts text from content[0] (native tool calling format).
	 * @returns The text content, or null if no text could be extracted
	 */
	private getTextFromBlock(block: Anthropic.Messages.ContentBlockParam): string | null {
		if (block.type === "text") {
			return block.text
		}
		if (block.type === "tool_result" && Array.isArray(block.content)) {
			const inner = block.content[0]
			if (inner && "type" in inner && inner.type === "text") {
				return inner.text
			}
		}
		return null
	}

	/**
	 * Sets text in a content block, handling both regular text blocks and tool_result wrappers.
	 * For tool_result blocks, sets text in content[0] (native tool calling format).
	 * @returns true if text was set successfully, false otherwise
	 */
	private setTextInBlock(block: Anthropic.Messages.ContentBlockParam, text: string): boolean {
		if (block.type === "text") {
			block.text = text
			return true
		}
		if (block.type === "tool_result" && Array.isArray(block.content)) {
			const inner = block.content[0]
			if (inner && "type" in inner && inner.type === "text") {
				inner.text = text
				return true
			}
		}
		return false
	}


	/**
	 * Determine whether we should compact context window, based on token counts
	 */
	shouldCompactContextWindow(
		diracMessages: DiracMessage[],
		api: ApiHandler,
		previousApiReqIndex: number,
		thresholdPercentage?: number,
	): boolean {
		if (previousApiReqIndex >= 0) {
			const previousRequest = diracMessages[previousApiReqIndex]
			const previousRequestStatus = previousRequest?.content.type === "api_status" ? previousRequest.content.status : undefined
			if (previousRequestStatus) {
				try {
					const { tokensIn, tokensOut, cacheWrites, cacheReads } = previousRequestStatus || {}
					const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)

					const { contextWindow, maxAllowedSize } = getContextWindowInfo(api)
					const roundedThreshold = thresholdPercentage
						? Math.floor(contextWindow * thresholdPercentage)
						: maxAllowedSize
					const thresholdTokens = Math.min(roundedThreshold, maxAllowedSize)
					return totalTokens >= thresholdTokens
				} catch {
					return false
				}
			}
		}
		return false
	}

	/**
	 * Get telemetry data for context management decisions
	 * Returns the token counts and context window info that drove summarization
	 */
	getContextTelemetryData(
		diracMessages: DiracMessage[],
		api: ApiHandler,
		triggerIndex?: number,
	): {
		tokensUsed: number
		maxContextWindow: number
	} | null {
		// Use provided triggerIndex or fallback to automatic detection
		let targetIndex: number
		if (triggerIndex !== undefined) {
			targetIndex = triggerIndex
		} else {
			// Find all API request indices
			const apiReqIndices = diracMessages
				.map((msg, index) => (msg.content.type === "api_status" ? index : -1))
				.filter((index) => index !== -1)

			// We want the second-to-last API request (the one that caused summarization)
			targetIndex = apiReqIndices.length >= 2 ? apiReqIndices[apiReqIndices.length - 2] : -1
		}

		if (targetIndex >= 0) {
			const targetRequest = diracMessages[targetIndex]
			const targetRequestStatus = targetRequest?.content.type === "api_status" ? targetRequest.content.status : undefined
			if (targetRequestStatus) {
				try {
					const { tokensIn, tokensOut, cacheWrites, cacheReads } = targetRequestStatus || {}
					const tokensUsed = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)

					const { contextWindow } = getContextWindowInfo(api)

					return {
						tokensUsed,
						maxContextWindow: contextWindow,
					}
				} catch (error) {
					Logger.error("Error parsing API request info for context telemetry:", error)
				}
			}
		}
		return null
	}

	/**
	 * primary entry point for getting up to date context
	 */
	async getNewContextMessagesAndMetadata(
		apiConversationHistory: Anthropic.Messages.MessageParam[],
		diracMessages: DiracMessage[],
		api: ApiHandler,
		conversationHistoryDeletedRange: [number, number] | undefined,
		previousApiReqIndex: number,
		taskDirectory: string,
		useAutoCondense: boolean, // option to use new auto-condense or old programmatic context management
	) {
		let updatedConversationHistoryDeletedRange = false

		if (!useAutoCondense) {
			// If the previous API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
			if (previousApiReqIndex >= 0) {
				const previousRequest = diracMessages[previousApiReqIndex]
				const previousRequestStatus = previousRequest?.content.type === "api_status" ? previousRequest.content.status : undefined
				if (previousRequestStatus) {
					const { tokensIn, tokensOut, cacheWrites, cacheReads } = previousRequestStatus || {}
					const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
					const { maxAllowedSize } = getContextWindowInfo(api)

					// This is the most reliable way to know when we're close to hitting the context window.
					if (totalTokens >= maxAllowedSize) {
						// Since the user may switch between models with different context windows, truncating half may not be enough (ie if switching from claude 200k to deepseek 64k, half truncation will only remove 100k tokens, but we need to remove much more)
						// So if totalTokens/2 is greater than maxAllowedSize, we truncate 3/4 instead of 1/2
						const keep = totalTokens / 2 > maxAllowedSize ? "quarter" : "half"

						// NOTE: it's okay that we overwriteConversationHistory in resume task since we're only ever removing the last user message and not anything in the middle which would affect this range
						conversationHistoryDeletedRange = this.getNextTruncationRange(
							apiConversationHistory,
							conversationHistoryDeletedRange,
							keep,
						)

						updatedConversationHistoryDeletedRange = true
					}
				}
			}
		}

		const truncatedConversationHistory = this.getAndAlterTruncatedMessages(
			apiConversationHistory,
			conversationHistoryDeletedRange,
		)

		return {
			conversationHistoryDeletedRange: conversationHistoryDeletedRange,
			updatedConversationHistoryDeletedRange: updatedConversationHistoryDeletedRange,
			truncatedConversationHistory: truncatedConversationHistory,
		}
	}

	/**
	 * get truncation range
	 */
	public getNextTruncationRange(
		apiMessages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "none" | "lastTwo" | "half" | "quarter",
	): [number, number] {
		// We always keep the first user-assistant pairing, and truncate an even number of messages from there
		const rangeStartIndex = 2 // index 0 and 1 are kept
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 2 // inclusive starting index

		let messagesToRemove: number
		if (keep === "none") {
			// Removes all messages beyond the first core user/assistant message pair
			messagesToRemove = Math.max(apiMessages.length - startOfRest, 0)
		} else if (keep === "lastTwo") {
			// Keep the last user-assistant pair in addition to the first core user/assistant message pair
			messagesToRemove = Math.max(apiMessages.length - startOfRest - 2, 0)
		} else if (keep === "half") {
			// Remove half of remaining user-assistant pairs
			// We first calculate half of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor((apiMessages.length - startOfRest) / 4) * 2 // Keep even number
		} else {
			// Remove 3/4 of remaining user-assistant pairs
			// We calculate 3/4ths of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor(((apiMessages.length - startOfRest) * 3) / 4 / 2) * 2
		}

		let rangeEndIndex = startOfRest + messagesToRemove - 1 // inclusive ending index

		// Make sure that the last message being removed is a assistant message, so the next message after the initial user-assistant pair is an assistant message. This preserves the user-assistant-user-assistant structure.
		// NOTE: anthropic format messages are always user-assistant-user-assistant, while openai format messages can have multiple user messages in a row (we use anthropic format throughout dirac)
		if (apiMessages[rangeEndIndex] && apiMessages[rangeEndIndex].role !== "assistant") {
			rangeEndIndex -= 1
		}

		// this is an inclusive range that will be removed from the conversation history
		return [rangeStartIndex, rangeEndIndex]
	}

	/**
	 * external interface to support old calls
	 */
	public getTruncatedMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		return this.getAndAlterTruncatedMessages(messages, deletedRange)
	}

	/**
	 * apply all required truncation methods to the messages in context
	 */
	private getAndAlterTruncatedMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		if (messages.length <= 1) {
			return messages
		}

		const updatedMessages = this.applyContextHistoryUpdates(messages, deletedRange ? deletedRange[1] + 1 : 2)

		// Validate and fix tool_use/tool_result pairing
		this.ensureToolResultsFollowToolUse(updatedMessages)

		return updatedMessages
	}
	private applyContextHistoryUpdates(
		messages: Anthropic.Messages.MessageParam[],
		startFromIndex: number,
	): Anthropic.Messages.MessageParam[] {
		const firstChunk = messages.slice(0, 2) // get first user-assistant pair
		const secondChunk = messages.slice(startFromIndex) // get remaining messages within context
		const messagesToUpdate = [...firstChunk, ...secondChunk]

		// Remove orphaned tool_results from the first message after truncation (if it's a user message)
		if (startFromIndex > 2 && messagesToUpdate.length > 2) {
			const firstMessageAfterTruncation = messagesToUpdate[2]
			if (firstMessageAfterTruncation.role === "user" && Array.isArray(firstMessageAfterTruncation.content)) {
				const hasToolResults = firstMessageAfterTruncation.content.some((block) => block.type === "tool_result")
				if (hasToolResults) {
					// Clone and filter out all tool_result blocks
					messagesToUpdate[2] = cloneDeep(firstMessageAfterTruncation)
					;(messagesToUpdate[2].content as Anthropic.Messages.ContentBlockParam[]) = (
						firstMessageAfterTruncation.content as Anthropic.Messages.ContentBlockParam[]
					).filter((block) => block.type !== "tool_result")
				}
			}
		}

		return messagesToUpdate
	}

	/**
	 * Ensures that every tool_use block in assistant messages has a corresponding tool_result in the next user message,
	 * and that tool_result blocks immediately follow their corresponding tool_use blocks
	 */
	private ensureToolResultsFollowToolUse(messages: Anthropic.Messages.MessageParam[]): void {
		// 1. Ensure first message (if user) doesn't have tool_results
		const firstMessage = messages[0]
		if (firstMessage && firstMessage.role === "user" && Array.isArray(firstMessage.content)) {
			const hasToolResults = firstMessage.content.some((block) => block.type === "tool_result")
			if (hasToolResults) {
				const clonedMessage = cloneDeep(firstMessage)
				clonedMessage.content = (firstMessage.content as Anthropic.Messages.ContentBlockParam[]).filter(
					(block) => block.type !== "tool_result",
				)
				messages[0] = clonedMessage
			}
		}

		for (let i = 0; i < messages.length - 1; i++) {
			const message = messages[i]

			// Only process assistant messages with content
			if (message.role !== "assistant" || !Array.isArray(message.content)) {
				continue
			}

			// Extract tool_use IDs in order
			const toolUseIds: string[] = []
			for (const block of message.content) {
				if (block.type === "tool_use" && block.id) {
					toolUseIds.push(block.id)
				}
			}

			const nextMessage = messages[i + 1]

			// Skip if next message is not a user message
			if (nextMessage.role !== "user") {
				continue
			}

			// Ensure content is an array
			if (!Array.isArray(nextMessage.content)) {
				nextMessage.content = []
			}

			// Separate tool_results from other blocks in a single pass
			const toolResultMap = new Map<string, Anthropic.Messages.ToolResultBlockParam>()
			const otherBlocks: Anthropic.Messages.ContentBlockParam[] = []
			let needsUpdate = false

			for (const block of nextMessage.content) {
				if (block.type === "tool_result" && block.tool_use_id) {
					toolResultMap.set(block.tool_use_id, block)
				} else {
					otherBlocks.push(block)
				}
			}

			// Check if reordering is needed (tool_results not at start in correct order)
			if (toolResultMap.size > 0) {
				let expectedIndex = 0
				for (let j = 0; j < nextMessage.content.length && expectedIndex < toolUseIds.length; j++) {
					const block = nextMessage.content[j]
					if (block.type === "tool_result" && block.tool_use_id === toolUseIds[expectedIndex]) {
						expectedIndex++
					} else if (block.type === "tool_result" || expectedIndex < toolUseIds.length) {
						needsUpdate = true
						break
					}
				}
				if (!needsUpdate && (expectedIndex < toolResultMap.size || expectedIndex < toolUseIds.length)) {
					needsUpdate = true
				}
			} else if (toolUseIds.length > 0) {
				needsUpdate = true
			}

			// Add missing tool_results
			for (const toolUseId of toolUseIds) {
				if (!toolResultMap.has(toolUseId)) {
					toolResultMap.set(toolUseId, {
						type: "tool_result",
						tool_use_id: toolUseId,
						content: "result missing",
					})
					needsUpdate = true
				}
			}

			// Only modify if changes are needed
			if (!needsUpdate) {
				continue
			}

			// Build new content: tool_results first (in toolUseIds order), then other blocks
			const newContent: Anthropic.Messages.ContentBlockParam[] = []

			// Add tool_results in the order of toolUseIds
			const processedToolResults = new Set<string>()
			for (const toolUseId of toolUseIds) {
				const toolResult = toolResultMap.get(toolUseId)
				if (toolResult) {
					newContent.push(toolResult)
					processedToolResults.add(toolUseId)
				}
			}

			// Add all other blocks
			newContent.push(...otherBlocks)

			// Clone and update the message
			const clonedMessage = cloneDeep(nextMessage)
			clonedMessage.content = newContent
			messages[i + 1] = clonedMessage
		}
	}
}
