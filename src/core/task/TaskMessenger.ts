import { ApiHandler } from "@core/api"

import { executeHook } from "@core/hooks/hook-executor"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import {
	Card,
	CardKind,
	CardParams,
	CardStatus,
	DiracApiReqInfo,
	DiracMessage,
	DiracMessageType,
	ICardHandle,
	ITaskMessenger,
	ITextStreamHandle,
	isFinalStatus,
	TaskStatus,
} from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import { getTaskHookModelContext } from "./runtime/TaskRuntimeModelContext"
import { clearAskResponse } from "./TaskUserInput"
import { TaskMessengerDependencies, type TaskInteractionRequest } from "./types/task-messenger"
import { ResponseOperation, type ResponseArguments } from "@shared/responseTool"
import Mutex from "p-mutex"

interface TaskCardParams extends CardParams {
	permissionRequestKind?: TaskInteractionRequest["permissionRequestKind"]
	permissionOperation?: TaskInteractionRequest["permissionOperation"]
	utilityPermissionEscalation?: TaskInteractionRequest["utilityPermissionEscalation"]
	utilityPermissionSkipped?: TaskInteractionRequest["utilityPermissionSkipped"]
	toolCall?: TaskInteractionRequest["toolCall"]
	isAutoApproved?: () => boolean
}

export interface TaskCardHandle extends ICardHandle {
	getCard(): Readonly<Card>
	waitForInteraction(signal?: AbortSignal): ReturnType<ICardHandle["waitForInteraction"]>
}

/** Cleanup/persistence failed: the owner must retain this failure through shutdown. */
export class TaskletEscalationCleanupError extends Error {
	constructor(cause: unknown) {
		super("Tasklet escalation cleanup or persistence failed", { cause })
		this.name = "TaskletEscalationCleanupError"
	}
}

export class TaskMessenger implements ITaskMessenger {
	private activeVoiceStream?: ITextStreamHandle
	private lastMessageId = 0
	private ownerWaitCount = 0
	private statusBeforeOwnerWait?: TaskStatus
	private communicationProjectionMutex = new Mutex()

	constructor(private dependencies: TaskMessengerDependencies) { }

	get routesToOwner(): boolean {
		return this.dependencies.counterparty !== undefined
	}

	private async publishCommunicationCard(card: Readonly<Card>): Promise<void> {
		if (card.communication) await this.dependencies.counterparty?.publishCommunicationCard?.(card)
	}

	/** Upserts an observational copy, with no buttons, approval, or input routing. */
	async upsertCommunicationCard(actor: string, card: Readonly<Card>): Promise<void> {
		if (this.routesToOwner) throw new Error("Only a root messenger may project child communication")
		const id = `${actor}:${card.id}`
		const snapshot: Card = {
			id,
			kind: CardKind.GENERIC,
			header: card.header,
			toolName: card.toolName,
			icon: card.icon,
			status: card.status,
			renderType: card.renderType === "markdown" ? "markdown" : "text",
			body: card.body,
			communication: { actor, detail: card.communication?.detail },
			taskletReceipt: card.taskletReceipt ? structuredClone(card.taskletReceipt) : undefined,
			collapsed: true,
			startTime: card.startTime,
			endTime: card.endTime,
		}
		const messages = this.dependencies.messageStateHandler
		await this.communicationProjectionMutex.withLock(async () => {
			if (messages.findMessageIndexByCardId(id) === -1) {
				await messages.addToDiracMessages({
					id,
					ts: snapshot.startTime ?? Date.now(),
					content: { type: DiracMessageType.CARD, card: snapshot },
				})
			} else {
				await messages.patchCardById(id, snapshot)
			}
		})
		this.scheduleStatePublication()
		if (isFinalStatus(card.status)) await messages.flushPendingWrites()
	}

	async recordResponse(response: ResponseArguments): Promise<void> {
		// Requests are retained at their wait boundary; completion is published only
		// after the host settles execution and persistence, never from an attempt.
		if (response.operation !== ResponseOperation.PROGRESS) return
		await this.dependencies.counterparty?.recordResponse(response)
	}

	/** One user decision for one retained child request; never changes permission settings. */
	async escalateTaskletInteraction(
		child: { id: string; title: string },
		request: TaskInteractionRequest,
		signal: AbortSignal,
	): ReturnType<ICardHandle["waitForInteraction"]> {
		if (this.routesToOwner) throw new Error("Only a root messenger may escalate tasklet interactions")
		const cancellation = AbortSignal.any([signal, this.dependencies.taskState.abortSignal])
		cancellation.throwIfAborted()
		let handle: TaskCardHandle | undefined
		let finalization: Promise<void> | undefined
		const finalize = (status: CardStatus) => {
			if (handle)
				finalization ??= handle.finalize(status).catch((error) => {
					throw new TaskletEscalationCleanupError(error)
				})
			return finalization
		}
		const cancel = () => {
			// Observe immediately, then await the same cleanup before returning below.
			void finalize(CardStatus.CANCELLED)?.catch(() => { })
		}
		cancellation.addEventListener("abort", cancel, { once: true })
		try {
			const card = structuredClone(request.card)
			handle = await this.createCard({
				kind: card.kind,
				header: `${child.id} · Your ${card.requireApproval ? "approval" : "input"} needed`,
				toolName: card.toolName,
				icon: card.icon,
				status: CardStatus.WAITING_FOR_INPUT,
				renderType: card.renderType,
				body: [
					card.body || card.header,
					request.utilityPermissionEscalation ? `Utility escalated: ${request.utilityPermissionEscalation}` : undefined,
					request.utilityPermissionSkipped ? `Utility not consulted: ${request.utilityPermissionSkipped}` : undefined,
				].filter(Boolean).join("\n\n"),
				rawInput: card.rawInput,
				architectureReference: card.architectureReference,
				diffs: card.diffs,
				locations: card.locations,
				requireApproval: card.requireApproval,
				approvalScope: card.requireApproval ? "once" : undefined,
				requireFeedback: card.requireFeedback,
				feedbackPlaceholder: card.feedbackPlaceholder,
				actions: card.actions,
				autoScroll: card.autoScroll,
				collapsed: false,
				maxHeight: card.maxHeight,
			}).catch((error) => {
				// Admission may have persisted a card before failing; do not report this as ordinary cancellation.
				throw new TaskletEscalationCleanupError(error)
			})
			cancellation.throwIfAborted()
			const result = await handle.waitForInteraction(cancellation)
			cancellation.throwIfAborted()
			if ((request.permissionOperation || request.permissionRequestKind) && result.userEdits !== undefined) {
				throw new Error("Tasklet permission approval cannot change the requested operation")
			}
			const rejected = result.action === DiracAskResponse.REJECT || result.response === DiracAskResponse.REJECT
			const approved = result.action === DiracAskResponse.APPROVE || result.response === DiracAskResponse.APPROVE
			await handle.update({
				header: `${child.id} · ${rejected ? "Declined by you" : card.requireApproval && approved ? "Approved by you" : "Your response recorded"}`,
				collapsed: true,
			}).catch((error) => { throw new TaskletEscalationCleanupError(error) })
			await finalize(rejected ? CardStatus.CANCELLED : CardStatus.SUCCESS)
			cancellation.throwIfAborted()
			return result
		} catch (error) {
			await finalize(CardStatus.CANCELLED)
			if (handle) await handle.update({ header: `${child.id} · Request cancelled`, collapsed: true })
				.catch((updateError) => { throw new TaskletEscalationCleanupError(updateError) })
			throw error
		} finally {
			cancellation.removeEventListener("abort", cancel)
			await finalization
		}
	}

	private async waitForOwnerInteraction(request: TaskInteractionRequest, signal: AbortSignal) {
		const state = this.dependencies.taskState
		signal.throwIfAborted()
		if (this.ownerWaitCount++ === 0) this.statusBeforeOwnerWait = state.status
		state.status = TaskStatus.AWAITING_USER_INPUT
		try {
			await this.dependencies.messageStateHandler.flushPendingWrites()
			signal.throwIfAborted()
			return await this.dependencies.counterparty!.requestInteraction(request, signal)
		} finally {
			if (--this.ownerWaitCount === 0) {
				if (!state.abort && this.statusBeforeOwnerWait !== undefined) state.status = this.statusBeforeOwnerWait
				this.statusBeforeOwnerWait = undefined
			}
		}
	}

	private postPresentationToWebview(): Promise<void> {
		return (this.dependencies.postPresentationToWebview ?? this.dependencies.postStateToWebview)()
	}

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
			content: {
				type: DiracMessageType.MARKDOWN,
				content: "",
				isReasoning,
				role: "assistant",
			},
		}
		this.dependencies.taskState.attachVoiceStream(id)
		await this.dependencies.messageStateHandler.addToDiracMessages(message)
		await this.postPresentationToWebview()

		const handle: ITextStreamHandle = {
			id,
			append: async (chunk: string) => {
				await this.dependencies.messageStateHandler.appendMarkdownById(id, chunk)
				await this.postPresentationToWebview()
			},
			setImages: async (images: string[]) => {
				await this.dependencies.messageStateHandler.patchMarkdownById(id, {
					images,
				})
				await this.postPresentationToWebview()
			},
			setFiles: async (files: string[]) => {
				await this.dependencies.messageStateHandler.patchMarkdownById(id, {
					files,
				})
				await this.postPresentationToWebview()
			},
			close: async () => {
				if (this.dependencies.taskState.activeVoiceStreamId === id) {
					const current = this.dependencies.messageStateHandler.getMessageById(id)
					if (current?.content.type === DiracMessageType.MARKDOWN) {
						await this.dependencies.messageStateHandler.patchMessageById(id, {
							content: { ...current.content },
						})
					}
					this.dependencies.taskState.detachVoiceStream(id)
					await this.postPresentationToWebview()
				}

				if (this.activeVoiceStream === handle) {
					this.activeVoiceStream = undefined
				}
			},
		}

		this.activeVoiceStream = handle
		return handle
	}

	private scheduleStatePublication(): void {
		void this.postPresentationToWebview().catch((error) => {
			Logger.error("Failed to publish card state:", error)
		})
	}

	async createCard(params: TaskCardParams): Promise<TaskCardHandle> {
		if (this.activeVoiceStream) {
			await this.activeVoiceStream.close()
		}

		const id = this.generateId()
		const ts = Date.now()
		const creationTime = Date.now()
		const status =
			params.status ||
			(params.requireApproval || params.requireFeedback ? CardStatus.WAITING_FOR_INPUT : CardStatus.RUNNING)
		const card: Card = {
			id,
			kind: params.kind ?? CardKind.GENERIC,
			header: params.header,
			toolName: params.toolName,
			icon: params.icon,
			status,
			renderType: params.renderType || "text",
			body: params.body || "",
			rawInput: params.rawInput,
			rawOutput: params.rawOutput,
			taskletReceipt: params.taskletReceipt,
			communication: params.communication,
			architectureReference: params.architectureReference,
			diffs: params.diffs,
			locations: params.locations,
			requireApproval: params.requireApproval,
			approvalScope: params.approvalScope,
			requireFeedback: params.requireFeedback,
			feedbackPlaceholder: params.feedbackPlaceholder,
			actions: params.actions,
			autoScroll: params.autoScroll,
			collapsed: params.collapsed,
			maxHeight: params.maxHeight,
			cleanupStrategy: params.cleanupStrategy,
			do_not_auto_collapse: params.do_not_auto_collapse,
			startTime: creationTime,
			...(isFinalStatus(status) ? { endTime: creationTime } : {}),
			outcome: params.outcome,
		}
		if (isFinalStatus(status) && card.requireApproval) card.collapsed = true
		const message: DiracMessage = {
			id,
			ts,
			content: { type: DiracMessageType.CARD, card },
		}

		await this.dependencies.messageStateHandler.addToDiracMessages(message)
		await this.publishCommunicationCard(card)
		this.scheduleStatePublication()
		if (isFinalStatus(status)) await this.dependencies.messageStateHandler.flushPendingWrites()

		const getCard = (): Readonly<Card> => {
			const index = this.dependencies.messageStateHandler.findMessageIndexByCardId(id)
			if (index === -1) throw new Error(`Card with id ${id} not found`)
			const current = this.dependencies.messageStateHandler.getDiracMessages()[index]
			if (current.content.type !== DiracMessageType.CARD) throw new Error(`Message with id ${id} is not a card`)
			return current.content.card
		}
		const getCardMessageTimestamp = (): number => {
			const index = this.dependencies.messageStateHandler.findMessageIndexByCardId(id)
			if (index === -1) throw new Error(`Card with id ${id} not found`)
			return this.dependencies.messageStateHandler.getDiracMessages()[index].ts
		}
		const autoApprovedInteraction = () => ({
			response: DiracAskResponse.APPROVE,
			action: DiracAskResponse.APPROVE,
			value: DiracAskResponse.APPROVE,
			askTs: getCardMessageTimestamp(),
		})
		const removeWaitingCard = () => {
			this.dependencies.taskState.waitingCardIds = this.dependencies.taskState.waitingCardIds.filter(
				(cardId) => cardId !== id,
			)
		}
		const ownerWaitCancellation = new AbortController()
		const updateCard = async (patch: Partial<Card>, doNotAutoCollapse?: boolean): Promise<Readonly<Card>> => {
			const current = getCard()
			const requestedStatus = patch.status
			if (isFinalStatus(current.status) && requestedStatus !== undefined && requestedStatus !== current.status) {
				throw new Error(`Card ${id} is already terminal with status ${current.status}`)
			}
			const recordedPatch: Partial<Omit<Card, "id">> = { ...patch }
			const nextStatus = recordedPatch.status ?? current.status
			if (isFinalStatus(nextStatus)) {
				recordedPatch.endTime ??= current.endTime ?? Date.now()
				if (recordedPatch.requireApproval ?? current.requireApproval) recordedPatch.collapsed = true
			}
			if (doNotAutoCollapse) recordedPatch.do_not_auto_collapse = true
			const updated = await this.dependencies.messageStateHandler.patchCardById(id, recordedPatch)
			await this.publishCommunicationCard(updated)
			if (isFinalStatus(updated.status)) {
				removeWaitingCard()
				ownerWaitCancellation.abort(new Error(`Card ${id} became terminal while waiting for interaction`))
			}
			this.scheduleStatePublication()
			return updated
		}

		const handle: TaskCardHandle = {
			id,
			getCard,
			update: async (patch: Partial<Card>) => {
				const updated = await updateCard(patch)
				if (isFinalStatus(updated.status)) await this.dependencies.messageStateHandler.flushPendingWrites()
			},
			appendBody: async (chunk: string) => {
				await this.dependencies.messageStateHandler.appendCardBodyById(id, chunk)
				await this.publishCommunicationCard(getCard())
				this.scheduleStatePublication()
			},
			finalize: async (status: CardStatus, doNotAutoCollapse?: boolean) => {
				if (!isFinalStatus(status)) throw new Error(`Card ${id} cannot finalize with nonterminal status ${status}`)
				await updateCard({ status }, doNotAutoCollapse)
				await this.dependencies.messageStateHandler.flushPendingWrites()
			},
			waitForInteraction: async (signal?: AbortSignal) => {
				signal?.throwIfAborted()
				if (this.routesToOwner) {
					const card = getCard()
					if (!(card.requireApproval || card.requireFeedback) || isFinalStatus(card.status)) {
						throw new Error(`Card ${id} is not in a state that requires interaction`)
					}
					return this.waitForOwnerInteraction(
						{
							card: structuredClone(card),
							permissionRequestKind: params.permissionRequestKind,
							permissionOperation: params.permissionOperation,
							utilityPermissionEscalation: params.utilityPermissionEscalation,
							utilityPermissionSkipped: params.utilityPermissionSkipped,
							toolCall: params.toolCall,
						},
						AbortSignal.any([
							this.dependencies.taskState.abortSignal,
							ownerWaitCancellation.signal,
							...(signal ? [signal] : []),
						]),
					)
				}
				if (params.isAutoApproved?.() === true) return autoApprovedInteraction()
				const card = getCard()
				const isAsk = !!(card.requireApproval || card.requireFeedback)
				const isFinal = isFinalStatus(card.status)

				if (isAsk && !isFinal) {
					let previousStatus: TaskStatus | undefined

					try {
						if (!this.dependencies.taskState.waitingCardIds.includes(id)) {
							this.dependencies.taskState.waitingCardIds.push(id)
						}
						try {
							await this.dependencies.messageStateHandler.flushPendingWrites()
							await this.postPresentationToWebview()
						} catch (error) {
							if (signal) throw new TaskletEscalationCleanupError(error)
							throw error
						}
						await pWaitFor(
							() =>
								this.dependencies.taskState.lastWaitingCardId === id ||
								this.dependencies.taskState.abort ||
								signal?.aborted ||
								isFinalStatus(getCard().status) ||
								params.isAutoApproved?.() === true,
							{ interval: 100 },
						)
						signal?.throwIfAborted()
						if (this.dependencies.taskState.abort) {
							throw new Error("Task aborted while waiting for card interaction")
						}
						if (isFinalStatus(getCard().status)) {
							throw new Error(`Card ${id} became terminal while waiting for interaction`)
						}
						if (params.isAutoApproved?.() === true) return autoApprovedInteraction()

						const index = this.dependencies.messageStateHandler.findMessageIndexByCardId(id)
						if (index === -1) throw new Error(`Card with id ${id} not found`)
						const activeMessage = this.dependencies.messageStateHandler.getDiracMessages()[index]
						const messageTs = activeMessage.ts
						// Registration exposes this card to clients before setup finishes. Keep any
						// response already submitted for it, including an immediate FIFO handoff.
						if (this.dependencies.taskState.askResponseCardId !== id) {
							clearAskResponse(this.dependencies.taskState)
						}
						this.dependencies.taskState.lastMessageTs = messageTs

						previousStatus = this.dependencies.taskState.status
						await this.runNotificationHook({
							event: "user_attention",
							source: "card_interaction",
							message: card.header,
							waitingForUserInput: true,
						})

						signal?.throwIfAborted()
						this.dependencies.taskState.status = TaskStatus.AWAITING_USER_INPUT
						this.dependencies.messageStateHandler.publishCardInteractionReady(id)

						await pWaitFor(
							() => {
								const response = this.dependencies.taskState.askResponse
								return !!(
									response !== undefined ||
									this.dependencies.taskState.lastMessageTs !== messageTs ||
									this.dependencies.taskState.abort ||
									signal?.aborted ||
									isFinalStatus(getCard().status) ||
									params.isAutoApproved?.()
								)
							},
							{ interval: 100 },
						)

						signal?.throwIfAborted()
						if (this.dependencies.taskState.abort) {
							throw new Error("Task aborted while waiting for card interaction")
						}
						if (isFinalStatus(getCard().status)) {
							throw new Error(`Card ${id} became terminal while waiting for interaction`)
						}

						if (this.dependencies.taskState.lastMessageTs !== messageTs) {
							throw new Error("Current card interaction promise was ignored")
						}

						const autoApproved =
							this.dependencies.taskState.askResponse === undefined && params.isAutoApproved?.() === true
						const response = autoApproved ? DiracAskResponse.APPROVE : this.dependencies.taskState.askResponse!
						const result = {
							response,
							action: autoApproved
								? DiracAskResponse.APPROVE
								: this.dependencies.taskState.askResponseAction || response,
							value: autoApproved ? DiracAskResponse.APPROVE : this.dependencies.taskState.askResponseValue,

							text: this.dependencies.taskState.askResponseText,
							images: this.dependencies.taskState.askResponseImages,
							files: this.dependencies.taskState.askResponseFiles,
							userEdits: this.dependencies.taskState.askResponseUserEdits,
							askTs: messageTs,
						}
						clearAskResponse(this.dependencies.taskState)

						// If the user sent a chat message instead of responding to the card,
						// this signals the tool should be skipped. Throw a typed error so the
						// coordinator can handle it cleanly.
						const responseText = result.text as string | undefined
						const responseImages = result.images as string[] | undefined
						const responseFiles = result.files as string[] | undefined
						const hasUserMessageContent =
							!!responseText || (responseImages?.length ?? 0) > 0 || (responseFiles?.length ?? 0) > 0
						if (result.response === DiracAskResponse.MESSAGE && hasUserMessageContent) {
							// Echo the user's message in the chat UI
							await this.upsertText(responseText ?? "", false, responseImages, responseFiles, "user")
							const { ToolSkippedByUserMessage } = await import("./tools/types/ToolSkippedByUserMessage")
							throw new ToolSkippedByUserMessage(responseText ?? "", responseImages, responseFiles)
						}

						return result
					} finally {
						if (this.dependencies.taskState.askResponseCardId === id) {
							clearAskResponse(this.dependencies.taskState)
						}
						if (!this.dependencies.taskState.abort && previousStatus !== undefined) {
							this.dependencies.taskState.status = previousStatus
						}
						removeWaitingCard()
						await this.postPresentationToWebview().catch((error) => {
							if (signal) throw new TaskletEscalationCleanupError(error)
							throw error
						})
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
		await this.postPresentationToWebview()

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
			await this.dependencies.messageStateHandler.patchApiStatusById(id, status)
			await this.postPresentationToWebview()
		} else {
			const message: DiracMessage = {
				id,
				ts: Date.now(),
				content: { type: DiracMessageType.API_STATUS, status },
			}
			await this.dependencies.messageStateHandler.addToDiracMessages(message)
			await this.postPresentationToWebview()
		}
	}

	async upsertText(
		text: string,
		isReasoning?: boolean,
		images?: string[],
		files?: string[],
		role: "user" | "assistant" = "assistant",
		agentIdentity?: { id: number; name: string },
	): Promise<void> {
		if (this.activeVoiceStream) {
			await this.activeVoiceStream.close()
		}

		// If this is a reasoning block and we already have an active stream, update it instead of creating a new message
		const activeVoiceStreamId = this.dependencies.taskState.activeVoiceStreamId
		if (isReasoning && activeVoiceStreamId) {
			const message = this.dependencies.messageStateHandler.getMessageById(activeVoiceStreamId)
			if (message?.content.type === DiracMessageType.MARKDOWN && message.content.isReasoning) {
				if (text.startsWith(message.content.content)) {
					const suffix = text.slice(message.content.content.length)
					if (suffix) await this.dependencies.messageStateHandler.appendMarkdownById(activeVoiceStreamId, suffix)
				} else if (text !== message.content.content) {
					const index = this.dependencies.messageStateHandler.findMessageIndexById(activeVoiceStreamId)
					await this.dependencies.messageStateHandler.updateDiracMessage(index, {
						content: { ...message.content, content: text },
					})
				}
				await this.postPresentationToWebview()
				return
			}
		}

		const id = this.generateId()
		const message: DiracMessage = {
			id,
			ts: Date.now(),
			content: {
				type: DiracMessageType.MARKDOWN,
				content: text,
				isReasoning,
				images,
				files,
				role,
				agentId: agentIdentity?.id,
				agentName: agentIdentity?.name,
			},
		}

		if (isReasoning) {
			this.dependencies.taskState.attachVoiceStream(id)
		}

		await this.dependencies.messageStateHandler.addToDiracMessages(message)
		await this.postPresentationToWebview()
	}

	async runNotificationHook(notification: {
		event: string
		source: string
		message: string
		waitingForUserInput: boolean
	}): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
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
				model: getTaskHookModelContext(
					this.dependencies.getRequestRuntime?.()?.api ?? this.dependencies.api!,
					this.dependencies.getWorkingConfiguration(),
				),
			})
		} catch (error) {
			Logger.error("[Notification Hook] Failed (non-fatal):", error)
		}
	}
}
