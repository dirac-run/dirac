import { formatResponse } from "@core/formatResponse"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { CardStatus } from "@shared/ExtensionMessage"
import type { ApiHandler } from "../../../../core/api"
import type { ToolUse } from "../../../assistant-message"
import type { MessageStateHandler } from "../../message-state"
import type { StateManager } from "../../../storage/StateManager"
import type { TaskMessenger } from "../../TaskMessenger"
import type { TaskState } from "../../TaskState"

// Runs PostToolUse hooks and handles context modification + cancellation.
export class ToolHookRunner {
	constructor(
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private stateManager: StateManager,
		private taskMessenger: TaskMessenger,
		private taskId: string,
		private setActiveHookExecution: (hookExecution: any) => Promise<void>,
		private clearActiveHookExecution: () => Promise<void>,
	) {}

	// Runs PostToolUse hook; returns true if hook requested cancellation.
	async runPostToolUseHook(
		block: ToolUse,
		toolResult: any,
		executionSuccess: boolean,
		executionStartTime: number,
		hooksEnabled: boolean,
	): Promise<boolean> {
		const { executeHook } = await import("../../../hooks/hook-executor")
		const executionTimeMs = Date.now() - executionStartTime
		const postToolResult = await executeHook({
			hookName: "PostToolUse",
			hookInput: {
				postToolUse: {
					toolName: block.name,
					parameters: block.params,
					result: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
					success: executionSuccess,
					executionTimeMs,
				},
			},
			isCancellable: true,
			messenger: this.taskMessenger,
			setActiveHookExecution: this.setActiveHookExecution,
			clearActiveHookExecution: this.clearActiveHookExecution,
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
			model: getHookModelContext(this.api, this.stateManager),
			toolName: block.name,
		})
		if (postToolResult.cancel === true) {
			const errorMessage = postToolResult.errorMessage || "Hook requested task cancellation"
			const card = await this.taskMessenger.createCard({
				header: "Hook Error",
				body: errorMessage,
				status: CardStatus.ERROR,
			})
			await card.finalize(CardStatus.ERROR)
			return true
		}
		if (postToolResult.contextModification)
			this.addHookContextToConversation(postToolResult.contextModification, "PostToolUse")
		return false
	}

	// Adds hook context modification to the conversation if provided.
	addHookContextToConversation(contextModification: string | undefined, source: string): void {
		if (!contextModification) return
		const contextText = contextModification.trim()
		if (!contextText) return
		const lines = contextText.split("\n")
		const firstLine = lines[0]
		let contextType = "general"
		let content = contextText
		const typeMatch = /^([A-Z_]+):\s*(.*)/.exec(firstLine)
		if (typeMatch) {
			contextType = typeMatch[1].toLowerCase()
			const remainingLines = lines.slice(1).filter((l: string) => l.trim())
			content = typeMatch[2] ? [typeMatch[2], ...remainingLines].join("\n") : remainingLines.join("\n")
		}
		this.taskState.userMessageContent.push({
			type: "text",
			text: `<hook_context source="${source}" type="${contextType}">\n${content}\n</hook_context>`,
		})
	}
}

// Handles tool execution errors — creates error cards and pushes error responses.
export class ToolErrorHandler {
	constructor(
		private taskState: TaskState,
		private taskMessenger: TaskMessenger,
	) {}

	// Creates an error card and pushes a tool error response to the conversation.
	async handleError(
		action: string,
		error: Error,
		block: ToolUse,
		pushToolResult: (content: any, block: ToolUse) => Promise<void>,
	): Promise<void> {
		const errorString = `Error ${action}: ${error.message}`
		await this.taskMessenger.createCard({ header: "Tool Error", body: errorString, status: CardStatus.ERROR })
		pushToolResult(formatResponse.toolError(errorString), block)
	}
}
