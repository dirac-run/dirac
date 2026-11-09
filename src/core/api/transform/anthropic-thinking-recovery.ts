import type { Anthropic } from "@anthropic-ai/sdk"

function thinkingIdentity(block: Anthropic.ContentBlockParam): string | undefined {
	if (block.type === "thinking") return `signature:${block.signature}`
	if (block.type === "redacted_thinking") return `redacted:${block.data}`
	return undefined
}

/**
 * Per-handler repair for Claude's conversation-prefix rejection, not signature corruption.
 * Callers own the single retry and must not recover after emitting response output.
 * Only outgoing provider messages change; saved conversation history remains intact.
 */
export class AnthropicThinkingRecovery {
	private readonly rejectedThinking = new Set<string>()

	prepareAnthropicMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
		return messages.flatMap((message) => {
			if (message.role !== "assistant" || typeof message.content === "string") return [message]

			const content = message.content.filter((block) => {
				const identity = thinkingIdentity(block)
				return identity === undefined || !this.rejectedThinking.has(identity)
			})
			if (content.length === message.content.length) return [message]
			if (content.length === 0) return []
			return [{ ...message, content }]
		})
	}

	recoverAnthropicMessages(error: unknown, messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
		if (!(error instanceof Error)) throw error
		const path = error.message.match(
			/messages\.(\d+)\.content\.(\d+): Invalid `signature` in `thinking` block\. The block is bound to a different conversation\./,
		)
		if (!path) throw error

		const messageIndex = Number(path[1])
		const blockIndex = Number(path[2])
		const message = messages[messageIndex]
		if (!message || message.role !== "assistant" || typeof message.content === "string") throw error
		const block = message.content[blockIndex]
		if (!block || thinkingIdentity(block) === undefined) throw error

		// Ban the complete existing suffix once. Fresh reasoning produced by the
		// repaired request is bound to its new prefix and must remain replayable.
		for (let index = messageIndex; index < messages.length; index++) {
			const laterMessage = messages[index]!
			if (laterMessage.role !== "assistant" || typeof laterMessage.content === "string") continue
			for (const laterBlock of laterMessage.content.slice(index === messageIndex ? blockIndex : 0)) {
				const identity = thinkingIdentity(laterBlock)
				if (identity !== undefined) this.rejectedThinking.add(identity)
			}
		}
		return this.prepareAnthropicMessages(messages)
	}
}
