import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/formatResponse"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { TOOL_EXAMPLES } from "@core/tool-examples"
import { DiracContent } from "@shared/messages/content"
import { DiracDefaultTool } from "@shared/tools"
import type { TaskState } from "../../TaskState"
import type { TaskConfig } from "../types/TaskConfig"
import type { SubagentToolCall } from "./SubagentRunner"
import { formatToolCallPreview, pushSubagentToolResultBlock, serializeToolResult, toToolUseParams } from "./SubagentRunner"

// Executes finalized tool calls for a subagent turn — handles attempt_completion, denied tools, and dispatch.
// Extracted from SubagentRunner.run() to reduce the 400-line method.
export class SubagentToolExecutor {
	constructor(
		private createSubagentTaskConfig: (state: TaskState, coordinator: any) => TaskConfig,
		private isAllowedTool: (toolName: string, requestSnapshot: ToolRequestSnapshot) => boolean,
	) {}

	// Processes all tool calls for a turn. Returns "completed" result if attempt_completion was called, or tool result blocks.
	async executeToolCalls(
		finalizedToolCalls: SubagentToolCall[],
		state: TaskState,
		requestSnapshot: ToolRequestSnapshot,
		stats: any,
		onProgress: (update: any) => void,
	): Promise<{ completed?: { result: string; stats: any }; toolResultBlocks: DiracContent[] }> {
		const toolResultBlocks: DiracContent[] = []
		for (const call of finalizedToolCalls) {
			const toolName = call.name
			const toolCallParams = toToolUseParams(call.input)

			// attempt_completion — returns final result
			if (toolName === DiracDefaultTool.ATTEMPT) {
				const completionResult = toolCallParams.result?.trim()
				if (!completionResult) {
					const example = TOOL_EXAMPLES[DiracDefaultTool.ATTEMPT]
					pushSubagentToolResultBlock(
						toolResultBlocks,
						call,
						toolName,
						formatResponse.missingToolParameterError("result", example),
					)
					continue
				}
				stats.toolCalls += 1
				onProgress({ stats: { ...stats } })
				onProgress({ status: "completed", result: completionResult, stats: { ...stats } })
				return { completed: { result: completionResult, stats: { ...stats } }, toolResultBlocks }
			}

			// Denied tool
			if (!this.isAllowedTool(toolName, requestSnapshot)) {
				pushSubagentToolResultBlock(
					toolResultBlocks,
					call,
					toolName,
					formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`),
				)
				continue
			}

			// Dispatch to coordinator
			const toolCallBlock: ToolUse = {
				type: "tool_use",
				name: toolName as DiracDefaultTool,
				params: toolCallParams,
				isNativeToolCall: call.isNativeToolCall,
				call_id: call.call_id || call.toolUseId,
				signature: call.signature,
			}
			if (call.call_id) state.toolUseIdMap.set(call.call_id, call.toolUseId)
			onProgress({ latestToolCall: formatToolCallPreview(toolName, toolCallParams) })

			const subagentConfig = this.createSubagentTaskConfig(state, requestSnapshot.coordinator)
			let toolResult: unknown
			if (!subagentConfig.coordinator.has(toolName)) {
				toolResult = formatResponse.toolError(`No handler registered for tool '${toolName}'.`)
			} else {
				try {
					toolResult = await subagentConfig.coordinator.execute(subagentConfig, toolCallBlock)
				} catch (error) {
					toolResult = formatResponse.toolError((error as Error).message)
				}
			}

			stats.toolCalls += 1
			onProgress({ stats: { ...stats } })
			pushSubagentToolResultBlock(toolResultBlocks, call, `[${toolName}]`, serializeToolResult(toolResult))
		}
		return { toolResultBlocks }
	}
}
