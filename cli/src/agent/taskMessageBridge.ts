import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessageChange } from "@core/task/message-state"
import { Controller } from "@/core/controller"
import { CardStatus, DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger.js"
import { translateMessage } from "./messageTranslator.js"
import { handlePermissionResponse } from "./permissionHandler.js"
import type { DiracAcpSession } from "./public-types.js"
import type { AcpSessionState } from "./types.js"

type PromptResolver = (response: acp.PromptResponse) => void

type TaskMessageBridgeOptions = {
    getSession: (sessionId: string) => DiracAcpSession | undefined
    getController: (session: DiracAcpSession) => Controller | undefined
    requestPermission: (
        sessionId: string,
        toolCall: unknown,
        options?: acp.PermissionOption[],
    ) => Promise<acp.RequestPermissionResponse>
    emitSessionUpdate: (sessionId: string, update: acp.SessionUpdate) => Promise<void>
}

export class TaskMessageBridge {
    private readonly getSession: TaskMessageBridgeOptions["getSession"]
    private readonly getController: TaskMessageBridgeOptions["getController"]
    private readonly requestPermission: TaskMessageBridgeOptions["requestPermission"]
    private readonly emitSessionUpdate: TaskMessageBridgeOptions["emitSessionUpdate"]

    /** Track last sent content for partial messages to compute deltas */
    private readonly partialMessageLastContent: Map<number, string> = new Map()

    /** Map message timestamps to toolCallIds to avoid creating duplicate tool calls during streaming */
    private readonly messageToToolCallId: Map<number, string> = new Map()

    /** Track waiting cards already delivered to ACP interaction IO during the active prompt turn. */
    private readonly processedInteractionCardKeys: Set<string> = new Set()

    constructor(options: TaskMessageBridgeOptions) {
        this.getSession = options.getSession
        this.getController = options.getController
        this.requestPermission = options.requestPermission
        this.emitSessionUpdate = options.emitSessionUpdate
    }

    clearPromptState(): void {
        this.partialMessageLastContent.clear()
        this.messageToToolCallId.clear()
        this.processedInteractionCardKeys.clear()
    }

    subscribeToTaskMessages(
        controller: Controller,
        sessionId: string,
        sessionState: AcpSessionState,
        resolvePrompt: PromptResolver,
        promptResolved: { value: boolean },
        cleanupFunctions: Array<() => void>,
    ): void {
        if (!controller.task) return

        const onDiracMessagesChanged = (change: DiracMessageChange) => {
            this.handleDiracMessagesChanged(sessionId, sessionState, change, resolvePrompt, promptResolved).catch((error) => {
                Logger.debug("[DiracAgent] Error handling diracMessagesChanged:", error)
            })
        }

        controller.task.messageStateHandler.on("diracMessagesChanged", onDiracMessagesChanged)
        cleanupFunctions.push(() => controller.task?.messageStateHandler.off("diracMessagesChanged", onDiracMessagesChanged))
    }

    async replayTaskMessages(
        controller: Controller,
        sessionId: string,
        sessionState: AcpSessionState,
        resolvePrompt: PromptResolver,
        promptResolved: { value: boolean },
        startIndex = 0,
    ): Promise<void> {
        const messages = controller.task?.messageStateHandler.getDiracMessages().slice(startIndex) ?? []

        for (const message of messages) {
            await this.processMessageWithDelta(sessionId, sessionState, message)
            this.checkMessageForPromptResolution(message, resolvePrompt, promptResolved)
            if (promptResolved.value) return
        }
    }

    private async handleDiracMessagesChanged(
        sessionId: string,
        sessionState: AcpSessionState,
        change: DiracMessageChange,
        resolvePrompt: PromptResolver,
        promptResolved: { value: boolean },
    ): Promise<void> {
        Logger.debug("[DiracAgent] handleDiracMessagesChanged:", change)
        try {
            switch (change.type) {
                case "add":
                    if (change.message) {
                        await this.processMessageWithDelta(sessionId, sessionState, change.message)
                        this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
                    }
                    break

                case "update":
                    if (change.message) {
                        await this.processMessageWithDelta(sessionId, sessionState, change.message)
                        this.checkMessageForPromptResolution(change.message, resolvePrompt, promptResolved)
                    }
                    break
                case "set":
                    break
                case "delete":
                    break
            }
        } catch (error) {
            Logger.debug("[DiracAgent] Error handling diracMessagesChanged:", error)
        }
    }

    private async handlePermissionRequest(
        sessionId: string,
        sessionState: AcpSessionState,
        message: DiracMessage,
        permissionRequest: Omit<acp.RequestPermissionRequest, "sessionId">,
    ): Promise<void> {
        const session = this.getSession(sessionId)

        if (!session) {
            Logger.debug("[DiracAgent] No session found for permission request")
            return
        }

        const controller = this.getController(session)

        if (!controller?.task) {
            Logger.debug("[DiracAgent] No active task for permission request")
            return
        }

        const cardId = message.content.type === DiracMessageType.CARD ? message.content.card.id : ""

        try {
            const response = await this.requestPermission(sessionId, permissionRequest.toolCall, permissionRequest.options)

            Logger.debug("[DiracAgent] Permission response received:", response.outcome)

            const askType = "tool" as any
            const result = handlePermissionResponse(response, askType)
            if (sessionState.currentToolCallId) {
                if (result.cancelled) {
                    await this.emitSessionUpdate(sessionId, {
                        sessionUpdate: "tool_call_update",
                        toolCallId: sessionState.currentToolCallId,
                        status: "failed",
                        rawOutput: { reason: "cancelled" },
                    })
                } else if (result.response === DiracAskResponse.REJECT) {
                    await this.emitSessionUpdate(sessionId, {
                        sessionUpdate: "tool_call_update",
                        toolCallId: sessionState.currentToolCallId,
                        status: "failed",
                        rawOutput: { reason: "rejected" },
                    })
                } else {
                    await this.emitSessionUpdate(sessionId, {
                        sessionUpdate: "tool_call_update",
                        toolCallId: sessionState.currentToolCallId,
                        status: "in_progress",
                    })
                }
            }

            if (result.cancelled) {
                await controller.task.submitCardResponse(cardId, DiracAskResponse.REJECT)
            } else {
                await controller.task.submitCardResponse(cardId, result.response, result.text)
            }
        } catch (error) {
            Logger.debug("[DiracAgent] Error handling permission request:", error)

            if (sessionState.currentToolCallId) {
                await this.emitSessionUpdate(sessionId, {
                    sessionUpdate: "tool_call_update",
                    toolCallId: sessionState.currentToolCallId,
                    status: "failed",
                    rawOutput: { error: String(error) },
                })
            }

            await controller.task.submitCardResponse(cardId, DiracAskResponse.REJECT)
        }
    }

    private checkMessageForPromptResolution(
        message: DiracMessage,
        resolvePrompt: PromptResolver,
        promptResolved: { value: boolean },
    ): void {
        if (promptResolved.value) return

        if (message.content.type === DiracMessageType.CARD) {
            if (message.content.card.status === CardStatus.WAITING_FOR_INPUT) {
                promptResolved.value = true
                resolvePrompt({ stopReason: "end_turn" })
                return
            }
        }
    }

    private getInteractionCardKey(sessionId: string, message: DiracMessage): string | undefined {
        if (message.content.type !== DiracMessageType.CARD) return undefined

        const { card } = message.content
        if (card.status !== CardStatus.WAITING_FOR_INPUT) return undefined
        if (!card.requireApproval && !card.requireFeedback && !card.actions?.length) return undefined

        return `${sessionId}:${card.id}`
    }

    private async processMessageWithDelta(
        sessionId: string,
        sessionState: AcpSessionState,
        message: DiracMessage,
    ): Promise<void> {
        const messageKey = message.ts
        const lastText = this.partialMessageLastContent.get(messageKey) || ""
        const isTextStreamingMessage = message.content.type === DiracMessageType.MARKDOWN

        if (isTextStreamingMessage) {
            const content = message.content as { type: DiracMessageType.MARKDOWN; content: string; isReasoning?: boolean }
            const textContent = content.content
            const textDelta = textContent.startsWith(lastText) ? textContent.slice(lastText.length) : textContent

            if (textDelta) {
                const sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" = content.isReasoning
                    ? "agent_thought_chunk"
                    : "agent_message_chunk"

                await this.emitSessionUpdate(sessionId, {
                    sessionUpdate,
                    content: { type: "text", text: textDelta },
                })
            }

            this.partialMessageLastContent.set(messageKey, textContent)
            return
        }

        const result = translateMessage(message, sessionState)

        for (const update of result.updates) {
            await this.emitSessionUpdate(sessionId, update)
        }

        if (result.toolCallId) {
            this.messageToToolCallId.set(messageKey, result.toolCallId)
        }

        if (result.requiresPermission && result.permissionRequest) {
            const interactionCardKey = this.getInteractionCardKey(sessionId, message)

            if (interactionCardKey && this.processedInteractionCardKeys.has(interactionCardKey)) {
                Logger.debug("[DiracAgent] Skipping duplicate ACP interaction request:", interactionCardKey)
            } else {
                if (interactionCardKey) {
                    this.processedInteractionCardKeys.add(interactionCardKey)
                }
                await this.handlePermissionRequest(sessionId, sessionState, message, result.permissionRequest)
            }
        }

        if (result.toolCallId) {
            this.messageToToolCallId.delete(messageKey)
        }
    }
}
