import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { Logger } from "@shared/services/Logger"
import { AssistantMessageContent, parseAssistantMessageV2 } from "@core/assistant-message"
import { CardStatus, DiracApiReqCancelReason, TaskStatus } from "@shared/ExtensionMessage"

import { telemetryService } from "@services/telemetry"
import { Session } from "@shared/services/Session"
import { READ_ONLY_TOOLS, DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { ToolSkippedByUserMessage } from "./tools/types/ToolSkippedByUserMessage"
import cloneDeep from "clone-deep"
import { ResponseProcessorDependencies } from "./types/response-processor"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { ParsedToolUseState } from "./StreamResponseHandler"

export class ResponseProcessor {
    private currentStreamingContentIndex = 0
    private lastProcessedContentLength = 0
    private presentAssistantMessageLocked = false
    private presentAssistantMessageHasPendingUpdates = false
    private presentAssistantMessagePromise: Promise<void> | undefined = undefined
    private pendingPresentationError?: Error

    constructor(private dependencies: ResponseProcessorDependencies) { }

    public resetStreamState() {
        this.pendingPresentationError = undefined
        this.currentStreamingContentIndex = 0
        this.lastProcessedContentLength = 0
        this.presentAssistantMessageLocked = false
        this.presentAssistantMessageHasPendingUpdates = false
    }

    public async consumeStream(
        streamCoordinator: StreamChunkCoordinator,
        callbacks: {
            abortStream: (reason: DiracApiReqCancelReason) => Promise<void>
            finalizePendingReasoningMessage: (thinking: string) => Promise<boolean>
            apiAbort: () => void
        }
    ): Promise<{
        assistantMessage: string
        assistantTextOnly: string
        assistantTextSignature?: string
        assistantMessageId: string
        shouldInterruptStream: boolean
        didFinalizeReasoningForUi: boolean
    }> {
        let assistantMessageId = ""
        let assistantMessage = ""
        let assistantTextOnly = ""
        let assistantTextSignature: string | undefined
        let didFinalizeReasoningForUi = false
        let shouldInterruptStream = false

        const { toolUseHandler, reasonsHandler } = this.dependencies.streamHandler.getHandlers()

        while (true) {
            const chunk = await streamCoordinator.nextChunk()
            if (!chunk) {
                break
            }
            if (!this.dependencies.taskState.taskFirstTokenTimeMs) {
                this.dependencies.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.dependencies.taskState.taskStartTimeMs)
            }

            switch (chunk.type) {
                case "reasoning": {
                    const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
                    this.dependencies.streamHandler.processReasoningDelta({
                        id: chunk.id,
                        reasoning: chunk.reasoning,
                        signature: chunk.signature,
                        details,
                        redacted_data: chunk.redacted_data,
                    })

                    await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())
                    break
                }
                case "tool_calls": {
                    this.dependencies.streamHandler.processToolUseDelta(
                        {
                            id: chunk.tool_call.function?.id,
                            type: "tool_use",
                            name: chunk.tool_call.function?.name,
                            input: chunk.tool_call.function?.arguments,
                            signature: chunk?.signature,
                        },
                        chunk.tool_call.call_id,
                    )
                    if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
                        this.dependencies.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
                    }

                    await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())
                    break
                }
                case "text": {
                    const currentReasoning = reasonsHandler.getCurrentReasoning()
                    if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
                        const finalizedReasoning = await callbacks.finalizePendingReasoningMessage(currentReasoning.thinking)
                        if (finalizedReasoning) {
                            didFinalizeReasoningForUi = true
                        }
                    }
                    if (chunk.signature) {
                        assistantTextSignature = chunk.signature
                    }
                    this.dependencies.streamHandler.processTextDelta(chunk)

                    if (chunk.id) {
                        assistantMessageId = chunk.id
                    }
                    assistantMessage += chunk.text
                    assistantTextOnly += chunk.text
                    const prevLength = this.dependencies.taskState.assistantMessageContent.length

                    await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())

                    if (this.dependencies.taskState.assistantMessageContent.length > prevLength) {
                        this.dependencies.taskState.userMessageContentReady = false
                    }
                    break
                }
            }
            this.presentAssistantMessage().catch((error) => {
                Logger.error("[Task] Presentation error during streaming:", error)
                this.pendingPresentationError = error
            })

            if (this.dependencies.taskState.abort) {
                callbacks.apiAbort()
                if (!this.dependencies.taskState.abandoned) {
                    await callbacks.abortStream("user_cancelled")
                }
                shouldInterruptStream = true
                break
            }

            if (this.dependencies.taskState.didRejectTool) {
                assistantMessage += "\n\n[Response interrupted by user feedback]"
                shouldInterruptStream = true
                break
            }
        }

        return {
            assistantMessage,
            assistantTextOnly,
            assistantTextSignature,
            assistantMessageId,
            shouldInterruptStream,
            didFinalizeReasoningForUi,
        }
    }

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

        const { reasonsHandler } = this.dependencies.streamHandler.getHandlers()
        const assistantContent = this.dependencies.streamHandler.getOrderedBlocks()
        const assistantHasContent =

            assistantContent.length > 0 || params.assistantMessage.length > 0

        if (assistantHasContent) {
            telemetryService.captureConversationTurnEvent(
                this.dependencies.ulid,
                params.providerId,
                params.modelId,
                "assistant",
                params.mode as any,
                params.taskMetrics,
                this.dependencies.taskState.useNativeToolCalls,
            )

            const requestId = this.dependencies.streamHandler.requestId

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

        const partialToolBlocks = params.toolUseHandler.getParsedToolUseStates(true)
        await this.syncStreamState(params.assistantTextOnly, partialToolBlocks, true)

        if (this.pendingPresentationError) {
            const err = this.pendingPresentationError
            this.pendingPresentationError = undefined
            throw err
        }
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

        const card = await this.dependencies.taskMessenger.createCard({
            header: "API Error",
            body: errorText,
            status: CardStatus.ERROR,
        })
        await card.finalize(CardStatus.ERROR)

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

        if (this.dependencies.taskState.emptyResponseRetryAttempts < 3) {
            this.dependencies.taskState.emptyResponseRetryAttempts++
            const delay = 2000 * 2 ** (this.dependencies.taskState.emptyResponseRetryAttempts - 1)
            response = DiracAskResponse.APPROVE

            const card = await this.dependencies.taskMessenger.createCard({
                header: "Auto-Retry",
                body: JSON.stringify({
                    attempt: this.dependencies.taskState.emptyResponseRetryAttempts,
                    maxAttempts: 3,
                    delaySeconds: delay / 1000,
                    errorMessage: noResponseErrorMessage,
                }),
                status: CardStatus.PENDING,
            })

            await setTimeoutPromise(delay)
            await card.finalize(CardStatus.SUCCESS)
        } else {
            const cardHandle = await this.dependencies.taskMessenger.createCard({
                header: "Auto-Retry Failed",
                body: JSON.stringify({
                    attempt: 3,
                    maxAttempts: 3,
                    delaySeconds: 0,
                    failed: true,
                    errorMessage: noResponseErrorMessage,
                }),
                status: CardStatus.ERROR,
                requireApproval: true,
                actions: [
                    { label: "Retry", value: DiracAskResponse.APPROVE, primary: true },
                    { label: "Cancel", value: DiracAskResponse.REJECT },
                ],
            })

            try {
                const askResult = await cardHandle.waitForInteraction()
                response = askResult.response
            } catch (error) {
                if (error instanceof ToolSkippedByUserMessage) {
                    await cardHandle.finalize(CardStatus.CANCELLED)
                    this.dependencies.taskState.pendingUserMessage = error.userMessage
                    this.dependencies.taskState.pendingUserImages = error.userImages
                    this.dependencies.taskState.pendingUserFiles = error.userFiles
                    return false // retry with pending user message
                }
                throw error
            }
            await cardHandle.finalize(response === DiracAskResponse.APPROVE ? CardStatus.SUCCESS : CardStatus.CANCELLED)
            if (response === DiracAskResponse.APPROVE) {
                this.dependencies.taskState.emptyResponseRetryAttempts = 0
            }
        }

        if (response === DiracAskResponse.APPROVE) {
            return false
        }

        return true
    }


    public async presentAssistantMessage() {
        if (this.presentAssistantMessageLocked) {
            this.presentAssistantMessageHasPendingUpdates = true
            return this.presentAssistantMessagePromise
        }

        this.presentAssistantMessagePromise = (async () => {
            this.presentAssistantMessageLocked = true

            try {
                do {
                    this.presentAssistantMessageHasPendingUpdates = false

                    if (this.dependencies.taskState.abort) {
                        throw new Error("Dirac instance aborted")
                    }

                    while (this.currentStreamingContentIndex < this.dependencies.taskState.assistantMessageContent.length) {
                        const block = cloneDeep(this.dependencies.taskState.assistantMessageContent[this.currentStreamingContentIndex])

                        const isBlockComplete =
                            block.isComplete ||
                            ((this.currentStreamingContentIndex < this.dependencies.taskState.assistantMessageContent.length - 1 &&
                                this.dependencies.taskState.assistantMessageContent[this.currentStreamingContentIndex + 1].type !== "text") ||
                                !this.dependencies.taskState.isApiRequestActive)

                        switch (block.type) {
                            case "text": {
                                if (!isBlockComplete) {
                                    this.dependencies.taskState.status = TaskStatus.STREAMING_TEXT
                                }

                                if (this.dependencies.taskState.didRejectTool) {
                                    break
                                }
                                let content = block.content
                                if (content) {
                                    content = this.sanitizeModelQuirks(content)
                                }
                                if (isBlockComplete) {
                                    const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
                                    if (match) {
                                        const matchLength = match[0].length
                                        content = content.trimEnd().slice(0, -matchLength)
                                    }
                                }

                                const delta = content.slice(this.lastProcessedContentLength)
                                if (delta) {
                                    await this.dependencies.assistantStreamManager.handleChunk(delta, "text")
                                    this.lastProcessedContentLength += delta.length
                                }
                                break
                            }
                            case "reasoning": {
                                if (!isBlockComplete) {
                                    this.dependencies.taskState.status = TaskStatus.THINKING
                                }

                                const delta = block.reasoning.slice(this.lastProcessedContentLength)
                                if (delta) {
                                    await this.dependencies.assistantStreamManager.handleChunk(delta, "reasoning")
                                    this.lastProcessedContentLength += delta.length
                                }
                                break
                            }
                            case "tool_use":
                                if (!isBlockComplete) {
                                    this.dependencies.taskState.status = TaskStatus.BUILDING_TOOL_CALL
                                } else {
                                    this.dependencies.taskState.status = TaskStatus.EXECUTING_TOOL
                                }

                                await this.dependencies.postStateToWebview()
                                await this.dependencies.assistantStreamManager.pauseForToolCall()

                                if (this.dependencies.taskState.initialCheckpointCommitPromise) {
                                    if (!READ_ONLY_TOOLS.includes(block.name as any)) {
                                        await this.dependencies.taskState.initialCheckpointCommitPromise
                                        this.dependencies.taskState.initialCheckpointCommitPromise = undefined
                                    }
                                }
                                await this.dependencies.toolExecutor.executeTool(block, isBlockComplete)
                                if (block.call_id) {
                                    Session.get().updateToolCall(block.call_id, block.name)
                                }
                                break
                        }

                        if (isBlockComplete || this.dependencies.taskState.didRejectTool) {
                            this.currentStreamingContentIndex++
                            this.lastProcessedContentLength = 0
                        } else {
                            break
                        }
                    }

                    if (
                        this.currentStreamingContentIndex >= this.dependencies.taskState.assistantMessageContent.length &&
                        this.dependencies.taskState.didCompleteReadingStream
                    ) {
                        this.dependencies.taskState.userMessageContentReady = true
                    }

                } while (this.presentAssistantMessageHasPendingUpdates)
            } finally {
                this.presentAssistantMessageLocked = false
                this.presentAssistantMessagePromise = undefined
            }
        })()

        return this.presentAssistantMessagePromise
    }


    public async syncStreamState(
        assistantTextOnly: string,
        toolBlocks: ParsedToolUseState[] = [],
        isStreamComplete: boolean = false,
    ) {

        const prevLength = this.dependencies.taskState.assistantMessageContent.length

        const orderedBlocks = this.dependencies.streamHandler.getOrderedBlocks()
        const assistantMessageContent: AssistantMessageContent[] = []

        for (const block of orderedBlocks) {
            switch (block.type) {
                case "text": {
                    const parsed = parseAssistantMessageV2(block.text, !isStreamComplete)
                    for (const p of parsed) {
                        if (p.type === "text") {
                            assistantMessageContent.push({
                                type: "text",
                                content: p.content,
                                isComplete: p.isComplete || isStreamComplete,
                                signature: block.signature,
                                call_id: block.call_id,
                            })
                        } else if (p.type === "reasoning") {
                            assistantMessageContent.push({
                                type: "reasoning",
                                reasoning: p.reasoning,
                                isComplete: p.isComplete || isStreamComplete,
                                signature: block.signature,
                                call_id: block.call_id,
                            })
                        }
                    }
                    break
                }
                case "tool_use": {
                    assistantMessageContent.push({
                        type: "tool_use",
                        name: block.name as DiracDefaultTool,
                        params: block.input as any,
                        signature: block.signature,
                        isNativeToolCall: true,
                        call_id: block.call_id,
                        id: block.id,
                        isComplete: isStreamComplete || (block as any).isComplete,
                    })
                    break
                }
                case "thinking": {
                    assistantMessageContent.push({
                        type: "reasoning",
                        reasoning: block.thinking,
                        signature: block.signature,
                        isComplete: isStreamComplete || (block as any).isComplete,
                        call_id: block.call_id,
                    })
                    break
                }
                case "redacted_thinking": {
                    assistantMessageContent.push({
                        type: "reasoning",
                        reasoning: "",
                        redacted: true,
                        data: block.data,
                        isComplete: isStreamComplete,
                        call_id: block.call_id,
                    })
                    break
                }
            }
        }

        this.dependencies.taskState.assistantMessageContent = assistantMessageContent

        if (this.dependencies.taskState.assistantMessageContent.length > prevLength || toolBlocks.length > 0) {
            this.dependencies.taskState.userMessageContentReady = false
        }
    }

    private sanitizeModelQuirks(content: string): string {
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
        return content
    }
}
