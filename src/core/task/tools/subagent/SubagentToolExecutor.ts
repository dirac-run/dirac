import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/formatResponse"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { DiracContent } from "@shared/messages/content"
import type { ResponseArguments } from "@shared/responseTool"
import {
	canonicalizeResponseToolCall,
	ResponseOperation,
	ResponseParameter,
	ResponseShapeError,
	responseOperationFromToolCall,
	validateResponseShape,
} from "@shared/responseTool"
import { createSubagentTrajectoryEvent, SubagentTrajectoryEventType } from "@shared/subagents"
import { DiracDefaultTool } from "@shared/tools"
import type { TaskState } from "../../TaskState"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { ToolResponse } from "../types/ToolResponse"
import { formatToolCallPreview, pushSubagentToolResultBlock, serializeToolResult, toToolUseParams } from "./SubagentRunHelpers"
import { type SubagentProgressUpdate, type SubagentRunStats, type SubagentToolCall } from "./SubagentRunTypes"

export interface SubagentToolExecutionObserver {
	recordToolCall(call: SubagentToolCall): void
	recordToolResult(call: SubagentToolCall, result: unknown): void
	recordProgress(text: string): void
	markActivity(action: string): void
}

// Executes finalized tool calls for a subagent turn, including intercepted completion, authorization, and dispatch.
// Extracted from SubagentRunner.run() to reduce the 400-line method.
export class SubagentToolExecutor {
	constructor(
		private createSubagentTaskConfig: (state: TaskState, coordinator: ToolExecutorCoordinator) => TaskConfig,
		private isAllowedTool: (toolName: string, requestSnapshot: ToolRequestSnapshot) => boolean,
		private readonly observer?: SubagentToolExecutionObserver,
	) { }

	// Processes all tool calls for a turn. Returns a completed result for the complete response operation.
	async executeToolCalls(
		finalizedToolCalls: SubagentToolCall[],
		state: TaskState,
		requestSnapshot: ToolRequestSnapshot,
		stats: SubagentRunStats,
		onProgress: (update: SubagentProgressUpdate) => void,
		isWrappingUp = false,
	): Promise<{ completed?: { result: string; stats: SubagentRunStats }; toolResultBlocks: DiracContent[] }> {
		const toolResultBlocks: DiracContent[] = []
		for (const call of finalizedToolCalls) {
			this.observer?.recordToolCall(call)
			this.observer?.markActivity(`processing tool call '${call.name}'`)
			const recordToolResult = (result: unknown) => this.observer?.recordToolResult(call, result)
			const toolCallBlock: ToolUse = {
				type: "tool_use",
				name: call.name,
				params: toToolUseParams(call.input),
				isNativeToolCall: call.isNativeToolCall,
				call_id: call.call_id || call.toolUseId,
				signature: call.signature,
			}
			try {
				canonicalizeResponseToolCall(toolCallBlock)
			} catch (error) {
				if (!(error instanceof ResponseShapeError)) throw error
				const result = formatResponse.toolError(error.message)
				recordToolResult(result)
				pushSubagentToolResultBlock(toolResultBlocks, call, call.name, result)
				continue
			}
			const toolName = toolCallBlock.name
			const toolCallParams = toolCallBlock.params
			const responseOperation = responseOperationFromToolCall(toolCallBlock)
			const toolCallPreview = formatToolCallPreview(toolName, toolCallParams)
			onProgress({
				latestToolCall: toolCallPreview,
				trajectoryEvent: createSubagentTrajectoryEvent(SubagentTrajectoryEventType.TOOL, toolCallPreview),
			})
			if (responseOperation && !this.isResponseOperationAllowed(responseOperation, requestSnapshot)) {
				const result = formatResponse.toolError(
					`The '${responseOperation}' response operation is not available inside this subagent run.`,
				)
				recordToolResult(result)
				pushSubagentToolResultBlock(toolResultBlocks, call, toolName, result)
				continue
			}
			if (responseOperation) {
				let responseArguments: ResponseArguments
				try {
					responseArguments = validateResponseShape(toolCallParams)
				} catch (error) {
					if (!(error instanceof ResponseShapeError)) throw error
					const result = formatResponse.toolError(error.message)
					recordToolResult(result)
					pushSubagentToolResultBlock(toolResultBlocks, call, toolName, result)
					continue
				}
				if (responseOperation === ResponseOperation.PROGRESS) {
					this.observer?.recordProgress(responseArguments.text)
					onProgress({
						trajectoryEvent: createSubagentTrajectoryEvent(
							SubagentTrajectoryEventType.MESSAGE,
							responseArguments.text,
						),
					})
				}

				if (responseOperation === ResponseOperation.COMPLETE) {
					const completionResult = responseArguments.text.trim()
					recordToolResult({ operation: ResponseOperation.COMPLETE, result: completionResult })
					stats.toolCalls += 1
					onProgress({ stats: { ...stats } })
					onProgress({ status: SubagentExecutionStatus.COMPLETED, result: completionResult, stats: { ...stats } })
					return { completed: { result: completionResult, stats: { ...stats } }, toolResultBlocks }
				}
			}

			if (isWrappingUp) {
				const result = formatResponse.toolError(
					'Further task execution is no longer available because the deadline expired. Call respond with operation "complete" now, summarizing completed work, changes made, verification results, and any blockers or remaining work.',
				)
				recordToolResult(result)
				onProgress({
					trajectoryEvent: createSubagentTrajectoryEvent(SubagentTrajectoryEventType.TOOL_RESULT, result),
				})
				pushSubagentToolResultBlock(toolResultBlocks, call, `[${toolName}]`, result)
				continue
			}

			if (!this.isAllowedTool(toolName, requestSnapshot)) {
				const result = formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`)
				recordToolResult(result)
				pushSubagentToolResultBlock(toolResultBlocks, call, toolName, result)
				continue
			}

			if (call.call_id) state.toolUseIdMap.set(call.call_id, call.toolUseId)
			const subagentConfig = this.createSubagentTaskConfig(state, requestSnapshot.coordinator)
			let toolResult: ToolResponse
			if (!subagentConfig.coordinator.has(toolName)) {
				toolResult = formatResponse.toolError(`No handler registered for tool '${toolName}'.`)
			} else {
				try {
					toolResult = await subagentConfig.coordinator.execute(subagentConfig, toolCallBlock)
				} catch (error) {
					toolResult = formatResponse.toolError((error as Error).message)
				}
			}

			this.observer?.markActivity(`completed tool call '${toolName}'`)
			const serializedToolResult = serializeToolResult(toolResult)
			recordToolResult(serializedToolResult)
			stats.toolCalls += 1
			onProgress({ stats: { ...stats } })
			onProgress({
				trajectoryEvent: createSubagentTrajectoryEvent(SubagentTrajectoryEventType.TOOL_RESULT, serializedToolResult),
			})
			pushSubagentToolResultBlock(toolResultBlocks, call, `[${toolName}]`, toolResult)
		}
		return { toolResultBlocks }
	}

	private isResponseOperationAllowed(operation: ResponseOperation, snapshot: ToolRequestSnapshot): boolean {
		const spec = snapshot.promptVisibleSpecs.find((candidate) => candidate.name === DiracDefaultTool.RESPOND)
		const allowed = spec?.parameters?.find((parameter) => parameter.name === ResponseParameter.OPERATION)?.enum
		return Array.isArray(allowed) && allowed.includes(operation)
	}
}
