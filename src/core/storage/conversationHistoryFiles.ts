import { Anthropic } from "@anthropic-ai/sdk"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { atomicWriteFile } from "./atomicWrite"
import { ensureTaskDirectoryExists } from "./directoryEnsurers"

// Writes conversation history to a temp JSON file for PreCompact hook consumption, returning its path.
export async function writeConversationHistoryJson(
	taskId: string,
	apiConversationHistory: Anthropic.MessageParam[],
	timestamp?: number,
): Promise<string> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const fileTimestamp = timestamp ?? Date.now()
	const tempFilePath = path.join(taskDir, `conversation_history_${fileTimestamp}.json`)
	try {
		await atomicWriteFile(tempFilePath, JSON.stringify(apiConversationHistory, null, 2))
		return tempFilePath
	} catch (error) {
		Logger.error("Failed to write conversation history JSON for hook:", error)
		throw error
	}
}

// Cleans up a temporary conversation history file created for hook execution.
export async function cleanupConversationHistoryFile(filePath: string): Promise<void> {
	try {
		if (await fileExistsAtPath(filePath)) {
			await fs.unlink(filePath)
		}
	} catch (error) {
		Logger.debug("Failed to cleanup conversation history file:", filePath, error)
	}
}

// Writes conversation history in human-readable text format to a temp file for hook consumption.
export async function writeConversationHistoryText(
	taskId: string,
	conversationHistory: Anthropic.MessageParam[],
	timestamp?: number,
): Promise<string> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const fileTimestamp = timestamp ?? Date.now()
	const tempFilePath = path.join(taskDir, `conversation_history_${fileTimestamp}.txt`)
	try {
		const fullContext = formatConversationHistoryText(conversationHistory)
		await atomicWriteFile(tempFilePath, fullContext)
		return tempFilePath
	} catch (error) {
		Logger.error("Failed to write conversation history text for hook:", error)
		throw error
	}
}

// Formats the full conversation history into a human-readable text representation.
function formatConversationHistoryText(conversationHistory: Anthropic.MessageParam[]): string {
	let fullContext = "=== CONVERSATION HISTORY ===\n\n"
	for (let i = 0; i < conversationHistory.length; i++) {
		const message = conversationHistory[i]
		fullContext += `--- Message ${i + 1} (${message.role.toUpperCase()}) ---\n`
		fullContext += formatMessageContent(message.content)
		fullContext += "\n"
	}
	fullContext += "=== END OF CONTEXT ===\n"
	return fullContext
}

// Formats a message's content which can be a string or an array of content blocks.
function formatMessageContent(content: Anthropic.MessageParam["content"]): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content.map((block) => `${formatContentBlock(block)}\n\n`).join("")
}

// Formats a single content block (text, image, tool_use, or tool_result).
function formatContentBlock(block: any): string {
	switch (block.type) {
		case "text":
			return block.text
		case "image":
			return `[IMAGE: ${block.source?.type || "unknown"}]`
		case "tool_use":
			return `[TOOL USE: ${block.name}]\nInput: ${JSON.stringify(block.input, null, 2)}`
		case "tool_result":
			return `[TOOL RESULT: ${block.tool_use_id}]\n${formatToolResultContent(block.content)}`
		default:
			return ""
	}
}

// Formats the content field of a tool_result block (string or array of result blocks).
function formatToolResultContent(content: any): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content
		.map((resultBlock: any) => {
			if (resultBlock.type === "text") {
				return resultBlock.text
			}
			if (resultBlock.type === "image") {
				return "[IMAGE]"
			}
			return ""
		})
		.join("")
}
