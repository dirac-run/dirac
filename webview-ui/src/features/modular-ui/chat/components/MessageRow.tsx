import { memo, useEffect } from "react"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { ModularCard, ModularMarkdown, CheckpointMarker } from "@/features/modular-ui"
import { useRelinquishControl } from "@/shared/hooks/useRelinquishControl"
import { ChatRowProps } from "../types/chatRowTypes"

export const MessageRenderer = memo(
    ({
        message,
        isExpanded,
        onToggleExpand,
        lastModifiedMessage,
        isLast,
        inputValue,
        sendMessageFromChatRow,
        onSetQuote,
        onCancelCommand,
        mode,
        isRequestInProgress,
        reasoningContent: dashboardReasoningContent,
        responseStarted,
        onApprove,
        onReject,
        onAction,
        activeCardId,
        activeVoiceStreamId,

    }: ChatRowProps) => {
        const onAskForUpdate = async () => {
            await onCancelCommand?.()
            // Small delay to ensure task is re-initialized before sending message
            setTimeout(() => {
                sendMessageFromChatRow?.("I'm still waiting for an update, are you stuck?", [], [])
            }, 200)
        }

        const onRelinquishControl = useRelinquishControl()

        useEffect(() => {
            return onRelinquishControl(() => {
                // Cleanup logic if needed
            })
        }, [onRelinquishControl])

        const handleToggle = () => onToggleExpand(message.ts)

        // --- New Protocol Dispatcher ---
        if ("content" in message) {
            switch (message.content.type) {
                case "markdown":
                    return (
                        <ModularMarkdown
                            content={message.content.content}
                            isReasoning={message.content.isReasoning}
                            partial={message.id === activeVoiceStreamId}
                            isExpanded={isExpanded}
                            onToggleExpand={() => onToggleExpand(message.ts)}
                            onAskForUpdate={onAskForUpdate}
                            images={message.content.images}
                            files={message.content.files}
                            role={message.content.role}
                        />
                    )
                case "card":
                    return (
                        <ModularCard
                            card={message.content.card}
                            isActive={message.id === activeCardId}

                            onAction={(value) => {
                                if (value === DiracAskResponse.APPROVE) {
                                    onApprove?.(message.id)
                                } else if (value === DiracAskResponse.REJECT) {
                                    onReject?.(message.id)
                                } else {
                                    onAction?.(value, message.id)
                                }
                            }}
                        />
                    )
                case "api_status":
                    return null
                case "checkpoint":
                    return <CheckpointMarker message={message} />
                default:
                    // Fail hard on unknown primitive types in the new protocol
                    return (
                        <div className="p-2 border border-error bg-error/10 text-error rounded-md">
                            <strong>Protocol Error:</strong> Unknown primitive type "{(message.content as any).type}"
                        </div>
                    )
            }
        }

        // If we reach here, it means the message doesn't have the 'content' field,
        // which should be impossible according to the new DiracMessage type.
        return (
            <div className="p-2 border border-error bg-error/10 text-error rounded-md">
                <strong>Protocol Error:</strong> Message is missing "content" field.
            </div>
        )
    },
)
