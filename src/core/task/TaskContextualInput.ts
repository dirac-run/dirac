import { DiracMessageType, SteeringTranscriptStatus, TaskStatus } from "@shared/ExtensionMessage"
import type { ContextualInput, ContextualInputAcceptance, ContextualInputRoute } from "@shared/messages/contextualInput"
import { SteeringDeliveryState } from "./steering"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { SteeringMessage } from "./steering"

export interface TaskContextualInputContext {
	taskState: {
		abort: boolean
		status: TaskStatus
		askResponse?: unknown
		lastWaitingCardId?: string
		waitingCardIds: readonly string[]
		waitingForFollowUp: boolean
		lastMessageTs?: number
		steeringMessages: SteeringMessage[]
	}
	messageStateHandler: { appendDurableUserMessage(message: DiracMessage, assertCurrent: () => void): Promise<void> }
	taskMessenger: { generateId(): string }
	withStateLock<T>(action: () => T | Promise<T>): Promise<T>
	postStateToWebview(): void | Promise<void>
	canAcceptSteering(): boolean
	submitResponse(cardId: string, value: string): Promise<void>
	onUserInputAccepted?: () => void
}

export function assertContextualInputRoute(ctx: TaskContextualInputContext, route: ContextualInputRoute): void {
	const state = ctx.taskState
	if (state.abort || [TaskStatus.CANCELLED, TaskStatus.CANCELLING].includes(state.status))
		throw new Error("Conversation is cancelled; resume it before sending feedback")
	if (state.askResponse !== undefined) throw new Error("Another conversation response is already being accepted")
	if (route.kind === "interaction") {
		if (state.lastWaitingCardId !== route.cardId || state.waitingCardIds.length !== 1)
			throw new Error("The waiting interaction changed; feedback was not submitted")
		return
	}
	if (state.waitingCardIds.length) throw new Error("Answer the waiting interaction before sending feedback")
	if (route.kind === "followup") {
		if (!state.waitingForFollowUp) throw new Error("Conversation is no longer awaiting follow-up")
		return
	}
	if (!ctx.canAcceptSteering()) throw new Error(`Conversation cannot accept steering while ${state.status}`)
}

/** Durable transcript input followed by the existing wait/steering primitives.
 * A crash between persistence and release is recovered by ordinary queued-steering restoration.
 * This module knows nothing about diagrams, source storage or source acknowledgement.
 */
export async function submitContextualInput(
	ctx: TaskContextualInputContext,
	input: ContextualInput,
	route: ContextualInputRoute,
	assertOwner: () => void,
): Promise<ContextualInputAcceptance> {
	const reservation = await ctx.withStateLock(() => {
		assertOwner()
		assertContextualInputRoute(ctx, route)
		return {
			id: ctx.taskMessenger.generateId(),
			createdAt: Date.now(),
			followUpTs: ctx.taskState.lastMessageTs,
		}
	})
	const assertCurrent = () => {
		assertOwner()
		assertContextualInputRoute(ctx, route)
		if (route.kind === "followup" && ctx.taskState.lastMessageTs !== reservation.followUpTs)
			throw new Error("The waiting follow-up changed; feedback was not submitted to it")
	}
	const { id, createdAt } = reservation
	// Neither conversation-state nor message-state locks may span this filesystem write.
	await ctx.messageStateHandler
		.appendDurableUserMessage(
			{
				id,
				ts: createdAt,
				content: {
					type: DiracMessageType.MARKDOWN,
					role: "user",
					content: input.text,
					steering: { status: SteeringTranscriptStatus.QUEUED },
					contextualInput: { references: input.references },
				},
			},
			assertCurrent,
		)
		.catch((error: unknown) => {
			throw new Error(
				`Feedback persistence is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Refresh the feedback source before retrying. If feedback was saved but is not consumed, resume the owning conversation through its normal flow; do not resend saved feedback.`,
				{ cause: error },
			)
		})
	try {
		await ctx.withStateLock(async () => {
			assertCurrent()
			ctx.taskState.steeringMessages.push({
				id,
				text: input.text,
				createdAt,
				transcriptMessageId: id,
				deliveryState: SteeringDeliveryState.QUEUED,
				contextual: true,
			})
			if (route.kind !== "steering") {
				// submitResponse only updates the existing wait state; it performs no I/O.
				// Contextual content travels alongside the response on the next turn.
				await ctx.submitResponse(
					route.kind === "interaction" ? route.cardId : "",
					"Contextual feedback submitted with this response.",
				)
			}
			ctx.onUserInputAccepted?.()
		})
		await ctx.postStateToWebview()
		return { persisted: true }
	} catch (error) {
		return {
			persisted: true,
			warning: `Feedback saved in the conversation; ${error instanceof Error ? error.message : String(error)}. Resume through the normal conversation flow if needed.`,
		}
	}
}
