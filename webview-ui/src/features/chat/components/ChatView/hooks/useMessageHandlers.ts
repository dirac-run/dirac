import type { DiracMessage } from "@shared/ExtensionMessage"
import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import { AskResponseRequest, NewTaskRequest } from "@shared/proto/dirac/task"
import { useCallback, useRef } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { SlashServiceClient, TaskServiceClient } from "@/shared/api/grpc-client"
import { useInteractionState } from "../context/InteractionStateContext"
import type { ButtonActionType } from "../shared/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"

/**
 * Custom hook for managing message handlers
 * Handles sending messages, button clicks, and task management
 */
export function useMessageHandlers(messages: DiracMessage[], chatState: ChatState): MessageHandlers {
	const { state: interactionState } = useInteractionState()
	const { backgroundCommandRunning, setExpandTaskHeader } = useSettingsStore() as any
	const {
		setInputValue,
		activeQuote,
		setActiveQuote,
		setSelectedImages,
		setSelectedFiles,
		setSendingDisabled,
		setEnableButtons,
		diracAsk,
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

			console.log(`[ChatView] handleSendMessage - State: ${interactionState}, Sending:`, finalMessage)


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
					const isResume = diracAsk === "resume_task" || diracAsk === "resume_completed_task"
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: isResume ? "yesButtonClicked" : "messageResponse",
							text: finalMessage,
							images,
							files,
						}),
					)
				} else {
					// RUNNING or COMPLETED (interruption/feedback)
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "messageResponse",
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
				setEnableButtons(false)

				if ("disableAutoScrollRef" in chatState) {
					;(chatState as any).disableAutoScrollRef.current = false
				}
			} catch (error) {
				console.error("[ChatView] Failed to send message:", error)
			}
		},
		[
			interactionState,
			backgroundCommandRunning,
			diracAsk,
			activeQuote,
			setInputValue,
			setActiveQuote,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			chatState,
			setExpandTaskHeader,
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
		async (actionType: ButtonActionType, text?: string, images?: string[], files?: string[]) => {
			const trimmedInput = text?.trim()
			const hasContent = trimmedInput || (images && images.length > 0) || (files && files.length > 0)

			switch (actionType) {
				case "retry":
					// For API retry (api_req_failed), always send simple approval without content
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "yesButtonClicked",
						}),
					)
					clearInputState()
					break
				case "approve":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "reject":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "proceed":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "new_task":
					if (diracAsk === "new_task") {
						await TaskServiceClient.newTask(
							NewTaskRequest.create({
								text: lastMessage?.text,
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
					setEnableButtons(false)
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
						setEnableButtons(true)

						// Ensure auto-scroll is re-enabled after cancellation
						if ("disableAutoScrollRef" in chatState) {
							;(chatState as any).disableAutoScrollRef.current = false
						}
					}
					break
				}

				case "utility":
					switch (diracAsk) {
						case "condense":
							await SlashServiceClient.condense(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
						case "report_bug":
							await SlashServiceClient.reportBug(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
					}
					break
				case "edit":
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "editButtonClicked",
						}),
					)
					break
				case "view":
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "viewButtonClicked",
						}),
					)
					break

			}

			if ("disableAutoScrollRef" in chatState) {
				;(chatState as any).disableAutoScrollRef.current = false
			}
		},
		[
			diracAsk,
			lastMessage,
			messages,
			clearInputState,
			handleSendMessage,
			startNewTask,
			chatState,
			backgroundCommandRunning,
			setSendingDisabled,
			setEnableButtons,
		],
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
