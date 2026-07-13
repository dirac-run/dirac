import { AssistantMessageContent, parseAssistantMessageV2, ReasoningStreamContent } from "@core/assistant-message"
import { DiracDefaultTool } from "@shared/tools"
import { ParsedToolUseState, StreamResponseHandler } from "../StreamResponseHandler"
import { TaskState } from "../TaskState"

// Synchronizes streaming state — converts ordered DiracAssistantContent blocks
// into AssistantMessageContent and updates taskState for presentation.
export class StreamStateSync {
	constructor(
		private streamHandler: StreamResponseHandler,
		private taskState: TaskState,
	) {}

	// Build AssistantMessageContent from ordered blocks and update taskState.
	// On completion, mark existing blocks complete without rebuilding —
	// rebuilding drops whitespace-only text blocks and shifts tool_use indices,
	// invalidating currentStreamingContentIndex in the presenter.
	syncStreamState(assistantTextOnly: string, toolBlocks: ParsedToolUseState[] = [], isStreamComplete = false): void {
		if (isStreamComplete) {
			this.taskState.assistantMessageContent = this.taskState.assistantMessageContent.map(block => ({ ...block, isComplete: true }))
			if (toolBlocks.length > 0) this.taskState.userMessageContentReady = false
			return
		}
		const prevLength = this.taskState.assistantMessageContent.length
		const orderedBlocks = this.streamHandler.getOrderedBlocks()
		const assistantMessageContent = this.buildContent(orderedBlocks, isStreamComplete)
		this.taskState.assistantMessageContent = assistantMessageContent
		if (assistantMessageContent.length > prevLength || toolBlocks.length > 0) {
			this.taskState.userMessageContentReady = false
		}
	}

	// Convert ordered blocks into AssistantMessageContent array
	private buildContent(orderedBlocks: any[], isStreamComplete: boolean): AssistantMessageContent[] {
		const content: AssistantMessageContent[] = []
		for (const block of orderedBlocks) content.push(...this.convertBlock(block, isStreamComplete))
		return content
	}

	// Convert a single ordered block into AssistantMessageContent entries
	private convertBlock(block: any, isStreamComplete: boolean): AssistantMessageContent[] {
		switch (block.type) {
			case "text":
				return this.convertTextBlock(block, isStreamComplete)
			case "tool_use":
				return [this.convertToolUseBlock(block, isStreamComplete)]
			case "thinking":
				return [this.convertThinkingBlock(block, isStreamComplete)]
			case "redacted_thinking":
				return [this.convertRedactedThinkingBlock(block, isStreamComplete)]
			default:
				return []
		}
	}

	private convertTextBlock(block: any, isStreamComplete: boolean): AssistantMessageContent[] {
		const parsed = parseAssistantMessageV2(block.text, !isStreamComplete)
		return parsed.map((p) => {
			if (p.type === "text")
				return {
					type: "text",
					content: p.content,
					isComplete: p.isComplete || isStreamComplete,
					signature: block.signature,
					call_id: block.call_id,
				}
			const r = p as ReasoningStreamContent
			return {
				type: "reasoning",
				reasoning: r.reasoning,
				isComplete: r.isComplete || isStreamComplete,
				signature: block.signature,
				call_id: block.call_id,
			}
		}) as AssistantMessageContent[]
	}

	private convertToolUseBlock(block: any, isStreamComplete: boolean): AssistantMessageContent {
		return {
			type: "tool_use",
			name: block.name as DiracDefaultTool,
			params: block.input,
			signature: block.signature,
			isNativeToolCall: true,
			call_id: block.call_id,
			id: block.id,
			isComplete: isStreamComplete || block.isComplete,
		}
	}

	private convertThinkingBlock(block: any, isStreamComplete: boolean): AssistantMessageContent {
		return {
			type: "reasoning",
			reasoning: block.thinking,
			signature: block.signature,
			isComplete: isStreamComplete || block.isComplete,
			call_id: block.call_id,
		}
	}

	private convertRedactedThinkingBlock(block: any, isStreamComplete: boolean): AssistantMessageContent {
		return {
			type: "reasoning",
			reasoning: "",
			redacted: true,
			data: block.data,
			isComplete: isStreamComplete,
			call_id: block.call_id,
		}
	}
}
