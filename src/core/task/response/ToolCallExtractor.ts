import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskState } from "../TaskState"
import { ParsedToolUseState } from "../StreamResponseHandler"

// Extracts tool calls from streaming response chunks — processes tool_use deltas
// and maintains the call_id → function_id mapping for tool result correlation.
export class ToolCallExtractor {
	constructor(private streamHandler: StreamResponseHandler, private taskState: TaskState) {}

	// Process a tool_calls chunk: parse the delta and map call_id to function id
	processToolCallChunk(chunk: { tool_call: { function?: { id?: string; name?: string; arguments?: string }; call_id?: string }; signature?: string }): void {
		this.streamHandler.processToolUseDelta(
			{ id: chunk.tool_call.function?.id, type: "tool_use", name: chunk.tool_call.function?.name, input: chunk.tool_call.function?.arguments, signature: chunk?.signature },
			chunk.tool_call.call_id,
		)
		if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
			this.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
		}
	}

	getParsedToolUseStates(isComplete = false): ParsedToolUseState[] {
		return this.streamHandler.getParsedToolUseStates(isComplete)
	}
}
