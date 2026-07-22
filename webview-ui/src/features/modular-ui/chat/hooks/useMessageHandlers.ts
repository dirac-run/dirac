import { DiracAskResponse } from "@shared/WebviewMessage"

import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import { AskResponseRequest, NewTaskRequest } from "@shared/proto/dirac/task"
import { useCallback, useRef } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { SlashServiceClient, TaskServiceClient } from "@/shared/api/grpc-client"
import { useInteractionState } from "../context/InteractionStateContext"
import type { ButtonActionType } from "../utils/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"

export function useMessageHandlers(chatState: ChatState): MessageHandlers {
	const { state: interactionState } = useInteractionState()
	const backgroundCommandRunning = useSettingsStore((state) => state.backgroundCommandRunning)
	const setExpandTaskHeader = useSettingsStore((state) => state.setExpandTaskHeader)
	const {
		setInputValue,
		activeQuote,
		setActiveQuote,
		setSelectedImages,
		setSelectedFiles,
		setSendingDisabled,
		uiActionState,
		lastMessage,
	} = chatState
	const cancelInFlightRef = useRef(false)

	// Handle sending a message
	const handleSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			const messageToSend = text.trim()
			const hasContent = messageToSend || images.length > 0 || files.length > 0

			if (!hasContent) return

			let finalMessage = messageToSend
			if (activeQuote) {
				const prefix = "[context] \n> "
				const formattedQuote = activeQuote
				const suffix = "\n[/context] \n\n"
				finalMessage = `${prefix} ${formattedQuote} ${suffix} ${messageToSend}`
			}

			try {
				setExpandTaskHeader(false)
				if (interactionState === "IDLE") {
					await TaskServiceClient.newTask(
						NewTaskRequest.create({
							text: finalMessage,
							images,
							files,
						}),
					)
				} else if (interactionState === "AWAITING_RESPONSE") {
					const isResume =
						uiActionState?.cardButtons.some(
							(b) =>
								b.label.toLowerCase().includes("resume") ||
								b.label.toLowerCase().includes("start new task") ||
								b.label.toLowerCase().includes("condense"),
						) || false
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: uiActionState?.activeCardId || "",
							responseType: isResume ? DiracAskResponse.APPROVE : DiracAskResponse.MESSAGE,
							text: finalMessage,
							images,
							files,
						}),
					)
				} else {
					// RUNNING or COMPLETED (interruption/feedback)
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: uiActionState?.activeCardId || "",
							responseType: DiracAskResponse.MESSAGE,
							text: finalMessage,
							images,
							files,
						}),
					)
				}

				// Clear local input state immediately on success
				setInputValue("")
				setActiveQuote(null)
				setSendingDisabled(true)
				setSelectedImages([])
				setSelectedFiles([])
			} catch (error) {
				console.error("[ChatView] Failed to send message:", error)
			}
		},
		[
			interactionState,
			activeQuote,
			setInputValue,
			setActiveQuote,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setExpandTaskHeader,
			uiActionState,
		],
	)

	// Start a new task
	const startNewTask = useCallback(async () => {
		setActiveQuote(null)
		await TaskServiceClient.clearTask(EmptyRequest.create({}))
	}, [setActiveQuote])

	// Clear input state helper
	const clearInputState = useCallback(() => {
		setInputValue("")
		setActiveQuote(null)
		setSelectedImages([])
		setSelectedFiles([])
	}, [setInputValue, setActiveQuote, setSelectedImages, setSelectedFiles])

	// Execute button action based on type
	const executeButtonAction = useCallback(
		async (
			actionType: ButtonActionType,
			value?: string,
			text?: string,
			images?: string[],
			files?: string[],
			cardId?: string,
		) => {
			const trimmedInput = text?.trim()
			const hasContent = trimmedInput || (images && images.length > 0) || (files && files.length > 0)

			const finalCardId = cardId || uiActionState?.activeCardId || ""

			switch (actionType) {
				case "retry":
					// For API retry (api_req_failed), always send simple approval without content
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: finalCardId,
							responseType: DiracAskResponse.APPROVE,
						}),
					)
					clearInputState()
					break
				case DiracAskResponse.APPROVE:
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.APPROVE,
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.APPROVE,
							}),
						)
					}
					clearInputState()
					break

				case DiracAskResponse.REJECT:
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.REJECT,
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.REJECT,
							}),
						)
					}
					clearInputState()
					break

				case "proceed":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.APPROVE,
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.APPROVE,
							}),
						)
					}
					clearInputState()
					break

				case "new_task":
					if (
						uiActionState?.cardButtons.some(
							(b) => b.label.toLowerCase().includes("new task") || b.label.toLowerCase().includes("resume"),
						)
					) {
						const text = lastMessage?.content.type === "markdown" ? lastMessage.content.content : ""
						await TaskServiceClient.newTask(
							NewTaskRequest.create({
								text,
								images: [],
								files: [],
							}),
						)
					} else {
						await startNewTask()
					}
					break

				case "cancel": {
					if (cancelInFlightRef.current) {
						return
					}
					cancelInFlightRef.current = true
					setSendingDisabled(true)
					try {
						if (backgroundCommandRunning) {
							await TaskServiceClient.cancelBackgroundCommand(EmptyRequest.create({})).catch((err) =>
								console.error("Failed to cancel background command:", err),
							)
						}
						await TaskServiceClient.cancelTask(EmptyRequest.create({}))

						// Wait a brief moment for the backend to process the cancellation
						// and for the state to stabilize before re-enabling UI
						await new Promise((resolve) => setTimeout(resolve, 100))
					} finally {
						cancelInFlightRef.current = false
						// Explicitly reset UI state to allow immediate follow-up
						setSendingDisabled(false)
					}
					break
				}

				case "utility":
					if (value === "condense") {
						const text = lastMessage?.content.type === "markdown" ? lastMessage.content.content : ""
						await SlashServiceClient.condense(StringRequest.create({ value: text })).catch((err) =>
							console.error(err),
						)
					} else if (value) {
						// Generic utility action - send as message response
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.MESSAGE,
								text: value,
							}),
						)
					}
					break
				case DiracAskResponse.EDIT:
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: finalCardId,
							responseType: DiracAskResponse.EDIT,
						}),
					)
					break
				case DiracAskResponse.VIEW:
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: finalCardId,
							responseType: DiracAskResponse.VIEW,
						}),
					)
					break
			}
		},
		[uiActionState, lastMessage, clearInputState, startNewTask, backgroundCommandRunning, setSendingDisabled],
	)

	// Handle task close button click
	const handleTaskCloseButtonClick = useCallback(() => {
		startNewTask()
	}, [startNewTask])

	return {
		handleSendMessage,
		executeButtonAction,
		handleTaskCloseButtonClick,
		startNewTask,
	}
}
