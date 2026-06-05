import { ApiHandler } from "@core/api"

import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { executeHook } from "@core/hooks/hook-executor"

import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { Card, CardStatus, DiracApiReqInfo, DiracMessage, ICardHandle, ITextStreamHandle, DiracMessageType, ITaskMessenger, isFinalStatus, TaskStatus } from "@shared/ExtensionMessage"

import { convertDiracMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Logger } from "@shared/services/Logger"
import pWaitFor from "p-wait-for"
import { TaskMessengerDependencies } from "./types/task-messenger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { CardParams } from "./tools/interfaces/IToolEnvironment"

export class TaskMessenger implements ITaskMessenger {


    private activeVoiceStream?: ITextStreamHandle
    private lastMessageId = 0

    constructor(private dependencies: TaskMessengerDependencies) { }

    public setApi(api: ApiHandler) {
        this.dependencies.api = api
    }

    public generateId(): string {

        return `${Date.now()}-${++this.lastMessageId}`
    }

    async streamText(type: "markdown" | "reasoning"): Promise<ITextStreamHandle> {
        // Auto-close any active stream
        if (this.activeVoiceStream) {
            await this.activeVoiceStream.close()
        }

        const id = this.generateId()
        const ts = Date.now()
        const isReasoning = type === "reasoning"

        const message: DiracMessage = {
            id,
            ts,
            content: { type: DiracMessageType.MARKDOWN, content: "", isReasoning },
        }
        this.dependencies.taskState.activeVoiceStreamId = id
        await this.dependencies.messageStateHandler.addToDiracMessages(message)
        await this.dependencies.postStateToWebview()

        const handle: ITextStreamHandle = {
            id,
            append: async (chunk: string) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for append`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.MARKDOWN) {
                    msg.content.content += chunk
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a markdown message`)
                }
            },
            setImages: async (images: string[]) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for setImages`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.MARKDOWN) {
                    msg.content.images = images
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a markdown message`)
                }
            },
            setFiles: async (files: string[]) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for setFiles`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.MARKDOWN) {
                    msg.content.files = files
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a markdown message`)
                }
            },
            close: async () => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for close`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                await this.dependencies.postStateToWebview()

                if (this.dependencies.taskState.activeVoiceStreamId === id) {
                    this.dependencies.taskState.activeVoiceStreamId = undefined
                    await this.dependencies.postStateToWebview()
                }

                if (this.activeVoiceStream === handle) {
                    this.activeVoiceStream = undefined
                }
            },
        }

        this.activeVoiceStream = handle
        return handle
    }

    async createCard(params: CardParams): Promise<ICardHandle> {
        if (this.activeVoiceStream) {
            await this.activeVoiceStream.close()
        }

        const id = this.generateId()
        const ts = Date.now()

        if (params.requireApproval || params.requireFeedback) {
            this.dependencies.taskState.waitingCardIds.push(id)
        }

        const card: Card = {
            id,
            header: params.header,
            icon: params.icon,
            status: params.status || (params.requireApproval || params.requireFeedback ? CardStatus.WAITING_FOR_INPUT : CardStatus.RUNNING),
            renderType: params.renderType || "text",
            body: params.body || "",
            requireApproval: params.requireApproval,
            requireFeedback: params.requireFeedback,
            feedbackPlaceholder: params.feedbackPlaceholder,
            actions: params.actions,
            collapsed: params.collapsed,
            maxHeight: params.maxHeight,
            cleanupStrategy: params.cleanupStrategy,
            do_not_auto_collapse: params.do_not_auto_collapse,
        }

        const message: DiracMessage = {
            id,
            ts,
            content: { type: DiracMessageType.CARD, card },
        }

        await this.dependencies.messageStateHandler.addToDiracMessages(message)
        await this.dependencies.postStateToWebview()

        const handle: ICardHandle = {
            id,
            update: async (patch: Partial<Card>) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for update`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.CARD) {
                    msg.content.card = { ...msg.content.card, ...patch }
                    // Cards are never partial in the new architecture
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a card message`)
                }
            },
            appendBody: async (chunk: string) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for appendBody`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.CARD) {
                    msg.content.card.body = (msg.content.card.body || "") + chunk
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a card message`)
                }
            },
            finalize: async (status: CardStatus, doNotAutoCollapse?: boolean) => {
                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Message with id ${id} not found for finalize`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.CARD) {
                    msg.content.card.status = status
                    if (doNotAutoCollapse) {
                        msg.content.card.do_not_auto_collapse = true
                    }
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                } else {
                    throw new Error(`Message with id ${id} is not a card message`)
                }
            },
            waitForInteraction: async () => {

                const index = this.dependencies.messageStateHandler.findMessageIndexById(id)
                if (index === -1) {
                    throw new Error(`Card with id ${id} not found`)
                }
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type !== DiracMessageType.CARD) {
                    throw new Error(`Message with id ${id} is not a card`)
                }

                const card = msg.content.card
                const isAsk = !!(card.requireApproval || card.requireFeedback)
                const isFinal = isFinalStatus(card.status)

                if (isAsk && !isFinal) {
                    const previousStatus = this.dependencies.taskState.status

                    try {
                        // Ensure it's in the queue if not already
                        if (!this.dependencies.taskState.waitingCardIds.includes(id)) {
                            this.dependencies.taskState.waitingCardIds.push(id)
                        }
                        await this.dependencies.postStateToWebview()

                        const messageTs = msg.ts
                        this.dependencies.taskState.askResponse = undefined
                        this.dependencies.taskState.askResponseText = undefined
                        this.dependencies.taskState.askResponseImages = undefined
                        this.dependencies.taskState.askResponseFiles = undefined
                        this.dependencies.taskState.askResponseUserEdits = undefined
                        this.dependencies.taskState.lastMessageTs = messageTs

                        await this.runNotificationHook({
                            event: "user_attention",
                            source: "card_interaction",
                            message: card.header,
                            waitingForUserInput: true,
                        })

                        this.dependencies.taskState.status = TaskStatus.AWAITING_USER_INPUT

                        await pWaitFor(
                            () => {
                                const response = this.dependencies.taskState.askResponse
                                return response !== undefined || this.dependencies.taskState.lastMessageTs !== messageTs
                            },
                            { interval: 100 }
                        )

                        if (this.dependencies.taskState.lastMessageTs !== messageTs) {
                            throw new Error("Current card interaction promise was ignored")
                        }

                        const result = {
                            response: this.dependencies.taskState.askResponse!,
                            action: this.dependencies.taskState.askResponseAction || this.dependencies.taskState.askResponse!,
                            value: this.dependencies.taskState.askResponseValue,

                            text: this.dependencies.taskState.askResponseText,
                            images: this.dependencies.taskState.askResponseImages,
                            files: this.dependencies.taskState.askResponseFiles,
                            userEdits: this.dependencies.taskState.askResponseUserEdits,
                            askTs: messageTs,
                        }
                        // Clean up ALL response fields to prevent stale data
                        this.dependencies.taskState.askResponse = undefined
                        this.dependencies.taskState.askResponseText = undefined
                        this.dependencies.taskState.askResponseImages = undefined
                        this.dependencies.taskState.askResponseFiles = undefined
                        this.dependencies.taskState.askResponseUserEdits = undefined
                        this.dependencies.taskState.askResponseAction = undefined
                        this.dependencies.taskState.askResponseValue = undefined

                        // If the user sent a text message instead of responding to the card,
                        // this signals the tool should be skipped. Throw a typed error so the
                        // coordinator can handle it cleanly.
                        if (result.response === DiracAskResponse.MESSAGE && result.text) {
                            // Echo the user's text message in the chat UI
                            await this.upsertText(result.text, false, result.images, result.files, "user")
                            const { ToolSkippedByUserMessage } = await import("./tools/types/ToolSkippedByUserMessage")
                            throw new ToolSkippedByUserMessage(
                                result.text,
                                result.images as string[] | undefined,
                                result.files as string[] | undefined,
                            )
                        }

                        return result
                    } finally {
                        this.dependencies.taskState.status = previousStatus
                        this.dependencies.taskState.waitingCardIds = this.dependencies.taskState.waitingCardIds.filter((cid) => cid !== id)
                        await this.dependencies.postStateToWebview()
                    }
                }

                throw new Error(`Card ${id} is not in a state that requires interaction`)
            },
        }

        return handle
    }

    async createCheckpoint(): Promise<ICardHandle> {
        if (this.activeVoiceStream) {
            await this.activeVoiceStream.close()
        }

        const id = this.generateId()
        const ts = Date.now()

        const message: DiracMessage = {
            id,
            ts,
            content: { type: DiracMessageType.CHECKPOINT },
        }

        await this.dependencies.messageStateHandler.addToDiracMessages(message)
        await this.dependencies.postStateToWebview()

        const handle: ICardHandle = {
            id,
            update: async () => {
                throw new Error("Cannot update a checkpoint message")
            },
            appendBody: async () => {
                throw new Error("Cannot append body to a checkpoint message")
            },
            finalize: async () => {
                throw new Error("Cannot finalize a checkpoint message")
            },
            waitForInteraction: async () => {
                throw new Error("Checkpoint messages do not support interaction")
            },
        }

        return handle
    }


    async upsertApiStatus(status: DiracApiReqInfo): Promise<void> {
        const id = status.id || "api-status"
        const index = this.dependencies.messageStateHandler.findMessageIndexById(id)

        if (index !== -1) {
            const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
            if (msg.content.type === DiracMessageType.API_STATUS) {
                msg.content.status = {
                    ...msg.content.status,
                    ...status,
                }
                await this.dependencies.messageStateHandler.updateDiracMessage(index, msg)
                await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                await this.dependencies.postStateToWebview()
            } else {
                throw new Error(`Message with id ${id} is not an api_status message`)
            }
        } else {
            const message: DiracMessage = {
                id,
                ts: Date.now(),
                content: { type: DiracMessageType.API_STATUS, status },
            }
            await this.dependencies.messageStateHandler.addToDiracMessages(message)
            await this.dependencies.postStateToWebview()
            await sendPartialMessageEvent(convertDiracMessageToProto(message))
        }
    }

    async upsertText(text: string, isReasoning?: boolean, images?: string[], files?: string[], role?: "user" | "assistant"): Promise<void> {
        if (this.activeVoiceStream) {
            await this.activeVoiceStream.close()
        }

        // If this is a reasoning block and we already have an active stream, update it instead of creating a new message
        const activeVoiceStreamId = this.dependencies.taskState.activeVoiceStreamId
        if (isReasoning && activeVoiceStreamId) {
            const index = this.dependencies.messageStateHandler.findMessageIndexById(activeVoiceStreamId)
            if (index !== -1) {
                const msg = this.dependencies.messageStateHandler.getDiracMessages()[index]
                if (msg.content.type === DiracMessageType.MARKDOWN && msg.content.isReasoning) {
                    msg.content.content = text
                    await this.dependencies.messageStateHandler.updateDiracMessage(index, {
                        content: msg.content,
                    })
                    await sendPartialMessageEvent(convertDiracMessageToProto(msg))
                    await this.dependencies.postStateToWebview()
                    return
                }
            }
        }

        const id = this.generateId()
        const message: DiracMessage = {
            id,
            ts: Date.now(),
            content: { type: DiracMessageType.MARKDOWN, content: text, isReasoning, images, files, role },
        }

        if (isReasoning) {
            this.dependencies.taskState.activeVoiceStreamId = id
        }

        await this.dependencies.messageStateHandler.addToDiracMessages(message)
        await sendPartialMessageEvent(convertDiracMessageToProto(message))
        await this.dependencies.postStateToWebview()
    }


    async runNotificationHook(notification: {
        event: string
        source: string
        message: string
        waitingForUserInput: boolean
    }): Promise<void> {
        const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
        if (!hooksEnabled) {
            return
        }

        try {
            await executeHook({
                hookName: "Notification",
                hookInput: {
                    notification,
                },
                isCancellable: false,
                messenger: this,

                messageStateHandler: this.dependencies.messageStateHandler,
                taskId: this.dependencies.taskId,
                hooksEnabled,
                model: getHookModelContext(this.dependencies.api!, this.dependencies.stateManager),
            })
        } catch (error) {
            Logger.error("[Notification Hook] Failed (non-fatal):", error)
        }
    }



}
