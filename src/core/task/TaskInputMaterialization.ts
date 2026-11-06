import type { DiracStorageMessage, DiracTextContentBlock } from "@shared/messages/content"
import type { ApiConversationProviderState } from "@core/api/conversation"

type InputIdentityField = "steeringMessageIds" | "taskletEventIds"
interface InputMessageState {
	getApiConversationHistory(): DiracStorageMessage[]
	getApiConversationProviderState(): ApiConversationProviderState
	addToApiConversationHistory(message: DiracStorageMessage): Promise<void>
	appendToLastApiConversationUserMessage(content: DiracTextContentBlock): Promise<DiracStorageMessage>
	flushPendingWrites(): Promise<void>
}

function messageInputIds(message: DiracStorageMessage, identityField: InputIdentityField): string[] {
	if (typeof message.content === "string") return []
	return message.content.flatMap((block) =>
		block.type === "text" ? ((block as DiracTextContentBlock)[identityField] ?? []) : [],
	)
}

/**
 * Materialize identified text at the serial provider-dispatch boundary using the existing
 * conversation writes. Each incoming block represents one independently identified input.
 * A receipt records durable inclusion, not model understanding or execution.
 */
export async function materializeModelBoundInput(
	messageState: InputMessageState,
	outboundHistory: DiracStorageMessage[],
	content: readonly DiracTextContentBlock[],
	identityField: InputIdentityField,
	acknowledge: () => Promise<void>,
): Promise<void> {
	const outboundUserMessage = outboundHistory.at(-1)
	if (!outboundUserMessage || outboundUserMessage.role !== "user") {
		throw new Error("Cannot materialize model input without a final user message")
	}

	const history = messageState.getApiConversationHistory()
	const checkpoint = messageState.getApiConversationProviderState().checkpoint
	const recordedIds = new Set(history.flatMap((message) => messageInputIds(message, identityField)))
	const newContent = content.filter((block) => {
		const ids = block[identityField]!
		if (ids.every((id) => recordedIds.has(id))) return false
		for (const id of ids) recordedIds.add(id)
		return true
	})

	if (newContent.length && checkpoint && checkpoint.compactedThroughHistoryIndex >= history.length - 1) {
		// An opaque checkpoint cannot see edits to its covered historical user turn.
		await messageState.addToApiConversationHistory({ role: "user", content: newContent })
	} else {
		// Keep tool results in their original turn, paired with the preceding tool calls.
		for (const block of newContent) await messageState.appendToLastApiConversationUserMessage(block)
	}

	const recordedIndices = new Map<string, number>()
	for (const [index, message] of history.entries()) {
		for (const id of messageInputIds(message, identityField)) recordedIndices.set(id, index)
	}
	const outboundIds = new Set(outboundHistory.flatMap((message) => messageInputIds(message, identityField)))
	const missingContent = content.filter((block) => {
		const ids = block[identityField]!
		if (ids.every((id) => outboundIds.has(id))) return false
		// Receipt-only retries must not replay content already incorporated in the checkpoint.
		if (checkpoint && ids.every((id) => recordedIndices.get(id)! <= checkpoint.compactedThroughHistoryIndex)) return false
		for (const id of ids) outboundIds.add(id)
		return true
	})
	if (missingContent.length && checkpoint) {
		// Copied projections may still end at a covered turn (including after a failed write).
		// Never edit that snapshot; provider checkpoint dispatch uses the authoritative suffix.
		outboundHistory.push({ role: "user", content: missingContent })
	} else if (missingContent.length) {
		if (typeof outboundUserMessage.content === "string") {
			outboundUserMessage.content = [{ type: "text", text: outboundUserMessage.content }, ...missingContent]
		} else {
			outboundUserMessage.content.push(...missingContent)
		}
	}

	// Writes can fail after staging content. The next attempt reuses its recorded identity,
	// flushes the existing write buffer, and retries the receipt without appending again.
	await messageState.flushPendingWrites()
	await acknowledge()
}
