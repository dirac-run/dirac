import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { telemetryService } from "@services/telemetry"
import { DiracAssistantContent } from "@shared/messages/content"
import { convertDiracMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Session } from "@shared/services/Session"
import { READ_ONLY_TOOLS } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import cloneDeep from "clone-deep"
import { ResponseProcessorDependencies } from "./types/response-processor"

export class ResponseProcessor {
	constructor(private dependencies: ResponseProcessorDependencies) {}

	public async processAssistantResponse(params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: string
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		modelInfo: any
		toolUseHandler: any
	}): Promise<boolean> {
		const assistantHasContent = params.assistantMessage.length > 0 || this.dependencies.taskState.useNativeToolCalls

		if (assistantHasContent) {
			telemetryService.captureConversationTurnEvent(
				this.dependencies.ulid,
				params.providerId,
				params.modelId,
				"assistant",
				params.mode as any,
			)

			const { reasonsHandler } = this.dependencies.streamHandler.getHandlers()
			const redactedThinkingContent = reasonsHandler.getRedactedThinking()
			const requestId = this.dependencies.streamHandler.requestId

			const assistantContent: Array<DiracAssistantContent> = [...redactedThinkingContent]

			const thinkingBlock = reasonsHandler.getCurrentReasoning()
			if (thinkingBlock) {
				assistantContent.push({ ...thinkingBlock })
			}

			const hasAssistantText = params.assistantTextOnly.trim().length > 0
			if (hasAssistantText) {
				assistantContent.push({
					type: "text",
					text: params.assistantTextOnly,
					reasoning_details: thinkingBlock?.summary as any[],
					signature: params.assistantTextSignature,
					call_id: params.assistantMessageId,
				})
			}

			const toolUseBlocks = params.toolUseHandler.getAllFinalizedToolUses(
				hasAssistantText ? undefined : thinkingBlock?.summary,
			)
			if (toolUseBlocks.length > 0) {
				assistantContent.push(...toolUseBlocks)
			}

			if (assistantContent.length > 0) {
				await this.dependencies.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: assistantContent,
					modelInfo: params.modelInfo,
					id: requestId,
					metrics: {
						tokens: {
							prompt: params.taskMetrics.inputTokens,
							completion: params.taskMetrics.outputTokens,
							cached: (params.taskMetrics.cacheWriteTokens ?? 0) + (params.taskMetrics.cacheReadTokens ?? 0),
						},
						cost: params.taskMetrics.totalCost,
					},
					ts: Date.now(),
				})
			}
		}

		this.dependencies.taskState.didCompleteReadingStream = true

		const partialBlocks = this.dependencies.taskState.assistantMessageContent.filter((block) => block.partial)
		partialBlocks.forEach((block) => {
			block.partial = false
		})

		const partialToolBlocks = params.toolUseHandler
			.getPartialToolUsesAsContent()
			?.map((block: any) => ({ ...block, partial: false }))
		await this.processNativeToolCalls(params.assistantTextOnly, partialToolBlocks)

		await this.presentAssistantMessage()

		return assistantHasContent
	}

	public async handleEmptyAssistantResponse(params: {
		modelInfo: any
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: any
	}): Promise<boolean> {
		const reqId = this.dependencies.getApiRequestIdSafe()

		telemetryService.captureProviderApiError({
			ulid: this.dependencies.ulid,
			model: params.model.id,
			provider: params.providerId,
			errorMessage: "empty_assistant_message",
			requestId: reqId,
			isNativeToolCall: this.dependencies.taskState.useNativeToolCalls,
		})

		const baseErrorMessage =
			"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that Dirac cannot process. Retrying the request may help resolve this issue."
		const errorText = reqId ? `${baseErrorMessage} (Request ID: ${reqId})` : baseErrorMessage

		await this.dependencies.say("error", errorText)
		await this.dependencies.messageStateHandler.addToApiConversationHistory({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Failure: I did not provide a response.",
				},
			],
			modelInfo: params.modelInfo,
			id: this.dependencies.streamHandler.requestId,
			metrics: {
				tokens: {
					prompt: params.taskMetrics.inputTokens,
					completion: params.taskMetrics.outputTokens,
					cached: (params.taskMetrics.cacheWriteTokens ?? 0) + (params.taskMetrics.cacheReadTokens ?? 0),
				},
				cost: params.taskMetrics.totalCost,
			},
			ts: Date.now(),
		})

		let response: DiracAskResponse
		const noResponseErrorMessage = "No assistant message was received. Would you like to retry the request?"

		if (this.dependencies.taskState.autoRetryAttempts < 3) {
			this.dependencies.taskState.autoRetryAttempts++
			const delay = 2000 * 2 ** (this.dependencies.taskState.autoRetryAttempts - 1)
			response = "yesButtonClicked"
			await this.dependencies.say(
				"error_retry",
				JSON.stringify({
					attempt: this.dependencies.taskState.autoRetryAttempts,
					maxAttempts: 3,
					delaySeconds: delay / 1000,
					errorMessage: noResponseErrorMessage,
				}),
			)
			await setTimeoutPromise(delay)
		} else {
			await this.dependencies.say(
				"error_retry",
				JSON.stringify({
					attempt: 3,
					maxAttempts: 3,
					delaySeconds: 0,
					failed: true,
					errorMessage: noResponseErrorMessage,
				}),
			)
			const askResult = await this.dependencies.ask("api_req_failed", noResponseErrorMessage)
			response = askResult.response
			if (response === "yesButtonClicked") {
				this.dependencies.taskState.autoRetryAttempts = 0
			}
		}

		if (response === "yesButtonClicked") {
			return false
		}

		return true
	}

	public async presentAssistantMessage() {
		if (this.dependencies.taskState.abort) {
			throw new Error("Dirac instance aborted")
		}

		if (this.dependencies.taskState.presentAssistantMessageLocked) {
			this.dependencies.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}

		this.dependencies.taskState.presentAssistantMessageLocked = true
		this.dependencies.taskState.presentAssistantMessageHasPendingUpdates = false

		let block: any
		try {
			if (
				this.dependencies.taskState.currentStreamingContentIndex >=
				this.dependencies.taskState.assistantMessageContent.length
			) {
				if (this.dependencies.taskState.didCompleteReadingStream) {
					this.dependencies.taskState.userMessageContentReady = true
				}
				return
			}

			block = cloneDeep(
				this.dependencies.taskState.assistantMessageContent[this.dependencies.taskState.currentStreamingContentIndex],
			)
			switch (block.type) {
				case "text": {
					if (this.dependencies.taskState.didRejectTool) {
						break
					}
					let content = block.content
					if (content) {
						content = content.replace(/<function_calls>\s?/g, "")
						content = content.replace(/\s?<\/function_calls>/g, "")

						const lastOpenBracketIndex = content.lastIndexOf("<")
						if (lastOpenBracketIndex !== -1) {
							const possibleTag = content.slice(lastOpenBracketIndex)
							const hasCloseBracket = possibleTag.includes(">")
							if (!hasCloseBracket) {
								let tagContent: string
								if (possibleTag.startsWith("</")) {
									tagContent = possibleTag.slice(2).trim()
								} else {
									tagContent = possibleTag.slice(1).trim()
								}
								const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
								const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
								if (isOpeningOrClosing || isLikelyTagName) {
									content = content.slice(0, lastOpenBracketIndex).trim()
								}
							}
						}
					}

					if (!block.partial) {
						const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
						if (match) {
							const matchLength = match[0].length
							content = content.trimEnd().slice(0, -matchLength)
						}
					}

					await this.dependencies.say("text", content, undefined, undefined, block.partial)
					break
				}
				case "reasoning": {
					await this.dependencies.say("reasoning", block.reasoning, undefined, undefined, block.partial)
					break
				}
				case "tool_use":
					if (this.dependencies.taskState.initialCheckpointCommitPromise) {
						if (!READ_ONLY_TOOLS.includes(block.name as any)) {
							await this.dependencies.taskState.initialCheckpointCommitPromise
							this.dependencies.taskState.initialCheckpointCommitPromise = undefined
						}
					}
					await this.dependencies.toolExecutor.executeTool(block)
					if (block.call_id) {
						Session.get().updateToolCall(block.call_id, block.name)
					}
					break
			}
		} finally {
			this.dependencies.taskState.presentAssistantMessageLocked = false
		}

		if (block && (!block.partial || this.dependencies.taskState.didRejectTool)) {
			if (
				this.dependencies.taskState.currentStreamingContentIndex ===
				this.dependencies.taskState.assistantMessageContent.length - 1
			) {
				this.dependencies.taskState.userMessageContentReady = true
			}
			this.dependencies.taskState.currentStreamingContentIndex++
			if (
				this.dependencies.taskState.currentStreamingContentIndex <
				this.dependencies.taskState.assistantMessageContent.length
			) {
				await this.presentAssistantMessage()
				return
			}
		}

		if (this.dependencies.taskState.presentAssistantMessageHasPendingUpdates) {
			await this.presentAssistantMessage()
		}
	}

	public async processNativeToolCalls(assistantTextOnly: string, toolBlocks: ToolUse[]) {
		if (!toolBlocks?.length) {
			return
		}
		const prevLength = this.dependencies.taskState.assistantMessageContent.length

		const parsedBlocks = parseAssistantMessageV2(assistantTextOnly)
		parsedBlocks.forEach((block) => {
			if (block.type === "text" || block.type === "reasoning") {
				block.partial = false
			}
		})

		const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
		const lastMessage = diracMessages.at(-1)

		if (
			lastMessage?.partial &&
			lastMessage.type === "say" &&
			(lastMessage.say === "text" || lastMessage.say === "reasoning")
		) {
			const correspondingBlock = [...parsedBlocks].reverse().find((b) => b.type === lastMessage.say)
			if (correspondingBlock) {
				const content =
					correspondingBlock.type === "text"
						? correspondingBlock.content
						: correspondingBlock.type === "reasoning"
							? correspondingBlock.reasoning
							: ""
				lastMessage.text = content
				lastMessage.partial = false
				await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				const protoMessage = convertDiracMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage)
			}
		}

		this.dependencies.taskState.assistantMessageContent = [...parsedBlocks, ...toolBlocks]

		if (toolBlocks.length > 0) {
			this.dependencies.taskState.currentStreamingContentIndex = parsedBlocks.length
			this.dependencies.taskState.userMessageContentReady = false
		} else if (this.dependencies.taskState.assistantMessageContent.length > prevLength) {
			this.dependencies.taskState.userMessageContentReady = false
		}
	}
}
