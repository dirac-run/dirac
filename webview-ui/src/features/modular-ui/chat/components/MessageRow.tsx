import { DiracAskResponse } from "@shared/WebviewMessage"
import { memo } from "react"
import { CheckpointMarker, ModularCard, ModularMarkdown } from "@/features/modular-ui"
import type { ChatRowProps } from "../types/chatRowTypes"

export const MessageRenderer = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		sendMessageFromChatRow,
		onSetQuote,
		onCancelCommand,
		onApprove,
		onReject,
		onAction,
		activeCardId,
		activeVoiceStreamId,
	}: ChatRowProps) => {
		const onAskForUpdate = async () => {
			await onCancelCommand?.()
			await new Promise((resolve) => setTimeout(resolve, 200))
			sendMessageFromChatRow?.("I'm still waiting for an update, are you stuck?", [], [])
		}

		if ("content" in message) {
			switch (message.content.type) {
				case "markdown":
					return (
						<ModularMarkdown
							content={message.content.content}
							files={message.content.files}
							images={message.content.images}
							isExpanded={isExpanded}
							isReasoning={message.content.isReasoning}
							onAskForUpdate={onAskForUpdate}
							onSetQuote={onSetQuote}
							onToggleExpand={() => onToggleExpand(message.id)}
							partial={message.id === activeVoiceStreamId}
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
					return (
						<div className="rounded-md border border-error bg-error/10 p-2 text-error">
							<strong>Protocol Error:</strong> Unknown primitive type "{(message.content as any).type}"
						</div>
					)
			}
		}

		return (
			<div className="rounded-md border border-error bg-error/10 p-2 text-error">
				<strong>Protocol Error:</strong> Message is missing "content" field.
			</div>
		)
	},
)

MessageRenderer.displayName = "MessageRenderer"
