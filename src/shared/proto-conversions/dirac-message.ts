import {
	ActionButton as AppActionButton,
	Card as AppCard,
	CardKind as AppCardKind,
	CardStatus as AppCardStatus,
	CleanupStrategy as AppCleanupStrategy,
	DiracApiReqInfo as AppDiracApiReqInfo,
	DiracMessage as AppDiracMessage,
	DiracMessageType as AppDiracMessageType,
	RenderType as AppRenderType,
	SteeringTranscriptStatus as AppSteeringTranscriptStatus,
	DiracApiReqCancelReason,
} from "@shared/ExtensionMessage"
import type { DiracMessageModelInfo } from "@shared/messages"

import {
	Card,
	CardKind as ProtoCardKind,
	CardStatus as ProtoCardStatus,
	DiracApiReqCancelReason as ProtoDiracApiReqCancelReason,
	DiracApiReqInfo as ProtoDiracApiReqInfo,
	DiracMessage as ProtoDiracMessage,
	DiracModelInfo as ProtoDiracModelInfo,
	SteeringTranscriptStatus as ProtoSteeringTranscriptStatus,
} from "@shared/proto/dirac/ui"

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

function convertCardKindToProtoEnum(kind: AppCardKind | undefined): ProtoCardKind {
	const mapping: Record<AppCardKind, ProtoCardKind> = {
		[AppCardKind.GENERIC]: ProtoCardKind.CARD_KIND_GENERIC,
		[AppCardKind.TASK_COMPLETION]: ProtoCardKind.CARD_KIND_TASK_COMPLETION,
		[AppCardKind.RESUME_TASK]: ProtoCardKind.CARD_KIND_RESUME_TASK,
		[AppCardKind.RESUME_COMPLETED_TASK]: ProtoCardKind.CARD_KIND_RESUME_COMPLETED_TASK,
	}
	return kind ? mapping[kind] : ProtoCardKind.CARD_KIND_UNSPECIFIED
}

function convertProtoEnumToCardKind(kind: ProtoCardKind): AppCardKind | undefined {
	switch (kind) {
		case ProtoCardKind.CARD_KIND_GENERIC:
			return AppCardKind.GENERIC
		case ProtoCardKind.CARD_KIND_TASK_COMPLETION:
			return AppCardKind.TASK_COMPLETION
		case ProtoCardKind.CARD_KIND_RESUME_TASK:
			return AppCardKind.RESUME_TASK
		case ProtoCardKind.CARD_KIND_RESUME_COMPLETED_TASK:
			return AppCardKind.RESUME_COMPLETED_TASK
		case ProtoCardKind.CARD_KIND_UNSPECIFIED:
		case ProtoCardKind.UNRECOGNIZED:
			return undefined
	}
}

function convertSteeringStatusToProtoEnum(status: AppSteeringTranscriptStatus | undefined): ProtoSteeringTranscriptStatus {
	if (status === AppSteeringTranscriptStatus.QUEUED) {
		return ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_QUEUED
	}
	if (status === AppSteeringTranscriptStatus.SENT) {
		return ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_SENT
	}
	return ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_UNSPECIFIED
}

function parseLegacySteeringStatus(status: string | undefined): AppSteeringTranscriptStatus | undefined {
	if (status === AppSteeringTranscriptStatus.QUEUED) return AppSteeringTranscriptStatus.QUEUED
	if (status === AppSteeringTranscriptStatus.SENT) return AppSteeringTranscriptStatus.SENT
	return undefined
}

// Proto wire fields are plain strings; narrow to the app unions, dropping unrecognized values.
function toRenderType(value: string | undefined): AppRenderType | undefined {
	switch (value) {
		case "text":
		case "markdown":
		case "diff":
			return value
		default:
			return undefined
	}
}

function toCleanupStrategy(value: string | undefined): AppCleanupStrategy | undefined {
	switch (value) {
		case "abandon":
		case "success":
		case "error":
		case "keep_running":
			return value
		default:
			return undefined
	}
}

function toActionStyle(value: string | undefined): AppActionButton["style"] {
	switch (value) {
		case "default":
		case "danger":
		case "secondary":
			return value
		default:
			return undefined
	}
}

// Proto cancel reason is a numeric enum; the app side uses the equivalent string union.
function apiReqCancelReasonToProto(reason: DiracApiReqCancelReason | undefined): ProtoDiracApiReqCancelReason {
	switch (reason) {
		case "streaming_failed":
			return ProtoDiracApiReqCancelReason.STREAMING_FAILED
		case "user_cancelled":
			return ProtoDiracApiReqCancelReason.USER_CANCELLED
		case "retries_exhausted":
			return ProtoDiracApiReqCancelReason.RETRIES_EXHAUSTED
		default:
			// proto3 encodes the zero value as absent, matching today's undefined behavior
			return ProtoDiracApiReqCancelReason.STREAMING_FAILED
	}
}

function protoToApiReqCancelReason(reason: ProtoDiracApiReqCancelReason): DiracApiReqCancelReason | undefined {
	switch (reason) {
		case ProtoDiracApiReqCancelReason.STREAMING_FAILED:
			return "streaming_failed"
		case ProtoDiracApiReqCancelReason.USER_CANCELLED:
			return "user_cancelled"
		case ProtoDiracApiReqCancelReason.RETRIES_EXHAUSTED:
			return "retries_exhausted"
		default:
			return undefined
	}
}

// Proto DiracApiReqInfo is narrower than the app type; fields with no wire slot are dropped.
function convertApiReqInfoToProto(status: AppDiracApiReqInfo): ProtoDiracApiReqInfo {
	return {
		request: status.request ?? "",
		tokensIn: status.tokensIn ?? 0,
		tokensOut: status.tokensOut ?? 0,
		cacheWrites: status.cacheWrites ?? 0,
		cacheReads: status.cacheReads ?? 0,
		cost: status.cost ?? 0,
		cancelReason: apiReqCancelReasonToProto(status.cancelReason),
		streamingFailedMessage: status.streamingFailedMessage ?? "",
		retryStatus: status.retryStatus
			? { ...status.retryStatus, errorSnippet: status.retryStatus.errorSnippet ?? "" }
			: undefined,
	}
}

function convertProtoToApiReqInfo(proto: ProtoDiracApiReqInfo): AppDiracApiReqInfo {
	return {
		request: proto.request,
		tokensIn: proto.tokensIn,
		tokensOut: proto.tokensOut,
		cacheWrites: proto.cacheWrites,
		cacheReads: proto.cacheReads,
		cost: proto.cost,
		cancelReason: protoToApiReqCancelReason(proto.cancelReason),
		streamingFailedMessage: proto.streamingFailedMessage,
		retryStatus: proto.retryStatus,
	}
}

// Proto DiracModelInfo carries only ids; app-side mode is not on the wire.
function convertProtoToModelInfo(proto: ProtoDiracModelInfo | undefined): DiracMessageModelInfo | undefined {
	if (!proto) return undefined
	return { modelId: proto.modelId, providerId: proto.providerId }
}

function convertProtoEnumToSteeringStatus(
	status: ProtoSteeringTranscriptStatus,
	legacyStatus: string | undefined,
): AppSteeringTranscriptStatus | undefined {
	if (status === ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_QUEUED) {
		return AppSteeringTranscriptStatus.QUEUED
	}
	if (status === ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_SENT) {
		return AppSteeringTranscriptStatus.SENT
	}
	return parseLegacySteeringStatus(legacyStatus)
}


function serializeCardRecord(value: Record<string, unknown> | undefined): string | undefined {
	if (value === undefined) return undefined
	try {
		return JSON.stringify(value)
	} catch {
		return undefined
	}
}

function parseCardRecord(value: string | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}


function convertCardToProto(card: AppCard): Card {
	return {
		id: card.id,
		kind: convertCardKindToProtoEnum(card.kind),
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
		toolName: card.toolName ?? undefined,
		rawInputJson: serializeCardRecord(card.rawInput),
		rawOutputJson: serializeCardRecord(card.rawOutput),
		diffs:
			card.diffs?.map((diff) => ({
				path: diff.path,
				oldText: diff.oldText,
				newText: diff.newText,
			})) ?? [],
		locations:
			card.locations?.map((location) => ({
				path: location.path,
				line: location.line,
			})) ?? [],
		actions:
			card.actions?.map((action) => ({
				label: action.label,
				value: action.value,
				primary: action.primary ?? undefined,
				style: action.style ?? undefined,
				url: action.url ?? undefined,
			})) ?? [],
		autoScroll: card.autoScroll ?? undefined,
	}
}

function convertProtoToCard(protoCard: Card): AppCard {
	return {
		id: protoCard.id,
		kind: convertProtoEnumToCardKind(protoCard.kind),
		header: protoCard.header,
		status: convertProtoEnumToCardStatus(protoCard.status),
		body: protoCard.body ?? undefined,
		collapsed: protoCard.collapsed ?? undefined,
		icon: protoCard.icon ?? undefined,
		do_not_auto_collapse: protoCard.doNotAutoCollapse ?? undefined,
		renderType: toRenderType(protoCard.renderType) ?? "text",
		requireApproval: protoCard.requireApproval ?? undefined,
		requireFeedback: protoCard.requireFeedback ?? undefined,
		feedbackPlaceholder: protoCard.feedbackPlaceholder ?? undefined,
		maxHeight: protoCard.maxHeight ?? undefined,
		cleanupStrategy: toCleanupStrategy(protoCard.cleanupStrategy),
		startTime: protoCard.startTimeMs ?? undefined,
		endTime: protoCard.endTimeMs ?? undefined,
		outcome: protoCard.outcome ?? undefined,
		toolName: protoCard.toolName ?? undefined,
		rawInput: parseCardRecord(protoCard.rawInputJson),
		rawOutput: parseCardRecord(protoCard.rawOutputJson),
		diffs:
			protoCard.diffs.length > 0
				? protoCard.diffs.map((diff) => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText }))
				: undefined,
		locations:
			protoCard.locations.length > 0
				? protoCard.locations.map((location) => ({ path: location.path, line: location.line ?? undefined }))
				: undefined,
		actions:
			protoCard.actions?.map((action) => ({
				label: action.label,
				value: action.value,
				primary: action.primary ?? undefined,
				style: toActionStyle(action.style),
				url: action.url ?? undefined,
			})) ?? undefined,
		autoScroll: protoCard.autoScroll ?? undefined,
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
				steeringStatus: message.content.steering?.status,
				steeringTranscriptStatus: convertSteeringStatusToProtoEnum(message.content.steering?.status),
			}
			break
		case AppDiracMessageType.CARD:
			protoMessage.card = convertCardToProto(message.content.card)
			break
		case AppDiracMessageType.API_STATUS:
			protoMessage.apiStatus = convertApiReqInfoToProto(message.content.status)
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
			steering: (() => {
				const status = convertProtoEnumToSteeringStatus(
					protoMessage.markdown.steeringTranscriptStatus,
					protoMessage.markdown.steeringStatus,
				)
				return status ? { status } : undefined
			})(),
		}
	} else if (protoMessage.card) {
		content = {
			type: AppDiracMessageType.CARD,
			card: convertProtoToCard(protoMessage.card),
		}
	} else if (protoMessage.apiStatus) {
		content = {
			type: AppDiracMessageType.API_STATUS,
			status: convertProtoToApiReqInfo(protoMessage.apiStatus),
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
		modelInfo: convertProtoToModelInfo(protoMessage.modelInfo),
	}

	return message
}
