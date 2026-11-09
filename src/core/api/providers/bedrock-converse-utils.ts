/**
 * Pure helpers shared by the Bedrock provider. Extracted out of
 * `src/core/api/providers/bedrock.ts` (FB-15b) — no class state.
 */
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type {
	ContentBlock,
	ConverseCommandOutput,
	ImageFormat,
	InferenceConfiguration,
	Message,
	SystemContentBlock,
	Tool,
	ToolConfiguration,
	ToolResultContentBlock,
	ToolSpecification,
	ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { ModelInfo } from "@shared/api"
import { getErrorMessage } from "@/shared/errors"
import type { DiracContent, DiracImageContentBlock, DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import type { DiracTool } from "@/shared/tools"
import type { ApiStreamChunk } from "../transform/stream"

/** Approximate token count (4 characters per token). */
export function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4)
}

/** Extracts the visible text + reasoning text from a non-streaming Converse response. */
export function extractNonStreamingContent(response: ConverseCommandOutput): { fullText: string; reasoningText: string } {
	let fullText = ""
	let reasoningText = ""
	for (const block of response.output?.message?.content ?? []) {
		if (block.reasoningContent?.reasoningText?.text) {
			reasoningText += block.reasoningContent.reasoningText.text
		} else if (block.text) {
			fullText += block.text
		}
	}
	return { fullText, reasoningText }
}

/** Formats an unknown error for the Converse error message, naming it when present. */
export function formatConverseError(error: unknown, label: string): string {
	if (error instanceof Error) {
		const named = error as Error & { name?: string }
		return named.name ? `${named.name}: ${error.message}` : error.message
	}
	return `Failed to process ${label} model request`
}

/** Prepares system messages with optional Converse caching support. */
export function prepareSystemMessages(systemPrompt: string, enableCaching: boolean): SystemContentBlock[] | undefined {
	if (!systemPrompt) {
		return undefined
	}
	if (enableCaching) {
		return [{ text: systemPrompt }, { cachePoint: { type: "default" } }]
	}
	return [{ text: systemPrompt }]
}

const TEXT_CHUNK_SIZE = 1000

/** Chunks text into TEXT_CHUNK_SIZE segments and yields as the given chunk type. */
export function* chunkText(text: string, type: "text" | "reasoning"): Generator<ApiStreamChunk> {
	if (!text) return
	for (let i = 0; i < text.length; i += TEXT_CHUNK_SIZE) {
		const chunk = text.slice(i, Math.min(i + TEXT_CHUNK_SIZE, text.length))
		yield type === "reasoning" ? { type: "reasoning", reasoning: chunk } : { type: "text", text: chunk }
	}
}

/**
 * Converts Dirac's tool definitions (Anthropic format with `input_schema`) to the
 * Bedrock Converse API `ToolConfiguration` shape.
 */
export function mapDiracToolsToBedrockToolConfig(tools?: DiracTool[]): ToolConfiguration | undefined {
	if (!tools || tools.length === 0) {
		return undefined
	}
	const isAnthropicTool = (tool: DiracTool): tool is AnthropicTool => "input_schema" in tool
	const bedrockTools = tools.filter(isAnthropicTool).map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description || tool.name || "Tool",
			// Anthropic's JSON schema is structurally a valid Converse JSON schema.
			inputSchema: { json: tool.input_schema as NonNullable<ToolSpecification["inputSchema"]>["json"] },
		},
	}))
	if (bedrockTools.length === 0) {
		return undefined
	}
	return {
		// The literal matches ToolSpecMember; Smithy union members additionally
		// declare exclusive/$unknown fields that plain literals cannot carry.
		tools: bedrockTools as Tool[],
		toolChoice: { auto: {} },
	}
}

/** Converts a Dirac image content block into a Bedrock image content block. */
export function processImageContent(item: DiracImageContentBlock): ContentBlock | null {
	const source = item.source
	let format: ImageFormat = "jpeg"
	if (source.type === "base64") {
		const formatMatch = source.media_type.match(/image\/(\w+)/)
		if (formatMatch?.[1] && (["png", "jpeg", "gif", "webp"] as readonly string[]).includes(formatMatch[1])) {
			format = formatMatch[1] as ImageFormat
		}
	}
	try {
		if (source.type !== "base64") {
			throw new Error("Unsupported image data format")
		}
		const base64Data = source.data.replace(/^data:image\/\w+;base64,/, "")
		const imageData = new Uint8Array(Buffer.from(base64Data, "base64"))
		return { image: { format, source: { bytes: imageData } } }
	} catch (error) {
		Logger.error("Failed to process image content:", error)
		return { text: `[ERROR: Failed to process image - ${getErrorMessage(error, "Unknown error")}]` }
	}
}

/**
 * Applies Bedrock cache-point markers to the last + second-to-last user messages.
 * A -1 index marks "no such message".
 */
export function applyCacheControlToMessages(
	messages: Message[],
	userIndices: { lastUserIndex: number; secondLastUserIndex: number },
): Message[] {
	const { lastUserIndex, secondLastUserIndex } = userIndices
	return messages.map((message, index) => {
		if (index !== lastUserIndex && index !== secondLastUserIndex) {
			return message
		}
		return appendCachePoint(message)
	})
}

function appendCachePoint(message: Message): Message {
	if (!message.content || !Array.isArray(message.content)) {
		return message
	}
	return { ...message, content: [...message.content, { cachePoint: { type: "default" } }] }
}

/** Converts Dirac (Anthropic-format) messages to Bedrock Converse `Message[]`. */
export function formatMessagesForConverseAPI(messages: DiracStorageMessage[], supportsImages = true): Message[] {
	return messages.map((message) => {
		const role = message.role === "user" ? ConversationRole.USER : ConversationRole.ASSISTANT
		let content: ContentBlock[] = []
		// Preserve empty-string content as a text block (master contract).
		if (typeof message.content === "string") {
			content = [{ text: message.content }]
		} else if (Array.isArray(message.content)) {
			content = message.content
				.map((item) => mapMessageContentBlock(item as DiracContent, supportsImages))
				.filter((item): item is ContentBlock => item !== null)
		}
		return { role, content }
	})
}

function mapMessageContentBlock(item: DiracContent, supportsImages: boolean): ContentBlock | null {
	if (item.type === "text") return { text: item.text }
	if (item.type === "image") return supportsImages ? processImageContent(item) : { text: "[Image]" }
	if (item.type === "tool_use") {
		// Tool inputs are unvalidated JSON at the Converse boundary.
		return { toolUse: { toolUseId: item.id, name: item.name, input: item.input as ToolUseBlock["input"] } }
	}
	// This Converse adapter does not replay Anthropic thinking blocks or their signatures.
	if (item.type === "thinking" || item.type === "redacted_thinking") return null
	if (item.type === "tool_result") {
		return {
			toolResult: {
				toolUseId: item.tool_use_id,
				content: mapToolResultContent(item.content, supportsImages),
				status: item.is_error ? "error" : "success",
			},
		}
	}
	Logger.warn(`Unsupported content type: ${item.type}`)
	return null
}

// Maps tool_result payload to ToolResultContentBlock only (text/image/json) — never top-level toolUse/toolResult.
function mapToolResultContent(
	content: string | readonly DiracContent[] | unknown,
	supportsImages: boolean,
): ToolResultContentBlock[] {
	if (typeof content === "string") return [{ text: content }]
	if (Array.isArray(content)) {
		return content.flatMap((block) => mapToolResultContentBlock(block as DiracContent, supportsImages))
	}
	return [{ json: content as never }]
}

function mapToolResultContentBlock(block: DiracContent, supportsImages: boolean): ToolResultContentBlock[] {
	if (block.type === "text") return [{ text: block.text }]
	if (block.type === "image") {
		if (!supportsImages) return [{ text: "[Image]" }]
		const imageBlock = processImageContent(block)
		return imageBlock?.image ? [{ image: imageBlock.image }] : [{ text: "[Image]" }]
	}
	// Nested tool_use/tool_result/thinking are not valid ToolResultContentBlock members.
	return []
}

/** Gets the Bedrock Converse inference configuration for a model type. */
export function getInferenceConfig(
	modelInfo: ModelInfo,
	modelType: "anthropic" | "nova",
	thinkingBudgetTokens: number,
): InferenceConfiguration {
	if (modelType === "anthropic") {
		const reasoningOn = thinkingBudgetTokens > 0 && (modelInfo.supportsReasoning ?? false)
		return {
			maxTokens: modelInfo.maxTokens || 8192,
			temperature: reasoningOn || modelInfo.supportsReasoningEffort ? undefined : modelInfo.temperature,
		}
	}
	return {
		maxTokens: modelInfo.maxTokens || (modelType === "nova" ? 5000 : 8192),
		temperature: modelInfo.temperature ?? 0,
	}
}
