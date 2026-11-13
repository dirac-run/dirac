import { parseArchitectureSelection } from "@shared/architecture/selection"
import { Logger } from "@shared/services/Logger"
import {
	Card as AppCard,
	CardKind as AppCardKind,
	CardStatus as AppCardStatus,
	CommandApprovalAccess as AppCommandApprovalAccess,
	CommandApprovalCategory as AppCommandApprovalCategory,
	CommandApprovalChoice as AppCommandApprovalChoice,
	DiracMessage as AppDiracMessage,
	DiracMessageType as AppDiracMessageType,
	SteeringTranscriptStatus as AppSteeringTranscriptStatus,
} from "@shared/ExtensionMessage"

import {
	Card,
	CardKind as ProtoCardKind,
	CardStatus as ProtoCardStatus,
	CommandApprovalAccess as ProtoCommandApprovalAccess,
	CommandApprovalCategory as ProtoCommandApprovalCategory,
	CommandApprovalChoice as ProtoCommandApprovalChoice,
	DiracMessage as ProtoDiracMessage,
	SteeringTranscriptStatus as ProtoSteeringTranscriptStatus,
} from "@shared/proto/dirac/ui"

// Corrupt optional navigation must not prevent the rest of a resumed transcript from loading.
function readArchitectureReference(input: unknown): AppCard["architectureReference"] {
	if (input === undefined) return undefined
	try {
		return parseArchitectureSelection(input)
	} catch (error) {
		Logger.warn("Invalid architecture card reference; navigation unavailable", error)
		return undefined
	}
}

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

const commandApprovalCategories: Record<AppCommandApprovalCategory, ProtoCommandApprovalCategory> = {
	filesystem: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_FILESYSTEM,
	network: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_NETWORK,
	processes: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_PROCESSES,
	execution: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_EXECUTION,
	credentials: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_CREDENTIALS,
	software: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_SOFTWARE,
	configuration: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_CONFIGURATION,
	devices: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_DEVICES,
	remote_resources: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_REMOTE_RESOURCES,
	system: ProtoCommandApprovalCategory.COMMAND_APPROVAL_CATEGORY_SYSTEM,
}

const commandApprovalAccessLevels: Record<AppCommandApprovalAccess, ProtoCommandApprovalAccess> = {
	use: ProtoCommandApprovalAccess.COMMAND_APPROVAL_ACCESS_USE,
	read: ProtoCommandApprovalAccess.COMMAND_APPROVAL_ACCESS_READ,
	mutate: ProtoCommandApprovalAccess.COMMAND_APPROVAL_ACCESS_MUTATE,
}

function convertProtoCommandApprovalChoice(choice: ProtoCommandApprovalChoice): AppCommandApprovalChoice {
	const category = (Object.keys(commandApprovalCategories) as AppCommandApprovalCategory[])
		.find((key) => commandApprovalCategories[key] === choice.category)
	const access = (Object.keys(commandApprovalAccessLevels) as AppCommandApprovalAccess[])
		.find((key) => commandApprovalAccessLevels[key] === choice.access)
	return {
		id: choice.id,
		label: choice.label,
		...(category === undefined ? {} : { category }),
		...(access === undefined ? {} : { access }),
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
		communication: card.communication,
		taskletReceiptJson: card.taskletReceipt === undefined ? undefined : JSON.stringify(card.taskletReceipt),
		architectureReference: card.architectureReference,
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
		commandApprovalChoices: card.commandApprovalChoices?.map((choice) => ({
			id: choice.id,
			label: choice.label,
			category: choice.category === undefined ? undefined : commandApprovalCategories[choice.category],
			access: choice.access === undefined ? undefined : commandApprovalAccessLevels[choice.access],
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
		renderType: (protoCard.renderType as any) ?? "text",
		requireApproval: protoCard.requireApproval ?? undefined,
		requireFeedback: protoCard.requireFeedback ?? undefined,
		feedbackPlaceholder: protoCard.feedbackPlaceholder ?? undefined,
		maxHeight: protoCard.maxHeight ?? undefined,
		cleanupStrategy: (protoCard.cleanupStrategy as any) ?? undefined,
		startTime: protoCard.startTimeMs ?? undefined,
		endTime: protoCard.endTimeMs ?? undefined,
		outcome: protoCard.outcome ?? undefined,
		toolName: protoCard.toolName ?? undefined,
		rawInput: parseCardRecord(protoCard.rawInputJson),
		rawOutput: parseCardRecord(protoCard.rawOutputJson),
		communication: protoCard.communication,
		taskletReceipt: protoCard.taskletReceiptJson === undefined ? undefined : JSON.parse(protoCard.taskletReceiptJson),
		architectureReference: readArchitectureReference(protoCard.architectureReference),
		diffs:
			protoCard.diffs.length > 0
				? protoCard.diffs.map((diff) => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText }))
				: undefined,
		locations:
			protoCard.locations.length > 0
				? protoCard.locations.map((location) => ({ path: location.path, line: location.line ?? undefined }))
				: undefined,
		commandApprovalChoices: protoCard.commandApprovalChoices?.length
			? protoCard.commandApprovalChoices.map(convertProtoCommandApprovalChoice)
			: undefined,
		actions:
			protoCard.actions?.map((action) => ({
				label: action.label,
				value: action.value,
				primary: action.primary ?? undefined,
				style: action.style as any,
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
