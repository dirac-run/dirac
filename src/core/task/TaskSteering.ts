import { findSlashCommandInTags } from "@core/slash-commands/commandParser"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { DiracMessageType, SteeringTranscriptStatus, TaskStatus } from "@shared/ExtensionMessage"
import type { DiracContent, DiracStorageMessage, DiracTextContentBlock } from "@shared/messages/content"
import { ulid } from "ulid"
import type { MessageStateHandler } from "./message-state"
import {
	collectDeliveredSteeringMessageIds,
	formatSteeringMessages,
	restoreQueuedSteeringMessages,
	SteeringClaim,
	SteeringDeliveryState,
	SteeringMessage,
} from "./steering"
import type { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"

export interface TaskSteeringContext {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	taskMessenger: TaskMessenger
	allowWhileWaitingForInteraction?: boolean
	postStateToWebview: () => void | Promise<void>
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
}

export function canAcceptSteeringMessage(ctx: TaskSteeringContext): boolean {
	if (ctx.taskState.completionCommitted) return false
	if (ctx.taskState.abort || ctx.taskState.pendingTaskReplacement) return false
	if (ctx.taskState.waitingCardIds.length > 0 && !ctx.allowWhileWaitingForInteraction) return false
	return ![TaskStatus.IDLE, TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.CANCELLING].includes(ctx.taskState.status)
}

export async function enqueueSteeringMessage(ctx: TaskSteeringContext, text: string): Promise<string> {
	const normalizedText = text.trim()
	if (!normalizedText) throw new Error("Steering guidance cannot be empty")

	const steeringMessage = await ctx.withStateLock(async (): Promise<SteeringMessage> => {
		if (!canAcceptSteeringMessage(ctx)) {
			throw new Error(`Task cannot accept steering while ${ctx.taskState.status}`)
		}

		const createdAt = Date.now()
		const transcriptMessageId = ctx.taskMessenger.generateId()
		const message: SteeringMessage = {
			id: ulid(),
			text: normalizedText,
			createdAt,
			transcriptMessageId,
			deliveryState: SteeringDeliveryState.QUEUED,
		}
		const transcriptMessage: DiracMessage = {
			id: transcriptMessageId,
			ts: createdAt,
			content: {
				type: DiracMessageType.MARKDOWN,
				content: normalizedText,
				role: "user",
				steering: { status: SteeringTranscriptStatus.QUEUED },
			},
		}
		await ctx.messageStateHandler.addToDiracMessages(transcriptMessage)
		ctx.taskState.steeringMessages.push(message)
		return message
	})

	await ctx.postStateToWebview()
	return steeringMessage.transcriptMessageId
}

export async function claimSteeringMessages(ctx: TaskSteeringContext): Promise<SteeringClaim | undefined> {
	return ctx.withStateLock(() => {
		const messages = ctx.taskState.steeringMessages.filter(
			(message) => message.deliveryState === SteeringDeliveryState.QUEUED,
		)
		if (messages.length === 0) return undefined

		const claimId = ulid()
		for (const message of messages) {
			message.deliveryState = SteeringDeliveryState.CLAIMED
			message.claimId = claimId
		}
		return { id: claimId, messages: messages.map((message) => ({ ...message })) }
	})
}

export async function commitSteeringClaim(ctx: TaskSteeringContext, claimId: string): Promise<void> {
	const claimedMessages = await ctx.withStateLock(() => {
		const messages = ctx.taskState.steeringMessages.filter(
			(message) => message.deliveryState === SteeringDeliveryState.CLAIMED && message.claimId === claimId,
		)
		for (const message of messages) {
			message.deliveryState = SteeringDeliveryState.SENT
			message.claimId = undefined
		}
		return messages.map((message) => ({ ...message }))
	})

	const transcriptMessages = claimedMessages.map((message) => {
		const transcriptMessage = ctx.messageStateHandler.getMessageById(message.transcriptMessageId)
		if (!transcriptMessage) throw new Error(`Steering transcript message not found: ${message.transcriptMessageId}`)
		if (transcriptMessage.content.type !== DiracMessageType.MARKDOWN) {
			throw new Error(`Steering transcript message is not markdown: ${message.transcriptMessageId}`)
		}
		return transcriptMessage.id
	})

	for (const transcriptMessageId of transcriptMessages) {
		await ctx.messageStateHandler.patchMarkdownById(transcriptMessageId, {
			steering: { status: SteeringTranscriptStatus.SENT },
		})
	}
	await ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
	await ctx.postStateToWebview()
}

export async function settleConsumedSteeringClaim(ctx: TaskSteeringContext, claim: SteeringClaim): Promise<void> {
	let receiptError: unknown
	try {
		await ctx.messageStateHandler.recordDeliveredSteeringMessageIds(
			claim.messages.map((message) => message.transcriptMessageId),
		)
	} catch (error) {
		receiptError = error
	}

	try {
		await commitSteeringClaim(ctx, claim.id)
	} catch (commitError) {
		if (receiptError) {
			throw new AggregateError([receiptError, commitError], "Failed to persist consumed steering delivery")
		}
		throw commitError
	}
	if (receiptError) throw receiptError
}

export async function rollbackSteeringClaim(ctx: TaskSteeringContext, claimId: string): Promise<void> {
	await ctx.withStateLock(() => {
		for (const message of ctx.taskState.steeringMessages) {
			if (message.deliveryState !== SteeringDeliveryState.CLAIMED || message.claimId !== claimId) continue
			message.deliveryState = SteeringDeliveryState.QUEUED
			message.claimId = undefined
		}
	})
}

export function isSlashCommandSteeringMessage(message: Pick<SteeringMessage, "text">): boolean {
	return findSlashCommandInTags(formatSteeringMessages([message])) !== null
}

export async function releaseSteeringClaimSuffix(
	ctx: TaskSteeringContext,
	claim: SteeringClaim,
	retainedCount: number,
): Promise<SteeringClaim> {
	const retainedMessages = claim.messages.slice(0, retainedCount)
	const retainedMessageIds = new Set(retainedMessages.map((message) => message.id))
	await ctx.withStateLock(() => {
		for (const message of ctx.taskState.steeringMessages) {
			if (message.deliveryState !== SteeringDeliveryState.CLAIMED || message.claimId !== claim.id) continue
			if (retainedMessageIds.has(message.id)) continue
			message.deliveryState = SteeringDeliveryState.QUEUED
			message.claimId = undefined
		}
	})
	return { ...claim, messages: retainedMessages }
}

export async function appendQueuedSteeringToUserContent(
	ctx: TaskSteeringContext,
	userContent: DiracContent[],
): Promise<SteeringClaim | undefined> {
	const steeringClaim = await claimSteeringMessages(ctx)
	if (!steeringClaim) return undefined
	const commandIndex = steeringClaim.messages.findIndex((message) => isSlashCommandSteeringMessage(message))
	if (commandIndex === -1) {
		userContent.push({
			type: "text",
			text: formatSteeringMessages(steeringClaim.messages),
			isUserInput: true,
			steeringMessageIds: steeringClaim.messages.map((message) => message.transcriptMessageId),
		})
		return steeringClaim
	}

	const retainedCount = commandIndex === 0 ? 1 : commandIndex
	const requestClaim = await releaseSteeringClaimSuffix(ctx, steeringClaim, retainedCount)
	userContent.push({
		type: "text",
		text: formatSteeringMessages(requestClaim.messages),
		isUserInput: true,
		steeringMessageIds: requestClaim.messages.map((message) => message.transcriptMessageId),
	})
	return requestClaim
}

export async function appendQueuedSteeringToNextApiRequest(
	ctx: TaskSteeringContext,
	outboundHistory: DiracStorageMessage[],
): Promise<void> {
	const steeringClaim = await claimSteeringMessages(ctx)
	if (!steeringClaim) return
	if (steeringClaim.messages.some((message) => isSlashCommandSteeringMessage(message))) {
		await rollbackSteeringClaim(ctx, steeringClaim.id)
		return
	}

	const messageIds = steeringClaim.messages.map((message) => message.transcriptMessageId)
	const steeringBlock: DiracTextContentBlock = {
		type: "text",
		text: formatSteeringMessages(steeringClaim.messages),
		steeringMessageIds: messageIds,
	}
	const outboundUserMessage = outboundHistory.at(-1)
	if (!outboundUserMessage || outboundUserMessage.role !== "user") {
		await rollbackSteeringClaim(ctx, steeringClaim.id)
		throw new Error("Cannot steer a model request without a final user message")
	}

	let userMessagePersisted = false
	try {
		const persistedUserMessage = await ctx.messageStateHandler.appendToLastApiConversationUserMessage(steeringBlock)
		userMessagePersisted = true
		if (outboundUserMessage !== persistedUserMessage) {
			if (typeof outboundUserMessage.content === "string") {
				outboundUserMessage.content = [{ type: "text", text: outboundUserMessage.content }, steeringBlock]
			} else {
				outboundUserMessage.content.push(steeringBlock)
			}
		}
		await settleConsumedSteeringClaim(ctx, steeringClaim)
	} catch (error) {
		if (!userMessagePersisted) await rollbackSteeringClaim(ctx, steeringClaim.id)
		throw error
	}
}

export async function commitAttemptCompletion(
	ctx: TaskSteeringContext,
	response: string,
): Promise<import("./tools/interfaces/IToolEnvironment").CompletionCommitResult> {
	return ctx.withStateLock(() => {
		const hasQueuedSteering = ctx.taskState.steeringMessages.some(
			(message) => message.deliveryState === SteeringDeliveryState.QUEUED,
		)
		if (hasQueuedSteering) {
			ctx.taskState.didAttemptCompletion = false
			return { committed: false, error: "Completion was superseded by queued user steering." }
		}
		ctx.taskState.completionCommitted = true
		ctx.taskState.didAttemptCompletion = true
		ctx.taskState.commitCompletionResponse(response)
		return { committed: true }
	})
}

export function restoreQueuedSteeringFromTranscript(ctx: TaskSteeringContext): void {
	const deliveredMessageIds = collectDeliveredSteeringMessageIds(ctx.messageStateHandler.getApiConversationHistory())
	for (const messageId of ctx.messageStateHandler.getApiConversationProviderState().deliveredSteeringMessageIds ?? []) {
		deliveredMessageIds.add(messageId)
	}
	ctx.taskState.steeringMessages = restoreQueuedSteeringMessages(
		ctx.messageStateHandler.getDiracMessages(),
		deliveredMessageIds,
	)
}
