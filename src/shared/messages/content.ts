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
	// Transient provenance marker. Only text typed by the user may enter mention/slash-command parsing.
	// ContextLoader removes this field before content is persisted or sent to providers.
	isUserInput?: boolean
	// Internal delivery receipt for queued steering. Removed before provider dispatch.
	steeringMessageIds?: string[]
	// Durable tasklet communication receipt. Removed before provider dispatch.
	taskletEventIds?: string[]
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

export interface TranscriptPage {
	entries: DiracStorageMessage[]
	/** Oversized messages are returned as consecutive slices of their JSON, never silently truncated. */
	fragment?: { messageIndex: number; offset: number; totalCharacters: number; json: string }
	nextCursor?: string
}

export function removeUserInputMarkersFromContent(block: DiracContent): DiracContent {
	const { isUserInput, ...contentBlock } = block as DiracContent & { isUserInput?: boolean }
	if (block.type === "tool_result" && Array.isArray(block.content)) {
		return {
			...contentBlock,
			content: block.content.map((nestedBlock) => removeUserInputMarkersFromContent(nestedBlock as DiracContent)),
		} as DiracContent
	}
	if (block.type === "document" && block.source.type === "content" && Array.isArray(block.source.content)) {
		return {
			...contentBlock,
			source: {
				...block.source,
				content: block.source.content.map((nestedBlock) =>
					removeUserInputMarkersFromContent(nestedBlock as DiracContent),
				),
			},
		} as DiracContent
	}
	return contentBlock as DiracContent
}

export function removeUserInputMarkersFromMessage(message: DiracStorageMessage): DiracStorageMessage {
	if (typeof message.content === "string") return message
	return { ...message, content: message.content.map(removeUserInputMarkersFromContent) }
}

export function removeProviderBoundaryMetadataFromMessage(message: DiracStorageMessage): DiracStorageMessage {
	if (typeof message.content === "string") return message
	return { ...message, content: message.content.map(removeProviderBoundaryMetadata) }
}

export function convertDiracStorageToAnthropicMessage(
	diracMessage: DiracStorageMessage,
	provider = "anthropic",
): Anthropic.MessageParam {
	const { role, content } = diracMessage

	if (typeof content === "string") return { role, content }

	const filteredContent = content.filter((block) => block.type !== "thinking" || !!block.signature)
	const cleanedContent = REASONING_DETAILS_PROVIDERS.includes(provider)
		? filteredContent.map(removeProviderBoundaryMetadata)
		: filteredContent.map(cleanContentBlock)

	return { role, content: cleanedContent }
}

function removeProviderBoundaryMetadata(block: DiracContent): DiracContent {
	const { isUserInput, steeringMessageIds, taskletEventIds, ...contentBlock } = block as DiracContent & {
		isUserInput?: boolean
		steeringMessageIds?: string[]
		taskletEventIds?: string[]
	}
	if (block.type === "tool_result" && Array.isArray(block.content)) {
		return {
			...contentBlock,
			content: block.content.map((nestedBlock) => removeProviderBoundaryMetadata(nestedBlock as DiracContent)),
		} as DiracContent
	}
	if (block.type === "document" && block.source.type === "content" && Array.isArray(block.source.content)) {
		return {
			...contentBlock,
			source: {
				...block.source,
				content: block.source.content.map((nestedBlock) => removeProviderBoundaryMetadata(nestedBlock as DiracContent)),
			},
		} as DiracContent
	}
	return contentBlock as DiracContent
}

export function cleanContentBlock(block: DiracContent): Anthropic.ContentBlock {
	const { reasoning_details, call_id, summary, isComplete, isNativeToolCall, isUserInput, steeringMessageIds, taskletEventIds, ...rest } =
		block as any

	if (block.type === "tool_result" && Array.isArray(block.content)) {
		rest.content = block.content.map((nestedBlock) => cleanContentBlock(nestedBlock as DiracContent))
	}
	if (block.type === "document" && block.source.type === "content" && Array.isArray(block.source.content)) {
		rest.source = {
			...block.source,
			content: block.source.content.map((nestedBlock) => cleanContentBlock(nestedBlock as DiracContent)),
		}
	}
	if (block.type !== "thinking" && rest.signature) rest.signature = undefined
	return rest satisfies Anthropic.ContentBlock
}
