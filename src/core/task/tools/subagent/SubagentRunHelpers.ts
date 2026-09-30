import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import {
	DiracAssistantToolUseBlock,
	DiracContent,
	DiracStorageMessage,
	DiracTextContentBlock,
	DiracToolResponseContent,
} from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import type { SubagentRequestUsageState, SubagentRunStats, SubagentToolCall } from "./SubagentRunTypes"

export function createEmptyRequestUsageState(): SubagentRequestUsageState {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
	}
}

export function createEmptySubagentRunStats(): SubagentRunStats {
	return {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	}
}

export function serializeToolResult(result: DiracToolResponseContent): string {
	if (typeof result === "string") {
		return result
	}

	return result
		.map((item) => {
			if (item.type === "text") return item.text
			const imageKind = item.source.type === "base64" ? item.source.media_type : "remote URL"
			return `[Image omitted from trajectory: ${imageKind}]`
		})
		.join("")
}

export function toToolUseParams(input: unknown): Partial<Record<string, unknown>> {
	if (!input || typeof input !== "object") {
		return {}
	}

	return input as Partial<Record<string, unknown>>
}

function formatToolArgPreview(value: unknown, maxLength = 48): string {
	const stringValue = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
	const normalized = stringValue.replace(/\s+/g, " ").trim()
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, maxLength - 3)}...`
}

export function formatToolCallPreview(toolName: string, params: Partial<Record<string, unknown>>): string {
	const entries = Object.entries(params).filter(([, value]) => value !== undefined)
	const visibleEntries = entries.slice(0, 3)
	const omittedCount = Math.max(0, entries.length - visibleEntries.length)

	const args = visibleEntries
		.map(([key, value]) => `${key}=${formatToolArgPreview(value ?? "")}`)
		.concat(omittedCount > 0 ? [`...+${omittedCount}`] : [])
		.join(", ")

	return `${toolName}(${args})`
}

export function normalizeToolCallArguments(argumentsPayload: unknown): string {
	if (typeof argumentsPayload === "string") {
		return argumentsPayload
	}

	try {
		return JSON.stringify(argumentsPayload ?? {})
	} catch {
		return "{}"
	}
}

export function resolveToolUseId(call: { id?: string; call_id?: string; name?: string }, index: number): string {
	const id = call.id?.trim()
	if (id) {
		return id
	}

	const callId = call.call_id?.trim()
	if (callId) {
		return callId
	}

	const fallbackId = `subagent_tool_${Date.now()}_${index + 1}`
	Logger.warn(`[SubagentRunner] Missing tool call id for '${call.name || "unknown"}'; using fallback '${fallbackId}'`)
	return fallbackId
}

export function toAssistantToolUseBlock(call: SubagentToolCall): DiracAssistantToolUseBlock {
	return {
		type: "tool_use",
		id: call.toolUseId,
		name: call.name,
		input: call.input,
		call_id: call.call_id,
		signature: call.signature,
	}
}

export function parseNonNativeToolCalls(assistantText: string): SubagentToolCall[] {
	const parsedBlocks = parseAssistantMessageV2(assistantText)

	return parsedBlocks
		.filter((block): block is ToolUse => block.type === "tool_use")
		.map((block, index) => ({
			toolUseId: resolveToolUseId({ call_id: block.call_id, name: block.name }, index),
			name: block.name,
			input: block.params,
			call_id: block.call_id,
			signature: block.signature,
			isNativeToolCall: false,
		}))
}

export function pushSubagentToolResultBlock(
	toolResultBlocks: DiracContent[],
	call: SubagentToolCall,
	label: string,
	content: DiracToolResponseContent,
): void {
	if (call.isNativeToolCall) {
		toolResultBlocks.push({
			type: "tool_result",
			tool_use_id: call.toolUseId,
			call_id: call.call_id,
			content,
		})
		return
	}

	if (typeof content === "string") {
		toolResultBlocks.push({ type: "text", text: `${label} Result:\n${content}` })
		return
	}
	toolResultBlocks.push({ type: "text", text: `${label} Result:` })
	toolResultBlocks.push(...content)
}

export function getBestEffortResult(conversation: DiracStorageMessage[]): string {
	const assistantTexts = conversation
		.filter((msg) => msg.role === "assistant")
		.flatMap((msg) => {
			if (typeof msg.content === "string") {
				return [{ type: "text", text: msg.content } as DiracTextContentBlock]
			}
			return msg.content as DiracTextContentBlock[]
		})
		.filter((block): block is DiracTextContentBlock => block.type === "text")
		.map((block) => block.text.trim())
		.filter((text) => text.length > 0)

	if (assistantTexts.length === 0) {
		return "No task results recorded."
	}

	return assistantTexts.join("\n")
}
