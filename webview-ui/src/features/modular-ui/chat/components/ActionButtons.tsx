import { type DiracMessage, type Mode, type UIActionButton, UIActionButtonType } from "@shared/ExtensionMessage"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { VirtuosoHandle } from "react-virtuoso"
import { ButtonActionType } from "../utils/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"
import { findActiveNewTaskCard } from "../../utils/newTaskCard"

interface ActionButtonsProps {
	task?: DiracMessage
	messages: DiracMessage[]
	chatState: ChatState
	messageHandlers: MessageHandlers
	mode: Mode
	scrollBehavior: {
		scrollToBottomSmooth: () => void
		disableAutoScrollRef: React.MutableRefObject<boolean>
		showScrollToBottom: boolean
		virtuosoRef: React.RefObject<VirtuosoHandle>
	}
}

const ActionButtons: React.FC<ActionButtonsProps> = ({ task, messages, chatState, messageHandlers, scrollBehavior }) => {
	const {
		inputValue,
		selectedImages,
		selectedFiles,
		setSendingDisabled,
		uiActionState,
		activeVoiceStreamId,
		isApiRequestActive,
	} = chatState
	const [isProcessing, setIsProcessing] = useState(false)

	// Memoize last messages to avoid unnecessary recalculations
	const [lastMessage, secondLastMessage] = useMemo(() => {
		const len = messages.length
		return len > 0 ? [messages[len - 1], messages[len - 2]] : [undefined, undefined]
	}, [messages])

	// Single effect to handle all configuration updates
	useEffect(() => {
		if (uiActionState) {
			setSendingDisabled(uiActionState.sendingDisabled)
		}
	}, [uiActionState, setSendingDisabled])

	// Clear input when transitioning from command_output to api_req
	// This happens when user provides feedback during command execution
	useEffect(() => {
		if (
			lastMessage?.content.type === "api_status" &&
			secondLastMessage?.content.type === "card" &&
			secondLastMessage.content.card.icon === "terminal"
		) {
			chatState.setInputValue("")
			chatState.setSelectedImages([])
			chatState.setSelectedFiles([])
		}
	}, [lastMessage, secondLastMessage, chatState])

	const handleActionClick = useCallback(
		async (action: ButtonActionType, value?: string, text?: string, images?: string[], files?: string[]) => {
			if (isProcessing) {
				return
			}
			setIsProcessing(true)

			try {
				await messageHandlers.executeButtonAction(action, value, text, images, files, uiActionState?.activeCardId)
			} catch (error) {
				console.error(`[ActionButtons] Failed to execute action ${action}:`, error)
			} finally {
				setIsProcessing(false)
			}
		},
		[messageHandlers, isProcessing, uiActionState?.activeCardId],
	)

	// Keyboard event handler
	const globalButtons = uiActionState?.globalButtons || []
	const activeNewTaskCard = findActiveNewTaskCard(messages, uiActionState?.activeCardId)
	const promotedCardButtons = activeNewTaskCard ? (uiActionState?.cardButtons ?? []) : []
	const hasActiveButtons = globalButtons.length > 0

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape" && hasActiveButtons) {
				event.preventDefault()
				event.stopPropagation()
				handleActionClick("cancel" as any)
			}
		},
		[handleActionClick, hasActiveButtons],
	)

	useEffect(() => {
		if (!hasActiveButtons) return
		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [handleKeyDown, hasActiveButtons])

	if (!task) {
		return null
	}

	const { showScrollToBottom, scrollToBottomSmooth, disableAutoScrollRef } = scrollBehavior

	const allButtons = [...promotedCardButtons, ...globalButtons]
	const hasButtons = allButtons.length > 0
	const isStreaming = isApiRequestActive || !!activeVoiceStreamId
	const canInteract = !isStreaming && !isProcessing

	// Early return for scroll button to avoid unnecessary computation
	if (!hasButtons) {
		const handleScrollToBottom = () => {
			scrollToBottomSmooth()
			disableAutoScrollRef.current = false
		}

		// Show scroll to top button when there are no action buttons
		const handleScrollToTop = () => {
			scrollBehavior.virtuosoRef.current?.scrollTo({
				top: 0,
				behavior: "smooth",
			})
			disableAutoScrollRef.current = true
			// Virtual rendering may not have all items rendered when at bottom,
			// so scroll again after a delay to ensure we reach the true top
			setTimeout(() => {
				scrollBehavior.virtuosoRef.current?.scrollTo({
					top: 0,
					behavior: "smooth",
				})
			}, 300)
		}

		return (
			<div className="flex px-3">
				<VSCodeButton
					appearance="icon"
					aria-label={showScrollToBottom ? "Scroll to bottom" : "Scroll to top"}
					className="text-lg text-(--vscode-primaryButton-foreground) bg-[color-mix(in_srgb,var(--vscode-toolbar-hoverBackground)_55%,transparent)] rounded-[3px] overflow-hidden cursor-pointer flex justify-center items-center flex-1 h-[25px] hover:bg-[color-mix(in_srgb,var(--vscode-toolbar-hoverBackground)_90%,transparent)] active:bg-[color-mix(in_srgb,var(--vscode-toolbar-hoverBackground)_70%,transparent)] border-0"
					onClick={showScrollToBottom ? handleScrollToBottom : handleScrollToTop}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault()
							if (showScrollToBottom) {
								handleScrollToBottom()
							} else {
								handleScrollToTop()
							}
						}
					}}>
					{showScrollToBottom ? (
						<span className="codicon codicon-chevron-down" />
					) : (
						<span className="codicon codicon-chevron-up" />
					)}
				</VSCodeButton>
			</div>
		)
	}

	const opacity = canInteract || isStreaming ? 1 : 0.5

	return (
		<div className="flex px-3 gap-2" style={{ opacity }}>
			{allButtons.map((button: UIActionButton, index: number) => (
				<VSCodeButton
					key={index}
					appearance={button.primary ? "primary" : "secondary"}
					className="flex-1"
					disabled={!canInteract && button.action !== UIActionButtonType.CANCEL}
					onClick={() =>
						handleActionClick(button.action as any, button.value, inputValue, selectedImages, selectedFiles)
					}>
					{button.label}
				</VSCodeButton>
			))}
		</div>
	)
}

export default ActionButtons
