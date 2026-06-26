import { DiracAssistantRedactedThinkingBlock, DiracAssistantThinkingBlock } from "@/shared/messages/content"
import type { PendingReasoning, ReasoningDelta } from "./types"

// Handles streaming reasoning content and converts it to the appropriate message format.
export class ReasoningHandler {
	private pendingReasonings = new Map<string, PendingReasoning>()
	private lastReasoningId: string | undefined

	markAsComplete(id: string) {
		const pending = this.pendingReasonings.get(id)
		if (pending) pending.isComplete = true
	}

	hasReasoning(id: string): boolean {
		return this.pendingReasonings.has(id)
	}
	getLastReasoningId(): string | undefined {
		return this.lastReasoningId
	}

	getReasoningBlock(id: string): DiracAssistantThinkingBlock | null {
		const pending = this.pendingReasonings.get(id)
		return pending ? this.mapToThinkingBlock(pending) : null
	}

	getRedactedThinkingForId(id: string): DiracAssistantRedactedThinkingBlock[] {
		return this.pendingReasonings.get(id)?.redactedThinking || []
	}

	processReasoningDelta(delta: ReasoningDelta): void {
		const id = delta.id || this.lastReasoningId
		if (!id) return
		this.lastReasoningId = id
		let pending = this.pendingReasonings.get(id)
		if (!pending) {
			pending = { isComplete: false, id, content: "", signature: "", redactedThinking: [], summary: [] }
			this.pendingReasonings.set(id, pending)
		}
		if (delta.reasoning) pending.content += delta.reasoning
		if (delta.signature) pending.signature = delta.signature
		if (delta.details)
			Array.isArray(delta.details) ? pending.summary.push(...delta.details) : pending.summary.push(delta.details)
		if (delta.redacted_data)
			pending.redactedThinking.push({
				type: "redacted_thinking",
				data: delta.redacted_data,
				call_id: delta.id || pending.id,
			})
	}

	getCurrentReasoning(): DiracAssistantThinkingBlock | null {
		if (!this.lastReasoningId) return null
		const pending = this.pendingReasonings.get(this.lastReasoningId)
		return pending ? this.mapToThinkingBlock(pending) : null
	}

	getAllReasoningBlocks(): DiracAssistantThinkingBlock[] {
		const results: DiracAssistantThinkingBlock[] = []
		for (const pending of this.pendingReasonings.values()) {
			const block = this.mapToThinkingBlock(pending)
			if (block) results.push(block)
		}
		return results
	}

	getRedactedThinking(): DiracAssistantRedactedThinkingBlock[] {
		const results: DiracAssistantRedactedThinkingBlock[] = []
		for (const pending of this.pendingReasonings.values()) results.push(...pending.redactedThinking)
		return results
	}

	reset(): void {
		this.pendingReasonings.clear()
		this.lastReasoningId = undefined
	}

	private mapToThinkingBlock(pending: PendingReasoning): (DiracAssistantThinkingBlock & { isComplete: boolean }) | null {
		if (!pending.summary.length && !pending.content && pending.redactedThinking.length > 0) return null
		if (!pending.signature && pending.summary.length) {
			const lastSummary = pending.summary.at(-1)
			if (
				lastSummary &&
				typeof lastSummary === "object" &&
				"signature" in lastSummary &&
				typeof lastSummary.signature === "string"
			)
				pending.signature = lastSummary.signature
		}
		return {
			type: "thinking",
			thinking: pending.content,
			signature: pending.signature,
			summary: pending.summary,
			call_id: pending.id,
			isComplete: pending.isComplete,
		}
	}
}
