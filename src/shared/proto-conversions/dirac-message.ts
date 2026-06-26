import {
	Card as AppCard,
	CardStatus as AppCardStatus,
	DiracMessage as AppDiracMessage,
	DiracMessageType as AppDiracMessageType,
} from "@shared/ExtensionMessage"

import { Card, CardStatus as ProtoCardStatus, DiracMessage as ProtoDiracMessage } from "@shared/proto/dirac/ui"

function convertCardStatusToProtoEnum(status: AppCardStatus): ProtoCardStatus {
	const mapping: Record<AppCardStatus, ProtoCardStatus> = {
		[AppCardStatus.BUILDING]: ProtoCardStatus.CARD_BUILDING,
		[AppCardStatus.PENDING]: ProtoCardStatus.CARD_PENDING,
		[AppCardStatus.RUNNING]: ProtoCardStatus.CARD_RUNNING,
		[AppCardStatus.SUCCESS]: ProtoCardStatus.CARD_SUCCESS,
		[AppCardStatus.ERROR]: ProtoCardStatus.CARD_ERROR,
		[AppCardStatus.SKIPPED]: ProtoCardStatus.CARD_SKIPPED,
		[AppCardStatus.CANCELLED]: ProtoCardStatus.CARD_CANCELLED,
		[AppCardStatus.ABANDONED]: ProtoCardStatus.CARD_ABANDONED,
		[AppCardStatus.WAITING_FOR_INPUT]: ProtoCardStatus.CARD_WAITING_FOR_INPUT,
	}
	return mapping[status] ?? ProtoCardStatus.CARD_PENDING
}

function convertProtoEnumToCardStatus(status: ProtoCardStatus): AppCardStatus {
	if (status === ProtoCardStatus.UNRECOGNIZED) {
		return AppCardStatus.PENDING
	}

	const mapping: Record<Exclude<ProtoCardStatus, ProtoCardStatus.UNRECOGNIZED>, AppCardStatus> = {
		[ProtoCardStatus.CARD_BUILDING]: AppCardStatus.BUILDING,
		[ProtoCardStatus.CARD_PENDING]: AppCardStatus.PENDING,
		[ProtoCardStatus.CARD_RUNNING]: AppCardStatus.RUNNING,
		[ProtoCardStatus.CARD_SUCCESS]: AppCardStatus.SUCCESS,
		[ProtoCardStatus.CARD_ERROR]: AppCardStatus.ERROR,
		[ProtoCardStatus.CARD_SKIPPED]: AppCardStatus.SKIPPED,
		[ProtoCardStatus.CARD_CANCELLED]: AppCardStatus.CANCELLED,
		[ProtoCardStatus.CARD_ABANDONED]: AppCardStatus.ABANDONED,
		[ProtoCardStatus.CARD_WAITING_FOR_INPUT]: AppCardStatus.WAITING_FOR_INPUT,
	}
	return mapping[status] ?? AppCardStatus.PENDING
}

function convertCardToProto(card: AppCard): Card {
	return {
		id: card.id,
		header: card.header,
		status: convertCardStatusToProtoEnum(card.status),
		body: card.body ?? undefined,
		collapsed: card.collapsed ?? undefined,
		icon: card.icon ?? undefined,
		renderType: card.renderType ?? undefined,
		requireApproval: card.requireApproval ?? undefined,
		doNotAutoCollapse: card.do_not_auto_collapse ?? undefined,
		requireFeedback: card.requireFeedback ?? undefined,
		feedbackPlaceholder: card.feedbackPlaceholder ?? undefined,
		maxHeight: card.maxHeight ?? undefined,
		cleanupStrategy: card.cleanupStrategy ?? undefined,
		startTimeMs: card.startTime ?? undefined,
		endTimeMs: card.endTime ?? undefined,
		outcome: card.outcome ?? undefined,
		actions:
			card.actions?.map((action) => ({
				label: action.label,
				value: action.value,
				primary: action.primary ?? undefined,
				style: action.style ?? undefined,
			})) ?? [],
	}
}

function convertProtoToCard(protoCard: Card): AppCard {
	return {
		id: protoCard.id,
		header: protoCard.header,
		status: convertProtoEnumToCardStatus(protoCard.status),
		body: protoCard.body ?? undefined,
		collapsed: protoCard.collapsed ?? undefined,
		icon: protoCard.icon ?? undefined,
		do_not_auto_collapse: protoCard.doNotAutoCollapse ?? undefined,
		renderType: (protoCard.renderType as any) ?? "text",
		requireApproval: protoCard.requireApproval ?? undefined,
		requireFeedback: protoCard.requireFeedback ?? undefined,
		feedbackPlaceholder: protoCard.feedbackPlaceholder ?? undefined,
		maxHeight: protoCard.maxHeight ?? undefined,
		cleanupStrategy: (protoCard.cleanupStrategy as any) ?? undefined,
		startTime: protoCard.startTimeMs ?? undefined,
		endTime: protoCard.endTimeMs ?? undefined,
		outcome: protoCard.outcome ?? undefined,
		actions:
			protoCard.actions?.map((action) => ({
				label: action.label,
				value: action.value,
				primary: action.primary ?? undefined,
				style: action.style as any,
			})) ?? undefined,
	}
}

/**
 * Convert application DiracMessage to proto DiracMessage
 */
export function convertDiracMessageToProto(message: AppDiracMessage): ProtoDiracMessage {
	const protoMessage: ProtoDiracMessage = {
		id: message.id,
		ts: message.ts,
		partial: false, // partial is deprecated in AppDiracMessage
		lastCheckpointHash: message.lastCheckpointHash ?? "",
		isCheckpointCheckedOut: message.isCheckpointCheckedOut ?? false,
		isOperationOutsideWorkspace: message.isOperationOutsideWorkspace ?? false,
		conversationHistoryIndex: message.conversationHistoryIndex ?? 0,
		conversationHistoryDeletedRange: message.conversationHistoryDeletedRange
			? {
					startIndex: message.conversationHistoryDeletedRange[0],
					endIndex: message.conversationHistoryDeletedRange[1],
				}
			: undefined,
		modelInfo: message.modelInfo ?? undefined,
		multiCommandState: undefined, // multiCommandState is deprecated or handled elsewhere

		// Legacy fields (deprecated)
		type: 0, // DiracMessageType.SAY
		ask: 0,
		say: 0,
		text: "",
		reasoning: "",
		images: [],
		files: [],
		sayTool: undefined,
		sayBrowserAction: undefined,
		browserActionResult: undefined,
		planModeResponse: undefined,
		askQuestion: undefined,
		askNewTask: undefined,
	}

	// Map content union to proto fields
	switch (message.content.type) {
		case AppDiracMessageType.MARKDOWN:
			protoMessage.markdown = {
				content: message.content.content,
				isReasoning: message.content.isReasoning ?? false,
				images: message.content.images ?? [],
				files: message.content.files ?? [],
				role: message.content.role,
			}
			break
		case AppDiracMessageType.CARD:
			protoMessage.card = convertCardToProto(message.content.card)
			break
		case AppDiracMessageType.API_STATUS:
			protoMessage.apiStatus = {
				...message.content.status,
				request: message.content.status.request ?? "",
			} as any
			break
		case AppDiracMessageType.CHECKPOINT:
			protoMessage.checkpoint = {
				id: message.id,
			}
			break
	}

	return protoMessage
}

/**
 * Convert proto DiracMessage to application DiracMessage
 */
export function convertProtoToDiracMessage(protoMessage: ProtoDiracMessage): AppDiracMessage {
	let content: AppDiracMessage["content"]

	if (protoMessage.markdown) {
		content = {
			type: AppDiracMessageType.MARKDOWN,
			content: protoMessage.markdown.content,
			isReasoning: protoMessage.markdown.isReasoning,
			images: protoMessage.markdown.images,
			files: protoMessage.markdown.files,
			role: protoMessage.markdown.role as "user" | "assistant" | undefined,
		}
	} else if (protoMessage.card) {
		content = {
			type: AppDiracMessageType.CARD,
			card: convertProtoToCard(protoMessage.card),
		}
	} else if (protoMessage.apiStatus) {
		content = {
			type: AppDiracMessageType.API_STATUS,
			status: protoMessage.apiStatus as any,
		}
	} else if (protoMessage.checkpoint) {
		content = {
			type: AppDiracMessageType.CHECKPOINT,
		}
	} else {
		// Fallback for legacy proto messages
		content = {
			type: AppDiracMessageType.MARKDOWN,
			content: protoMessage.text || protoMessage.reasoning || "",
			isReasoning: false,
			images: protoMessage.images || [],
			files: protoMessage.files || [],
		}
	}

	const message: AppDiracMessage = {
		id: protoMessage.id,
		ts: protoMessage.ts,
		content,
		lastCheckpointHash: protoMessage.lastCheckpointHash,
		isCheckpointCheckedOut: protoMessage.isCheckpointCheckedOut,
		isOperationOutsideWorkspace: protoMessage.isOperationOutsideWorkspace,
		conversationHistoryIndex: protoMessage.conversationHistoryIndex,
		conversationHistoryDeletedRange: protoMessage.conversationHistoryDeletedRange
			? [protoMessage.conversationHistoryDeletedRange.startIndex, protoMessage.conversationHistoryDeletedRange.endIndex]
			: undefined,
		modelInfo: protoMessage.modelInfo as any,
	}

	return message
}
