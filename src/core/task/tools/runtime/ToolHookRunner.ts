import { formatResponse } from "@core/formatResponse"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { CardStatus } from "@shared/ExtensionMessage"
import type { ApiHandler } from "../../../../core/api"
import type { ToolUse } from "../../../assistant-message"
import type { MessageStateHandler } from "../../message-state"
import type { TaskMessenger } from "../../TaskMessenger"
import type { TaskState } from "../../TaskState"

import type { HookExecution } from "../../types/HookExecution"
/** Runs a post-tool hook and returns its effects without writing into a model turn. */
export class ToolHookRunner {
	constructor(
		private messageStateHandler: MessageStateHandler,
		private taskMessenger: TaskMessenger,
		private taskId: string,
		private setActiveHookExecution: (hookExecution: HookExecution) => Promise<void>,
		private clearActiveHookExecution: (runId: string) => Promise<void>,
	) { }

	async runPostToolUseHook(
		block: ToolUse,
		toolResult: import("../types/ToolResponse").ToolResponse,
		executionSuccess: boolean,
		executionStartTime: number,
		hooksEnabled: boolean,
		api: ApiHandler,
		providerId: string,
		signal?: AbortSignal,
		invocationContext?: import("../../types/task-messenger").TaskMessengerInvocationContext,
	): Promise<{ cancelled: boolean; context?: import("@shared/messages/content").DiracUserContent }> {
		const { executeHook } = await import("../../../hooks/hook-executor")
		const messenger = invocationContext ? this.taskMessenger.forInvocation(invocationContext) : this.taskMessenger
		const postToolResult = await executeHook({
			hookName: "PostToolUse",
			hookInput: {
				postToolUse: {
					toolName: block.name,
					parameters: block.params,
					result: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
					success: executionSuccess,
					executionTimeMs: Date.now() - executionStartTime,
				},
			},
			isCancellable: true,
			messenger,
			setActiveHookExecution: this.setActiveHookExecution,
			clearActiveHookExecution: this.clearActiveHookExecution,
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
			model: getHookModelContext(api, { providerId }),
			toolName: block.name,
			signal,
		})
		// An execution abort is local; it must not request cancellation of sibling work.
		signal?.throwIfAborted()
		if (postToolResult.cancel === true) {
			const card = await messenger.createCard({
				header: "Hook Error",
				body: postToolResult.errorMessage || "Hook requested task cancellation",
				status: CardStatus.ERROR,
			})
			await card.finalize(CardStatus.ERROR)
			return { cancelled: true }
		}
		return { cancelled: false, context: this.formatHookContext(postToolResult.contextModification, "PostToolUse") }
	}

	formatHookContext(contextModification: string | undefined, source: string): import("@shared/messages/content").DiracUserContent | undefined {
		const contextText = contextModification?.trim()
		if (!contextText) return undefined
		const lines = contextText.split("\n")
		let contextType = "general"
		let content = contextText
		const typeMatch = /^([A-Z_]+):\s*(.*)/.exec(lines[0])
		if (typeMatch) {
			contextType = typeMatch[1].toLowerCase()
			const remainingLines = lines.slice(1).filter((line) => line.trim())
			content = typeMatch[2] ? [typeMatch[2], ...remainingLines].join("\n") : remainingLines.join("\n")
		}
		return { type: "text", text: `<hook_context source="${source}" type="${contextType}">\n${content}\n</hook_context>` }
	}
}

// Handles tool execution errors — creates error cards and pushes error responses.
export class ToolErrorHandler {
	constructor(
		private taskState: TaskState,
		private taskMessenger: TaskMessenger,
	) { }

	// Creates an error card and pushes a tool error response to the conversation.
	async handleError(
		action: string,
		error: Error,
		block: ToolUse,
		pushToolResult: (content: any, block: ToolUse) => Promise<void>,
	): Promise<void> {
		const errorString = `Error ${action}: ${error.message}`
		await this.taskMessenger.createCard({
			header: "Tool Error",
			toolName: block.name,
			body: errorString,
			status: CardStatus.ERROR,
		})
		await pushToolResult(formatResponse.toolError(errorString), block)
	}
}
