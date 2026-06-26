import { Logger } from "@/shared/services/Logger"

import type { ChatCompletionToolChoiceOption, ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import type { ApiStreamToolCallsChunk } from "./stream"

// Generalized tool call delta that accepts null for id/index (Cerebras SDK returns null)
interface ToolCallDelta {
	index?: number | null
	id?: string | null
	function?: { name?: string | null; arguments?: string | null }
	type?: string
	web_search?: { query?: string }
}

/**
 * Helper class to process tool call deltas from OpenAI-compatible streaming responses.
 * Handles accumulating tool call ID and name across multiple delta chunks,
 * and yields properly formatted tool call chunks when arguments are received.
 */
export class ToolCallProcessor {
	private toolCallStateByIndex: Map<number, { id: string; name: string }>

	constructor() {
		this.toolCallStateByIndex = new Map()
	}

	/**
	 * Process tool call deltas from a chunk and yield formatted tool call chunks.
	 * @param toolCallDeltas - Array of tool call deltas from the chunk
	 * @yields Formatted tool call chunks ready to be yielded in the API stream
	 */
	*processToolCallDeltas(toolCallDeltas: ToolCallDelta[] | undefined): Generator<ApiStreamToolCallsChunk> {
		if (!toolCallDeltas) {
			return
		}

		for (const [fallbackIndex, toolCallDelta] of toolCallDeltas.entries()) {
			// OpenAI-style streams include an index per tool call. Use iteration order as a fallback.
			const toolCallIndex = toolCallDelta.index ?? fallbackIndex
			const toolCallState = this.getOrCreateToolCallState(toolCallIndex)

			// Accumulate the tool call ID if present
			if (toolCallDelta.id) {
				toolCallState.id = toolCallDelta.id
			}

			// Accumulate web_search type
			if (toolCallDelta.type === "web_search") {
				toolCallState.name = "web_search"
			}

			// Accumulate the function name if present
			if (toolCallDelta.function?.name) {
				toolCallState.name = toolCallDelta.function.name
				Logger.debug(`ToolCallProcessor: received function name "${toolCallDelta.function.name}"`)
			}

			// Only yield when we have all required fields: id, name, and arguments (or web_search query)
			const hasFunctionArgs = toolCallDelta.function?.arguments !== undefined
			const hasWebSearchQuery = toolCallDelta.web_search?.query !== undefined

			if (toolCallState.id && toolCallState.name && (hasFunctionArgs || hasWebSearchQuery)) {
				yield {
					type: "tool_calls",
					tool_call:
						toolCallState.name === "web_search"
							? {
								call_id: toolCallState.id,
								type: "web_search",
								web_search: toolCallDelta.web_search || { query: "" },
								function: {
									id: toolCallState.id,
									name: "web_search",
									arguments: toolCallDelta.web_search?.query || "",
								},
							}
							: {
								...toolCallDelta,
								call_id: toolCallState.id,
								function: {
									...toolCallDelta.function,
									id: toolCallState.id,
									name: toolCallState.name,
								},
							},
				}
			}
		}
	}

	private getOrCreateToolCallState(index: number): { id: string; name: string } {
		const existingState = this.toolCallStateByIndex.get(index)
		if (existingState) {
			return existingState
		}

		const initialState = { id: "", name: "" }
		this.toolCallStateByIndex.set(index, initialState)
		return initialState
	}

	/**
	 * Reset the internal state. Call this when starting a new message.
	 */
	reset(): void {
		this.toolCallStateByIndex.clear()
	}

	/**
	 * Get the current accumulated tool call state (useful for debugging).
	 */
	getState(): Record<number, { id: string; name: string }> {
		return Object.fromEntries(this.toolCallStateByIndex.entries())
	}
}

// ChatCompletionTool doesn't include web_search; define the shape we use
interface WebSearchChatTool {
	type: "web_search"
	search_context_size?: string
	filters?: object
	user_location?: object
	external_web_access?: boolean
}

// Type guard for web_search tools that may be mixed into a ChatCompletionTool array
function isWebSearchTool(tool: OpenAITool | WebSearchChatTool): tool is WebSearchChatTool {
	return tool.type === "web_search"
}

export function getOpenAIToolParams(tools?: OpenAITool[], enableParallelToolCalls = false) {
	if (!tools?.length) {
		return {
			tools: undefined,
		}
	}

	const mappedTools = (tools as (OpenAITool | WebSearchChatTool)[]).map((tool) => {
		if (tool.type === "function") {
			return tool
		}
		if (isWebSearchTool(tool)) {
			return {
				type: "web_search" as const,
				...(tool.search_context_size ? { search_context_size: tool.search_context_size } : {}),
				...(tool.filters ? { filters: tool.filters } : {}),
				...(tool.user_location ? { user_location: tool.user_location } : {}),
				...(tool.external_web_access !== undefined ? { external_web_access: tool.external_web_access } : {}),
			}
		}
		return tool
	})

	return {
		tools: mappedTools as OpenAITool[],
		tool_choice: "auto" as ChatCompletionToolChoiceOption,
		parallel_tool_calls: enableParallelToolCalls,
	}
}
