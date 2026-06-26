import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

/**
 * Safely converts a value into a plain object.
 */
export function asObjectSafe(value: any): object {
	// Handle null/undefined
	if (!value) {
		return {}
	}

	try {
		// Handle strings that might be JSON
		if (typeof value === "string") {
			return JSON.parse(value)
		}

		// Handle pre-existing objects
		if (typeof value === "object") {
			return Object.assign({}, value)
		}

		return {}
	} catch (error) {
		Logger.debug("Dirac <Language Model API>: Failed to parse object:", error)
		return {}
	}
}

// Describes an unsupported image as a text placeholder for the VSCode LM API.
function imagePlaceholder(source?: any): string {
	const type = source?.type || "Unknown source-type"
	const detail = source?.type === "base64" ? source.media_type : "url"
	return `[Image (${type}): ${detail} not supported by VSCode LM API]`
}

// Converts a tool_result's content into VSCode TextParts (images become placeholders).
function convertToolResultContent(
	content: string | Anthropic.ToolResultBlockParam["content"] | undefined,
): vscode.LanguageModelTextPart[] {
	if (typeof content === "string") return [new vscode.LanguageModelTextPart(content)]
	if (!Array.isArray(content)) return [new vscode.LanguageModelTextPart("")]
	return content.map((part: any) =>
		part.type === "image"
			? new vscode.LanguageModelTextPart(imagePlaceholder(part.source))
			: new vscode.LanguageModelTextPart(part.type === "text" ? part.text : ""),
	)
}

// Converts user-role array content: tool results first, then text/image parts.
function convertVsCodeLmUserMessage(content: Anthropic.Messages.ContentBlockParam[]): vscode.LanguageModelChatMessage {
	const { nonToolMessages, toolMessages } = content.reduce<{ nonToolMessages: any[]; toolMessages: any[] }>(
		(acc, part) => {
			if (part.type === "tool_result") acc.toolMessages.push(part)
			else if (part.type === "text" || part.type === "image") acc.nonToolMessages.push(part)
			return acc
		},
		{ nonToolMessages: [], toolMessages: [] },
	)
	const contentParts = [
		...toolMessages.map(
			(tm: any) => new vscode.LanguageModelToolResultPart(tm.tool_use_id, convertToolResultContent(tm.content)),
		),
		...nonToolMessages.map((part: any) =>
			part.type === "image"
				? new vscode.LanguageModelTextPart(imagePlaceholder(part.source))
				: new vscode.LanguageModelTextPart(part.text),
		),
	]
	return vscode.LanguageModelChatMessage.User(contentParts)
}

// Converts assistant-role array content: tool calls first, then text/image parts.
function convertVsCodeLmAssistantMessage(content: Anthropic.Messages.ContentBlockParam[]): vscode.LanguageModelChatMessage {
	const { nonToolMessages, toolMessages } = content.reduce<{ nonToolMessages: any[]; toolMessages: any[] }>(
		(acc, part) => {
			if (part.type === "tool_use") acc.toolMessages.push(part)
			else if (part.type === "text" || part.type === "image") acc.nonToolMessages.push(part)
			return acc
		},
		{ nonToolMessages: [], toolMessages: [] },
	)
	const contentParts = [
		...toolMessages.map((tm: any) => new vscode.LanguageModelToolCallPart(tm.id, tm.name, asObjectSafe(tm.input))),
		...nonToolMessages.map((part: any) =>
			part.type === "image"
				? new vscode.LanguageModelTextPart("[Image generation not supported by VSCode LM API]")
				: new vscode.LanguageModelTextPart(part.type === "text" ? part.text : ""),
		),
	]
	return vscode.LanguageModelChatMessage.Assistant(contentParts)
}

export function convertToVsCodeLmMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
): vscode.LanguageModelChatMessage[] {
	const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			vsCodeLmMessages.push(
				anthropicMessage.role === "assistant"
					? vscode.LanguageModelChatMessage.Assistant(anthropicMessage.content)
					: vscode.LanguageModelChatMessage.User(anthropicMessage.content),
			)
			continue
		}
		if (anthropicMessage.role === "user") {
			vsCodeLmMessages.push(convertVsCodeLmUserMessage(anthropicMessage.content))
		} else if (anthropicMessage.role === "assistant") {
			vsCodeLmMessages.push(convertVsCodeLmAssistantMessage(anthropicMessage.content))
		}
	}

	return vsCodeLmMessages
}

export function convertToAnthropicRole(
	vsCodeLmMessageRole: vscode.LanguageModelChatMessageRole,
): Anthropic.Messages.MessageParam["role"] | null {
	switch (vsCodeLmMessageRole) {
		case vscode.LanguageModelChatMessageRole.Assistant:
			return "assistant"
		case vscode.LanguageModelChatMessageRole.User:
			return "user"
		default:
			return null
	}
}

export function convertToAnthropicMessage(vsCodeLmMessage: vscode.LanguageModelChatMessage): Anthropic.Messages.Message {
	const anthropicRole = convertToAnthropicRole(vsCodeLmMessage.role)
	if (anthropicRole !== "assistant") {
		throw new Error("Dirac <Language Model API>: Only assistant messages are supported.")
	}

	return {
		id: crypto.randomUUID(),
		type: "message",
		model: "vscode-lm",
		role: anthropicRole,
		content: vsCodeLmMessage.content
			.map((part): Anthropic.ContentBlock | null => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return {
						type: "text",
						text: part.value,
						citations: null,
					}
				}

				if (part instanceof vscode.LanguageModelToolCallPart) {
					return {
						type: "tool_use",
						id: part.callId || crypto.randomUUID(),
						name: part.name,
						input: asObjectSafe(part.input),
						caller: { type: "direct" },
					}
				}

				return null
			})
			.filter((part): part is Anthropic.ContentBlock => part !== null),
		stop_reason: null,
		container: null,
		stop_details: null,

		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			cache_creation: null,
			inference_geo: null,
			server_tool_use: null,
			service_tier: null,
		},
	}
}
