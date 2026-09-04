import {
	type Card,
	type DiracApiReqInfo,
	type DiracMessage,
	DiracMessageType,
	type ExtensionState,
	isFinalStatus,
	type TaskStatus,
} from "@shared/ExtensionMessage"
import { type ApiMetrics, getApiMetrics, getLastApiReqInfo } from "@shared/getApiMetrics"
import type { PresentationBatch, PresentationOperation } from "@shared/PresentationOperation"
import { create } from "zustand"

export type PresentationApplyResult = "applied" | "gap" | "wrong_surface"

interface ChatState {
	diracMessages: DiracMessage[]
	messageIndexById: Map<string, number>
	presentationSurfaceId?: string
	presentationOffset: number
	presentationRevision: number
	presentationAppends: Map<string, { revision: number; chunks: string[] }>
	visibleMessageIds: string[]
	visibleMessageIdSet: Set<string>
	apiMetrics: ApiMetrics
	lastApiReqInfo?: DiracApiReqInfo
	latestRequestStatusId?: string
	taskMessage?: DiracMessage
	lastMessage?: DiracMessage
	secondLastMessage?: DiracMessage
	goal?: NonNullable<ExtensionState["goal"]>
	uiActionState?: ExtensionState["uiActionState"]
	activeVoiceStreamId?: string
	isApiRequestActive?: boolean
	taskStatus?: TaskStatus
	cardCollapsedStates: Record<string, boolean>
	cardUserToggledStates: Record<string, boolean>

	applyExtensionState: (state: Partial<ExtensionState>) => void
	applyPresentationBatch: (batch: PresentationBatch) => PresentationApplyResult
	setDiracMessages: (messages: DiracMessage[]) => void
	setCardCollapsedState: (cardId: string, collapsed: boolean, userToggled?: boolean) => void
	clearCardCollapsedStates: () => void
}

function isVisibleMessage(message: DiracMessage, latestRequestStatusId?: string): boolean {
	if (message.content.type === DiracMessageType.MARKDOWN) {
		return message.content.content !== "" || (message.content.images?.length ?? 0) > 0
	}
	if (message.content.type === DiracMessageType.API_STATUS) {
		return (
			message.id === latestRequestStatusId ||
			message.content.status.cost !== undefined ||
			message.content.status.tokensIn !== undefined
		)
	}
	return true
}

function rebuildDerivedPresentation(
	messages: DiracMessage[],
): Pick<
	ChatState,
	| "visibleMessageIds"
	| "visibleMessageIdSet"
	| "apiMetrics"
	| "lastApiReqInfo"
	| "latestRequestStatusId"
	| "taskMessage"
	| "lastMessage"
	| "secondLastMessage"
> {
	const visibleMessageIds: string[] = []
	let latestRequestStatusId: string | undefined
	for (let index = messages.length - 1; index >= 1; index--) {
		const message = messages[index]
		if (message.content.type === DiracMessageType.API_STATUS && message.content.status.request) {
			latestRequestStatusId = message.id
			break
		}
	}
	for (let index = 1; index < messages.length; index++) {
		if (isVisibleMessage(messages[index], latestRequestStatusId)) visibleMessageIds.push(messages[index].id)
	}
	return {
		visibleMessageIds,
		visibleMessageIdSet: new Set(visibleMessageIds),
		apiMetrics: getApiMetrics(messages),
		lastApiReqInfo: getLastApiReqInfo(messages),
		latestRequestStatusId,
		taskMessage: messages[0],
		lastMessage: messages.at(-1),
		secondLastMessage: messages.at(-2),
	}
}

function cardsById(messages: readonly DiracMessage[]): Map<string, Card> {
	const cards = new Map<string, Card>()
	for (const message of messages) {
		if (message.content.type === DiracMessageType.CARD) cards.set(message.content.card.id, message.content.card)
	}
	return cards
}

function indexMessages(messages: readonly DiracMessage[]): Map<string, number> {
	const indexes = new Map<string, number>()
	for (let index = 0; index < messages.length; index++) indexes.set(messages[index].id, index)
	return indexes
}

function synchronizeResolvedCardCollapse(state: ChatState, messages: DiracMessage[]): Partial<ChatState> {
	const previousCards = cardsById(state.diracMessages)
	const collapsedCardIds = messages.flatMap((message) => {
		if (message.content.type !== DiracMessageType.CARD) return []

		const card = message.content.card
		const previousCard = previousCards.get(card.id)
		const permissionWasResolved =
			card.requireApproval === true &&
			card.collapsed === true &&
			isFinalStatus(card.status) &&
			(previousCard === undefined || !isFinalStatus(previousCard.status))

		return permissionWasResolved ? [card.id] : []
	})

	if (collapsedCardIds.length === 0) return { diracMessages: messages }

	const cardCollapsedStates = { ...state.cardCollapsedStates }
	const cardUserToggledStates = { ...state.cardUserToggledStates }
	for (const cardId of collapsedCardIds) {
		cardCollapsedStates[cardId] = true
		cardUserToggledStates[cardId] = false
	}
	return {
		diracMessages: messages,
		cardCollapsedStates,
		cardUserToggledStates,
	}
}

function messageForOperation(
	state: ChatState,
	operation: Exclude<PresentationOperation, { type: "create" | "reset" }>,
): {
	index: number
	message: DiracMessage
} {
	const index = state.messageIndexById.get(operation.id)
	if (index === undefined) throw new Error(`Presentation operation refers to missing ID ${operation.id}`)
	return { index, message: state.diracMessages[index] }
}

function applyOperation(state: ChatState, operation: PresentationOperation): void {
	if (operation.type === "reset") {
		state.diracMessages = operation.messages
		state.messageIndexById = indexMessages(operation.messages)
		state.presentationAppends = new Map()
		return
	}
	if (operation.type === "create") {
		if (state.messageIndexById.has(operation.message.id)) {
			throw new Error(`Duplicate presentation ID ${operation.message.id}`)
		}
		state.messageIndexById.set(operation.message.id, state.diracMessages.length)
		state.diracMessages.push(operation.message)
		return
	}

	const located = messageForOperation(state, operation)
	const { index } = located
	let { message } = located
	if (operation.type === "delete") {
		state.diracMessages.splice(index, 1)
		state.messageIndexById = indexMessages(state.diracMessages)
		state.presentationAppends.delete(operation.id)
		return
	}
	if (operation.type === "append_card_body" || operation.type === "append_markdown") {
		if (operation.type === "append_card_body" && message.content.type !== DiracMessageType.CARD) {
			throw new Error(`Presentation ID ${operation.id} is not a Card`)
		}
		if (operation.type === "append_markdown" && message.content.type !== DiracMessageType.MARKDOWN) {
			throw new Error(`Presentation ID ${operation.id} is not markdown`)
		}
		recordPresentationAppend(state, operation.id, operation.text)
		return
	}

	message = materializePresentationAppend(state, operation.id) ?? message
	if (operation.type === "patch_message") {
		state.diracMessages[index] = { ...message, ...operation.patch }
		return
	}
	if (operation.type === "patch_card") {
		if (message.content.type !== DiracMessageType.CARD) throw new Error(`Presentation ID ${operation.id} is not a Card`)
		const card = { ...message.content.card, ...operation.patch }
		state.diracMessages[index] = {
			...message,
			content: { type: DiracMessageType.CARD, card },
		}
		return
	}
	if (operation.type === "patch_api_status") {
		if (message.content.type !== DiracMessageType.API_STATUS) {
			throw new Error(`Presentation ID ${operation.id} is not an API status`)
		}
		const status = { ...message.content.status, ...operation.patch }
		for (const key of operation.deletions ?? []) delete status[key]
		state.diracMessages[index] = {
			...message,
			content: { type: DiracMessageType.API_STATUS, status },
		}
		return
	}
	if (message.content.type !== DiracMessageType.MARKDOWN) {
		throw new Error(`Presentation ID ${operation.id} is not markdown`)
	}
	const content = { ...message.content, ...operation.patch }
	state.diracMessages[index] = { ...message, content }
}

function recordPresentationAppend(state: ChatState, id: string, text: string): void {
	const previous = state.presentationAppends.get(id)
	const chunks = previous?.chunks ?? []
	chunks.push(text)
	state.presentationAppends.set(id, {
		revision: state.presentationRevision + 1,
		chunks,
	})
}

function materializePresentationAppend(state: ChatState, id: string): DiracMessage | undefined {
	const append = state.presentationAppends.get(id)
	if (!append) return undefined
	const index = state.messageIndexById.get(id)
	if (index === undefined) throw new Error(`Presentation append refers to missing ID ${id}`)
	const message = state.diracMessages[index]
	const appendedText = append.chunks.join("")
	let materialized: DiracMessage
	if (message.content.type === DiracMessageType.MARKDOWN) {
		materialized = {
			...message,
			content: {
				...message.content,
				content: message.content.content + appendedText,
			},
		}
	} else if (message.content.type === DiracMessageType.CARD) {
		materialized = {
			...message,
			content: {
				type: DiracMessageType.CARD,
				card: {
					...message.content.card,
					body: `${message.content.card.body ?? ""}${appendedText}`,
				},
			},
		}
	} else {
		throw new Error(`Presentation append refers to non-text message ${id}`)
	}
	state.diracMessages[index] = materialized
	state.presentationAppends.delete(id)
	return materialized
}

function updateDerivedPresentation(
	state: ChatState,
	operation: PresentationOperation,
	before: DiracMessage | undefined,
	after: DiracMessage | undefined,
	index: number | undefined,
): void {
	if (operation.type === "reset" || operation.type === "delete") {
		Object.assign(state, rebuildDerivedPresentation(state.diracMessages))
		return
	}

	if (operationCanChangeApiMetrics(operation)) {
		const beforeMetrics = before ? getApiMetrics([before]) : getApiMetrics([])
		const afterMetrics = after ? getApiMetrics([after]) : getApiMetrics([])
		if (!sameApiMetrics(beforeMetrics, afterMetrics)) {
			const apiMetrics = { ...state.apiMetrics }
			addApiMetrics(apiMetrics, beforeMetrics, -1)
			addApiMetrics(apiMetrics, afterMetrics, 1)
			state.apiMetrics = apiMetrics
		}
	}

	if (after?.content.type === DiracMessageType.API_STATUS) {
		if (after.content.status.request && operation.type === "create") {
			const previousRequestId = state.latestRequestStatusId
			if (previousRequestId && state.visibleMessageIds.at(-1) === previousRequestId) {
				const previousIndex = state.messageIndexById.get(previousRequestId)
				const previousMessage = previousIndex === undefined ? undefined : state.diracMessages[previousIndex]
				if (
					previousMessage?.content.type === DiracMessageType.API_STATUS &&
					previousMessage.content.status.cost === undefined &&
					previousMessage.content.status.tokensIn === undefined
				) {
					state.visibleMessageIds = state.visibleMessageIds.slice(0, -1)
					state.visibleMessageIdSet = new Set(state.visibleMessageIds)
				}
			}
			state.latestRequestStatusId = after.id
		}
		const totalTokens =
			(after.content.status.tokensIn ?? 0) +
			(after.content.status.tokensOut ?? 0) +
			(after.content.status.cacheWrites ?? 0) +
			(after.content.status.cacheReads ?? 0)
		if (totalTokens > 0 && (after.id === state.latestRequestStatusId || operation.type === "create")) {
			state.lastApiReqInfo = after.content.status
		}
	}

	const appendMakesMessageVisible = operation.type === "append_markdown" && operation.text.length > 0
	if (
		index !== 0 &&
		after &&
		!state.visibleMessageIdSet.has(after.id) &&
		(appendMakesMessageVisible || isVisibleMessage(after, state.latestRequestStatusId))
	) {
		state.visibleMessageIds = [...state.visibleMessageIds, after.id]
		state.visibleMessageIdSet = new Set(state.visibleMessageIdSet).add(after.id)
	}
	if (index === 0 && after) state.taskMessage = after

	if (operation.type === "create") {
		state.lastMessage = state.diracMessages.at(-1)
		state.secondLastMessage = state.diracMessages.at(-2)
		return
	}
	if (operation.type === "append_markdown" || operation.type === "append_card_body") return
	if (index === state.diracMessages.length - 1) state.lastMessage = after
	if (index === state.diracMessages.length - 2) state.secondLastMessage = after
}

function operationCanChangeApiMetrics(operation: PresentationOperation): boolean {
	if (operation.type === "create" || operation.type === "patch_message" || operation.type === "patch_api_status") return true
	return operation.type === "patch_card" && (operation.patch.header !== undefined || operation.patch.body !== undefined || operation.patch.rawOutput !== undefined)
}

function sameApiMetrics(left: ApiMetrics, right: ApiMetrics): boolean {
	return (
		left.totalTokensIn === right.totalTokensIn &&
		left.totalTokensOut === right.totalTokensOut &&
		left.totalCacheWrites === right.totalCacheWrites &&
		left.totalCacheReads === right.totalCacheReads &&
		left.totalCost === right.totalCost &&
		left.totalReasoningTokens === right.totalReasoningTokens
	)
}

function addApiMetrics(target: ApiMetrics, contribution: ApiMetrics, direction: 1 | -1): void {
	target.totalTokensIn += direction * contribution.totalTokensIn
	target.totalTokensOut += direction * contribution.totalTokensOut
	target.totalCost += direction * contribution.totalCost
	target.totalReasoningTokens += direction * contribution.totalReasoningTokens
	if (contribution.totalCacheWrites !== undefined) {
		target.totalCacheWrites = (target.totalCacheWrites ?? 0) + direction * contribution.totalCacheWrites
	}
	if (contribution.totalCacheReads !== undefined) {
		target.totalCacheReads = (target.totalCacheReads ?? 0) + direction * contribution.totalCacheReads
	}
	const promptTokens = target.totalTokensIn + (target.totalCacheWrites ?? 0) + (target.totalCacheReads ?? 0)
	target.cacheHitRate = promptTokens > 0 ? (target.totalCacheReads ?? 0) / promptTokens : 0
}

function resolvedCardIdBeforeAndAfter(before: DiracMessage | undefined, after: DiracMessage | undefined): string | undefined {
	if (before?.content.type !== DiracMessageType.CARD || after?.content.type !== DiracMessageType.CARD) return undefined
	const card = after.content.card
	return card.requireApproval === true &&
		card.collapsed === true &&
		isFinalStatus(card.status) &&
		!isFinalStatus(before.content.card.status)
		? card.id
		: undefined
}

export const useChatStore = create<ChatState>((set) => ({
	diracMessages: [],
	messageIndexById: new Map(),
	presentationSurfaceId: undefined,
	presentationOffset: -1,
	presentationRevision: 0,
	presentationAppends: new Map(),
	visibleMessageIds: [],
	visibleMessageIdSet: new Set(),
	apiMetrics: getApiMetrics([]),
	lastApiReqInfo: undefined,
	latestRequestStatusId: undefined,
	taskMessage: undefined,
	lastMessage: undefined,
	secondLastMessage: undefined,
	goal: undefined,
	uiActionState: undefined,
	activeVoiceStreamId: undefined,
	isApiRequestActive: false,
	taskStatus: undefined,
	cardCollapsedStates: {},
	cardUserToggledStates: {},

	setDiracMessages: (messages) =>
		set((state) => ({
			...synchronizeResolvedCardCollapse(state, messages),
			messageIndexById: indexMessages(messages),
			presentationAppends: new Map(),
			...rebuildDerivedPresentation(messages),
			presentationRevision: state.presentationRevision + 1,
		})),
	setCardCollapsedState: (cardId, collapsed, userToggled = false) =>
		set((state) => ({
			cardCollapsedStates: {
				...state.cardCollapsedStates,
				[cardId]: collapsed,
			},
			cardUserToggledStates: {
				...state.cardUserToggledStates,
				[cardId]: userToggled,
			},
		})),
	clearCardCollapsedStates: () => set({ cardCollapsedStates: {}, cardUserToggledStates: {} }),

	applyExtensionState: (extensionState) =>
		set((state) => {
			const update: Partial<ChatState> = {}
			if (extensionState.diracMessages !== undefined) {
				Object.assign(update, synchronizeResolvedCardCollapse(state, extensionState.diracMessages))
				update.messageIndexById = indexMessages(extensionState.diracMessages)
				update.presentationAppends = new Map()
				Object.assign(update, rebuildDerivedPresentation(extensionState.diracMessages))
				update.presentationSurfaceId = extensionState.presentationSurfaceId
				update.presentationOffset = extensionState.presentationOffset ?? -1
				update.presentationRevision = state.presentationRevision + 1
			}
			if ("goal" in extensionState) update.goal = extensionState.goal ?? undefined
			if ("uiActionState" in extensionState) update.uiActionState = extensionState.uiActionState
			update.activeVoiceStreamId = extensionState.activeVoiceStreamId
			if ("isApiRequestActive" in extensionState) update.isApiRequestActive = extensionState.isApiRequestActive
			if ("taskStatus" in extensionState) update.taskStatus = extensionState.taskStatus
			return update
		}),

	applyPresentationBatch: (batch) => {
		let result: PresentationApplyResult = "applied"
		set((state) => {
			if (state.presentationSurfaceId !== batch.surfaceId) {
				result = "wrong_surface"
				return state
			}

			const changedCollapsedCardIds: string[] = []
			state.presentationAppends = new Map(state.presentationAppends)
			for (const operation of batch.operations) {
				if (operation.offset <= state.presentationOffset) continue
				if (operation.offset !== state.presentationOffset + 1 && operation.type !== "reset") {
					result = "gap"
					return state
				}
				const index =
					operation.type === "create" || operation.type === "reset"
						? undefined
						: state.messageIndexById.get(operation.id)
				const before = index === undefined ? undefined : state.diracMessages[index]
				applyOperation(state, operation)
				const afterIndex =
					operation.type === "create"
						? state.messageIndexById.get(operation.message.id)
						: operation.type === "delete" || operation.type === "reset"
							? undefined
							: index
				const after = afterIndex === undefined ? undefined : state.diracMessages[afterIndex]
				updateDerivedPresentation(state, operation, before, after, afterIndex)
				const collapsedCardId = resolvedCardIdBeforeAndAfter(before, after)
				if (collapsedCardId) changedCollapsedCardIds.push(collapsedCardId)
				state.presentationOffset = operation.offset
			}

			const update: Partial<ChatState> = {
				diracMessages: state.diracMessages,
				messageIndexById: state.messageIndexById,
				presentationOffset: state.presentationOffset,
				presentationRevision: state.presentationRevision + 1,
				presentationAppends: state.presentationAppends,
				visibleMessageIds: state.visibleMessageIds,
				visibleMessageIdSet: state.visibleMessageIdSet,
				apiMetrics: state.apiMetrics,
				lastApiReqInfo: state.lastApiReqInfo,
				latestRequestStatusId: state.latestRequestStatusId,
				taskMessage: state.taskMessage,
				lastMessage: state.lastMessage,
				secondLastMessage: state.secondLastMessage,
			}
			if (changedCollapsedCardIds.length > 0) {
				update.cardCollapsedStates = { ...state.cardCollapsedStates }
				update.cardUserToggledStates = { ...state.cardUserToggledStates }
				for (const cardId of changedCollapsedCardIds) {
					update.cardCollapsedStates[cardId] = true
					update.cardUserToggledStates[cardId] = false
				}
			}
			return update
		})
		return result
	},
}))
