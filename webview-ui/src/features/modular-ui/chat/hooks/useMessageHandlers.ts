import { CardKind, DiracMessageType, isFinalStatus, TaskStatus, UIActionButtonType } from "@shared/ExtensionMessage"
import { getCardKind } from "@shared/cardIdentity"
import { DiracAskResponse } from "@shared/WebviewMessage"

import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import { GoalMessageRequest } from "@shared/proto/dirac/goal"
import { AskResponseRequest, NewTaskRequest, SteerTaskRequest } from "@shared/proto/dirac/task"
import { useCallback, useRef } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useChatStore } from "@/features/chat/store/chatStore"
import { GoalServiceClient, SlashServiceClient, TaskServiceClient } from "@/shared/api/grpc-client"
import { InteractionState, useInteractionState } from "../context/InteractionStateContext"
import type { ButtonActionType } from "../utils/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"
import { showAgentsSnapshot } from "../utils/showAgentsSnapshot"
export function useMessageHandlers(chatState: ChatState): MessageHandlers {
	const { state: interactionState } = useInteractionState()
	const backgroundCommandRunning = useSettingsStore((state) => state.backgroundCommandRunning)
	const setExpandTaskHeader = useSettingsStore((state) => state.setExpandTaskHeader)
	const goal = useChatStore((state) => state.goal)
	const taskStatus = useChatStore((state) => state.taskStatus)
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
	const activeCard = useChatStore((state) => {
		const activeCardId = state.uiActionState?.activeCardId
		const activeCardIndex = activeCardId ? state.messageIndexById.get(activeCardId) : undefined
		const message = activeCardIndex === undefined ? undefined : state.diracMessages[activeCardIndex]
		return message?.content.type === DiracMessageType.CARD && !isFinalStatus(message.content.card.status)
			? message
			: undefined
	})
	const cancelInFlightRef = useRef(false)
	const sendInFlightRef = useRef(false)

	// Clear only the submitted fields, never edits made while the request was in flight.
	const clearSubmittedInput = useCallback((text?: string, images?: string[], files?: string[], quote?: string | null) => {
		if (text !== undefined) setInputValue((current) => current === text ? "" : current)
		if (images?.length) setSelectedImages((current) => current.length === images.length && current.every((image, index) => image === images[index]) ? [] : current)
		if (files?.length) setSelectedFiles((current) => current.length === files.length && current.every((file, index) => file === files[index]) ? [] : current)
		if (quote) setActiveQuote((current) => current === quote ? null : current)
	}, [setInputValue, setSelectedImages, setSelectedFiles, setActiveQuote])

	// Handle sending a message
	const handleSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			const messageToSend = text.trim()
			if (messageToSend === "/agents") {
				if (images.length > 0 || files.length > 0 || activeQuote) {
					const state = useChatStore.getState()
					state.appendLocalObservation(state.observationGeneration,
						"/agents is a local read. Remove attachments and the quote before running it; your draft has been kept.")
					return
				}
				setInputValue("")
				await showAgentsSnapshot()
				return
			}
			const hasContent = messageToSend || images.length > 0 || files.length > 0

			if (!hasContent || sendInFlightRef.current) return
			sendInFlightRef.current = true

			let finalMessage = messageToSend
			if (activeQuote) {
				const prefix = "[context] \n> "
				const formattedQuote = activeQuote
				const suffix = "\n[/context] \n\n"
				finalMessage = `${prefix} ${formattedQuote} ${suffix} ${messageToSend}`
			}
			const activeCardKind =
				activeCard?.content.type === DiracMessageType.CARD
					? getCardKind(activeCard.content.card)
					: CardKind.GENERIC
			const isPermission = (activeCard?.content.type === DiracMessageType.CARD && activeCard.content.card.requireApproval === true) ||
				(!activeCard && (uiActionState?.pendingApprovalCardIds?.length ?? 0) > 0)
			const isResumePrompt = activeCardKind === CardKind.RESUME_TASK || activeCardKind === CardKind.RESUME_COMPLETED_TASK

			try {
				setExpandTaskHeader(false)
				if (goal && (interactionState !== InteractionState.AWAITING_RESPONSE || (isPermission && !isResumePrompt))) {
					if (images.length > 0 || files.length > 0) {
						throw new Error("Goal messages currently support text only")
					}
					await GoalServiceClient.sendGoalMessage(GoalMessageRequest.create({ goalId: goal.id, message: finalMessage }))
				} else if (goal) {
					const isResume =
						activeCardKind === CardKind.RESUME_TASK ||
						activeCardKind === CardKind.RESUME_COMPLETED_TASK ||
						uiActionState?.cardButtons.some(
							(button) =>
								button.action === UIActionButtonType.UTILITY && button.value === "condense",
						) === true
					const cardId = uiActionState?.activeCardId
					if (!cardId) throw new Error(`Goal ${goal.id} interaction is missing its active card identity`)
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId,
							responseType: isResume ? DiracAskResponse.APPROVE : DiracAskResponse.MESSAGE,
							text: finalMessage,
							images,
							files,
						}),
					)
				} else
					switch (interactionState) {
						case InteractionState.IDLE:
							await TaskServiceClient.newTask(NewTaskRequest.create({ text: finalMessage, images, files }))
							break
						case InteractionState.AWAITING_RESPONSE: {
							// Guidance is independent of approval, and must not answer the FIFO permission card.
							if (isPermission && !isResumePrompt) {
								if (images.length > 0 || files.length > 0) throw new Error("Mid-turn guidance currently supports text only")
								await TaskServiceClient.steerTask(SteerTaskRequest.create({ text: finalMessage }))
								break
							}
							const isResume =
								activeCardKind === CardKind.RESUME_TASK ||
								activeCardKind === CardKind.RESUME_COMPLETED_TASK ||
								uiActionState?.cardButtons.some(
									(button) =>
										button.action === UIActionButtonType.UTILITY && button.value === "condense",
								) === true
							await TaskServiceClient.askResponse(
								AskResponseRequest.create({
									cardId: uiActionState?.activeCardId || "",
									responseType: isResume ? DiracAskResponse.APPROVE : DiracAskResponse.MESSAGE,
									text: finalMessage,
									images,
									files,
								}),
							)
							break
						}
						case InteractionState.RUNNING:
							if (images.length > 0 || files.length > 0) {
								throw new Error("Mid-turn guidance currently supports text only")
							}
							await TaskServiceClient.steerTask(SteerTaskRequest.create({ text: finalMessage }))
							break
						case InteractionState.COMPLETED:
							await TaskServiceClient.askResponse(
								AskResponseRequest.create({
									cardId: uiActionState?.activeCardId || "",
									responseType: DiracAskResponse.MESSAGE,
									text: finalMessage,
									images,
									files,
								}),
							)
							break
					}

				clearSubmittedInput(text, images, files, activeQuote)
			} catch (error) {
				console.error("[ChatView] Failed to send message:", error)
				const state = useChatStore.getState()
				state.appendLocalObservation(state.observationGeneration, `Could not send message: ${error instanceof Error ? error.message : String(error)}. Your draft has been kept.`)
			} finally {
				sendInFlightRef.current = false
			}
		},
		[
			interactionState,
			goal,
			activeQuote,
			setInputValue,
			setActiveQuote,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setExpandTaskHeader,
			uiActionState,
			activeCard,
			clearSubmittedInput,
		],
	)

	// Start a new task
	const startNewTask = useCallback(async () => {
		setActiveQuote(null)
		await TaskServiceClient.clearTask(EmptyRequest.create({}))
	}, [setActiveQuote])


	// Execute button action based on type
	const executeButtonAction = useCallback(
		async (
			actionType: ButtonActionType,
			value?: string,
			text?: string,
			images?: string[],
			files?: string[],
			cardId?: string,
			commandApprovalChoiceId?: string,
		) => {
			const trimmedInput = text?.trim()
			const hasContent = trimmedInput || (images && images.length > 0) || (files && files.length > 0)
			if (trimmedInput === "/agents" &&
				(actionType === DiracAskResponse.APPROVE || actionType === DiracAskResponse.REJECT ||
					actionType === "proceed" || actionType === "retry" || actionType === "utility")) {
				await handleSendMessage(trimmedInput, images ?? [], files ?? [])
				return
			}

			const finalCardId = cardId || uiActionState?.activeCardId || ""
			const clearInputState = () => {
				if (hasContent) clearSubmittedInput(text, images, files)
			}
			const isResumeCard = activeCard?.id === finalCardId && activeCard?.content.type === DiracMessageType.CARD &&
				[CardKind.RESUME_TASK, CardKind.RESUME_COMPLETED_TASK].includes(getCardKind(activeCard.content.card))

			if (commandApprovalChoiceId !== undefined || (finalCardId && !isResumeCard &&
				(actionType === DiracAskResponse.APPROVE || actionType === DiracAskResponse.REJECT))) {
				await TaskServiceClient.askResponse(
					AskResponseRequest.create({
						cardId: finalCardId,
						responseType: actionType,
						commandApprovalChoiceId,
					}),
				)
				return
			}

			// A global Resume continues the lifecycle; only addressed cards receive approval decisions.
			if (
				!finalCardId &&
				taskStatus === TaskStatus.CANCELLED &&
				(actionType === DiracAskResponse.APPROVE || actionType === "proceed" || actionType === "retry")
			) {
				await TaskServiceClient.askResponse(
					AskResponseRequest.create({
						cardId: "",
						responseType: DiracAskResponse.MESSAGE,
						text: trimmedInput,
						images,
						files,
					}),
				)
				clearInputState()
				return
			}

			switch (actionType) {
				case "retry":
					// For API retry (api_req_failed), always send simple approval without content
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							cardId: finalCardId,
							responseType: DiracAskResponse.APPROVE,
						}),
					)
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
					await startNewTask()
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
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								cardId: finalCardId,
								responseType: DiracAskResponse.APPROVE,
								value,
								text: trimmedInput,
								images,
								files,
							}),
						)
						clearInputState()
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
		[uiActionState, taskStatus, lastMessage, activeCard, clearSubmittedInput, startNewTask, backgroundCommandRunning, setSendingDisabled, handleSendMessage],
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
