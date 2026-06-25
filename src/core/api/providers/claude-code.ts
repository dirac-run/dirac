import { filterMessagesForClaudeCode } from "@/integrations/claude-code/message-filter"
import { runClaudeCode } from "@/integrations/claude-code/run"
import {
    buildStructuredToolSchema,
    extractStructuredToolCalls,
    STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/integrations/claude-code/structured-output"
import { ClaudeCodeModelId, claudeCodeDefaultModelId, claudeCodeModels } from "@/shared/api"
import { DiracStorageMessage } from "@/shared/messages/content"
import { type DiracTool } from "@/shared/tools"
import { type ApiHandler, CommonApiHandlerOptions } from ".."
import { withRetry } from "../retry"
import { type ApiStream, ApiStreamUsageChunk } from "../transform/stream"

interface ClaudeCodeHandlerOptions extends CommonApiHandlerOptions {
	claudeCodePath?: string
	apiModelId?: string
	thinkingBudgetTokens?: number
}

export class ClaudeCodeHandler implements ApiHandler {
	private options: ClaudeCodeHandlerOptions

	constructor(options: ClaudeCodeHandlerOptions) {
		this.options = options
	}

	@withRetry({
		maxRetries: 4,
		baseDelay: 2000,
		maxDelay: 15000,
	})
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		// Filter out image blocks since Claude Code doesn't support them
		const filteredMessages = filterMessagesForClaudeCode(messages)

		// The `claude` CLI cannot accept Dirac's tool schemas as a native `tools` payload.
		// Instead we encode them into a --json-schema structured-output contract, which the
		// model fulfils by calling the injected StructuredOutput tool (unwrapped below).
		const jsonSchema = tools && tools.length > 0 ? JSON.stringify(buildStructuredToolSchema(tools)) : undefined

		const claudeProcess = runClaudeCode({
			systemPrompt,
			messages: filteredMessages,
			path: this.options.claudeCodePath,
			modelId: this.getModel().id,
			thinkingBudgetTokens: this.options.thinkingBudgetTokens,
			jsonSchema,
		})

		// Usage is included with assistant messages,
		// but cost is included in the result chunk
		const usage: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		}

		let isPaidUsage = true

		for await (const chunk of claudeProcess) {
			if (typeof chunk === "string") {
				yield { type: "text", text: chunk }
				continue
			}
			if (chunk.type === "system" && chunk.subtype === "init") {
				isPaidUsage = chunk.apiKeySource !== "none"
				continue
			}
			if (chunk.type === "assistant" && "message" in chunk) {
				const message = chunk.message
				this.checkAssistantError(message)
				yield* this.yieldAssistantContent(message.content)
				usage.inputTokens = message.usage?.input_tokens ?? 0
				usage.outputTokens = message.usage?.output_tokens ?? 0
				usage.cacheReadTokens = message.usage?.cache_read_input_tokens ?? 0
				usage.cacheWriteTokens = message.usage?.cache_creation_input_tokens ?? 0
				continue
			}
			if (chunk.type === "result") {
				// The StructuredOutput tool call is streamed on the assistant turn above; the
				// result event (success or the expected error_max_turns) only carries final cost.
				usage.totalCost = isPaidUsage ? chunk.total_cost_usd : 0
				yield usage
			}
		}
	}

	// Detects API errors in assistant messages with stop_reason set. Throws on error.
	private checkAssistantError(message: any): void {
		if (message.stop_reason === null) return
		const content = "text" in message.content[0] ? message.content[0] : undefined
		if (!content || !content.text.startsWith("API Error")) return
		const errorMessageStart = content.text.indexOf("{")
		const errorMessage = content.text.slice(errorMessageStart)
		const error = this.attemptParse(errorMessage)
		if (!error) throw new Error(content.text)
		if (error.error?.message?.includes("Invalid model name")) {
			throw new Error(
				content.text +
					"\n\nAPI keys and subscription plans allow different models. Make sure the selected model is included in your plan.",
			)
		}
		throw new Error(errorMessage)
	}

	// Yields assistant content blocks as text, reasoning, or tool_calls chunks.
	private *yieldAssistantContent(contentBlocks: any[]): Generator<any> {
		for (const content of contentBlocks) {
			switch (content.type) {
				case "text":
					yield { type: "text", text: content.text }
					break
				case "thinking":
					yield { type: "reasoning", reasoning: content.thinking || "" }
					break
				case "redacted_thinking":
					yield { type: "reasoning", reasoning: "[Redacted thinking block]" }
					break
				case "tool_use":
					yield* this.yieldToolUse(content)
					break
			}
		}
	}

	// Unwraps the injected StructuredOutput tool into native tool calls; passes through real tool_use blocks.
	private *yieldToolUse(content: any): Generator<any> {
		// The --json-schema feature surfaces tool choices via an injected StructuredOutput tool.
		// Unwrap its payload into real tool calls so they flow through Dirac's native tool pipeline.
		if (content.name === STRUCTURED_OUTPUT_TOOL_NAME) {
			const structuredCalls = extractStructuredToolCalls(content.input)
			for (let idx = 0; idx < structuredCalls.length; idx++) {
				const structuredCall = structuredCalls[idx]
				const callId = `${content.id}_${idx}`
				yield {
					type: "tool_calls",
					tool_call: {
						call_id: callId,
						function: {
							id: callId,
							name: structuredCall.tool,
							arguments: JSON.stringify(structuredCall.params ?? {}),
						},
					},
				}
			}
			return
		}
		yield {
			type: "tool_calls",
			tool_call: {
				call_id: content.id,
				function: { id: content.id, name: content.name, arguments: JSON.stringify(content.input) },
			},
		}
	}

	private attemptParse(str: string) {
		try {
			return JSON.parse(str)
		} catch (_err) {
			return null
		}
	}

	getModel() {
		const modelId = this.options.apiModelId
		if (modelId && modelId in claudeCodeModels) {
			const id = modelId as ClaudeCodeModelId
			return { id, info: claudeCodeModels[id] }
		}

		return {
			id: claudeCodeDefaultModelId,
			info: claudeCodeModels[claudeCodeDefaultModelId],
		}
	}
}
