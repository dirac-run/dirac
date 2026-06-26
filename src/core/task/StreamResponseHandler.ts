import { nanoid } from "nanoid"
import { DiracAssistantContent } from "@/shared/messages/content"
import { ReasoningHandler } from "./stream/ReasoningHandler"
import { ToolUseHandler } from "./stream/ToolUseHandler"
import type { ReasoningDelta, ToolUseDeltaBlock } from "./stream/types"

// Re-export types for backward compatibility
export type { ParsedToolUseState, PendingReasoning, PendingToolUse, ReasoningDelta, ToolUseDeltaBlock } from "./stream/types"

// Parses streaming API response chunks into ordered DiracAssistantContent blocks.
// Delegates tool use parsing to ToolUseHandler and reasoning parsing to ReasoningHandler.
export class StreamResponseHandler {
	private lastActiveId: string | undefined
	private toolUseHandler = new ToolUseHandler()
	private reasoningHandler = new ReasoningHandler()
	private blockSequence: string[] = []
	private textBlocks = new Map<string, { text: string; signature?: string }>()
	private _requestId: string | undefined

	public setRequestId(id?: string) {
		if (!this._requestId && id) this._requestId = id
	}

	public get requestId() {
		return this._requestId
	}

	public getParsedToolUseStates(isComplete = false) {
		return this.toolUseHandler.getParsedToolUseStates(isComplete)
	}

	public getHandlers() {
		return { toolUseHandler: this.toolUseHandler, reasonsHandler: this.reasoningHandler }
	}

	// Tracks block ordering and marks previous active block as complete when a new id arrives.
	private recordId(id: string) {
		if (!this.blockSequence.includes(id)) {
			if (this.lastActiveId && this.lastActiveId !== id) {
				this.toolUseHandler.markAsComplete(this.lastActiveId)
				this.reasoningHandler.markAsComplete(this.lastActiveId)
			}
			this.lastActiveId = id
			this.blockSequence.push(id)
		}
	}

	public processTextDelta(delta: { id?: string; text?: string; signature?: string }) {
		let id = delta.id
		if (!id) id = this.lastActiveId && this.textBlocks.has(this.lastActiveId) ? this.lastActiveId : "text_" + nanoid(8)
		this.recordId(id)
		let textData = this.textBlocks.get(id)
		if (!textData) {
			textData = { text: "" }
			this.textBlocks.set(id, textData)
		}
		if (delta.text) textData.text += delta.text
		if (delta.signature) textData.signature = delta.signature
	}

	public processReasoningDelta(delta: ReasoningDelta) {
		const id = delta.id || this.reasoningHandler.getLastReasoningId() || "default_reasoning"
		this.recordId(id)
		this.reasoningHandler.processReasoningDelta({ ...delta, id })
	}

	public processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string) {
		const id = delta.id || "default_tool_use"
		this.recordId(id)
		this.toolUseHandler.processToolUseDelta({ ...delta, id }, call_id)
	}

	// Returns blocks in the order they first appeared in the stream.
	public getOrderedBlocks(): DiracAssistantContent[] {
		const blocks: DiracAssistantContent[] = []
		for (const id of this.blockSequence) {
			if (this.reasoningHandler.hasReasoning(id)) {
				blocks.push(...this.reasoningHandler.getRedactedThinkingForId(id))
				const reasoningBlock = this.reasoningHandler.getReasoningBlock(id)
				if (reasoningBlock) blocks.push(reasoningBlock)
			} else if (this.toolUseHandler.hasToolUse(id)) {
				const toolUse = this.toolUseHandler.getFinalizedToolUse(id)
				if (toolUse) blocks.push(toolUse)
			} else if (this.textBlocks.has(id)) {
				const textData = this.textBlocks.get(id)!
				blocks.push({ type: "text", text: textData.text, signature: textData.signature, call_id: id })
			}
		}
		return blocks
	}

	public reset() {
		this._requestId = undefined
		this.toolUseHandler = new ToolUseHandler()
		this.reasoningHandler = new ReasoningHandler()
		this.blockSequence = []
		this.textBlocks.clear()
		this.lastActiveId = undefined
	}
}
