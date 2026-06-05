import { Anthropic } from "@anthropic-ai/sdk"
import { DiracMessageMetricsInfo, DiracMessageModelInfo } from "./metrics"

export type DiracPromptInputContent = string

export type DiracMessageRole = "user" | "assistant"

export interface DiracReasoningDetailParam {
	type: "reasoning.text" | string
	text: string
	signature: string
	format: "anthropic-claude-v1" | string
	index: number
}

interface DiracSharedMessageParam {
	// The id of the response that the block belongs to
	call_id?: string
}

export const REASONING_DETAILS_PROVIDERS = ["dirac", "openrouter"]

/**
 * An extension of Anthropic.MessageParam that includes Dirac-specific fields: reasoning_details.
 * This ensures backward compatibility where the messages were stored in Anthropic format with additional
 * fields unknown to Anthropic SDK.
 */
export interface DiracTextContentBlock extends Anthropic.TextBlockParam, DiracSharedMessageParam {
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: DiracReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface DiracImageContentBlock extends Anthropic.ImageBlockParam, DiracSharedMessageParam {}

export interface DiracDocumentContentBlock extends Anthropic.DocumentBlockParam, DiracSharedMessageParam {}

export interface DiracUserToolResultContentBlock extends Anthropic.ToolResultBlockParam, DiracSharedMessageParam {}

/**
 * Assistant only content types
 */
export interface DiracAssistantToolUseBlock extends Anthropic.ToolUseBlockParam, DiracSharedMessageParam {
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: unknown[] | DiracReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface DiracAssistantThinkingBlock extends Anthropic.ThinkingBlock, DiracSharedMessageParam {
	// The summary items returned by OpenAI response API
	// The reasoning details that will be moved to the text block when finalized
	summary?: unknown[] | DiracReasoningDetailParam[]
}

export interface DiracAssistantRedactedThinkingBlock extends Anthropic.RedactedThinkingBlockParam, DiracSharedMessageParam {}

export type DiracToolResponseContent = DiracPromptInputContent | Array<DiracTextContentBlock | DiracImageContentBlock>

export type DiracUserContent =
	| DiracTextContentBlock
	| DiracImageContentBlock
	| DiracDocumentContentBlock
	| DiracUserToolResultContentBlock

export type DiracAssistantContent =
	| DiracTextContentBlock
	| DiracImageContentBlock
	| DiracDocumentContentBlock
	| DiracAssistantToolUseBlock
	| DiracAssistantThinkingBlock
	| DiracAssistantRedactedThinkingBlock

export type DiracContent = DiracUserContent | DiracAssistantContent | Anthropic.ContentBlockParam

/**
 * An extension of Anthropic.MessageParam that includes Dirac-specific fields.
 * This ensures backward compatibility where the messages were stored in Anthropic format,
 * while allowing for additional metadata specific to Dirac to avoid unknown fields in Anthropic SDK
 * added by ignoring the type checking for those fields.
 */
export interface DiracStorageMessage extends Anthropic.MessageParam {
	/**
	 * Response ID associated with this message
	 */
	id?: string
	role: DiracMessageRole
	content: DiracPromptInputContent | DiracContent[]
	/**
	 * NOTE: model information used when generating this message.
	 * Internal use for message conversion only.
	 * MUST be removed before sending message to any LLM provider.
	 */
	modelInfo?: DiracMessageModelInfo
	/**
	 * LLM operational and performance metrics for this message
	 * Includes token counts, costs.
	 */
	metrics?: DiracMessageMetricsInfo
	/**
	 * Timestamp of when the message was created
	 */
	ts?: number
}

/**
 * Converts DiracStorageMessage to Anthropic.MessageParam by removing Dirac-specific fields
 * Dirac-specific fields (like modelInfo, reasoning_details) are properly omitted.
 */
export function convertDiracStorageToAnthropicMessage(
	diracMessage: DiracStorageMessage,
	provider = "anthropic",
): Anthropic.MessageParam {
	const { role, content } = diracMessage

	// Handle string content - fast path
	if (typeof content === "string") {
		return { role, content }
	}

	// Removes thinking block that has no signature (invalid thinking block that's incompatible with Anthropic API)
	const filteredContent = content.filter((b) => b.type !== "thinking" || !!b.signature)

	// Handle array content - strip Dirac-specific fields for non-reasoning_details providers
	const shouldCleanContent = !REASONING_DETAILS_PROVIDERS.includes(provider)
	const cleanedContent = shouldCleanContent
		? filteredContent.map(cleanContentBlock)
		: (filteredContent as Anthropic.MessageParam["content"])

	return { role, content: cleanedContent }
}

/**
 * Clean a content block by removing Dirac-specific fields and returning only Anthropic-compatible fields
 */
export function cleanContentBlock(block: DiracContent): Anthropic.ContentBlock {
	// Fast path: if no Dirac-specific fields exist, return as-is
	const hasDiracFields =
		"reasoning_details" in block ||
		"call_id" in block ||
		"summary" in block ||
		"isComplete" in block ||
		"isNativeToolCall" in block ||
		(block.type !== "thinking" && "signature" in block)

	if (!hasDiracFields) {
		return block as Anthropic.ContentBlock
	}

	// Removes Dirac-specific fields & the signature field that's added for Gemini.
	const { reasoning_details, call_id, summary, isComplete, isNativeToolCall, ...rest } = block as any

	// Remove signature from non-thinking blocks that were added for Gemini
	if (block.type !== "thinking" && rest.signature) {
		rest.signature = undefined
	}

	return rest satisfies Anthropic.ContentBlock
}
