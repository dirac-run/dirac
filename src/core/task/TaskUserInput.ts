import { formatResponse } from "@core/formatResponse"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { Logger } from "@shared/services/Logger"
import { TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracContent } from "@shared/messages/content"
import pWaitFor from "p-wait-for"
import type { TaskState } from "./TaskState"

export interface TaskUserInputContext {
	taskState: TaskState
}

export async function waitForFollowUp(ctx: TaskUserInputContext): Promise<DiracContent[] | undefined> {
	if (ctx.taskState.status !== TaskStatus.COMPLETED) {
		ctx.taskState.status = TaskStatus.AWAITING_USER_INPUT
	}

	const messageTs = Date.now()
	ctx.taskState.lastMessageTs = messageTs

	await pWaitFor(
		() => {
			return ctx.taskState.askResponse !== undefined || ctx.taskState.lastMessageTs !== messageTs || ctx.taskState.abort
		},
		{ interval: 100 },
	)

	if (ctx.taskState.abort || ctx.taskState.lastMessageTs !== messageTs) {
		return undefined
	}

	const text = ctx.taskState.askResponseText || ""
	const images = ctx.taskState.askResponseImages as string[] | undefined
	const files = ctx.taskState.askResponseFiles as string[] | undefined

	const userContent: DiracContent[] = [{ type: "text", text: `<feedback>\n${text}\n</feedback>`, isUserInput: true }]
	if (images && images.length > 0) {
		userContent.push(...formatResponse.imageBlocks(images))
	}
	if (files && files.length > 0) {
		const fileContentString = await processFilesIntoText(files)
		if (fileContentString) {
			userContent.push({ type: "text", text: fileContentString })
		}
	}

	return userContent
}

export function clearAskResponse(taskState: TaskState): void {
	taskState.askResponse = undefined
	taskState.askResponseCardId = undefined
	taskState.askResponseText = undefined
	taskState.askResponseImages = undefined
	taskState.askResponseFiles = undefined
	taskState.askResponseUserEdits = undefined
	taskState.askResponseAction = undefined
	taskState.askResponseValue = undefined
}

export async function submitCardResponse(
	ctx: TaskUserInputContext,
	params: {
		cardId: string
		response: DiracAskResponse | string
		text?: string
		images?: string[]
		files?: string[]
		value?: string
	},
): Promise<void> {
	const { cardId, response, text, images, files, value } = params
	if (cardId && ctx.taskState.lastWaitingCardId !== cardId) {
		Logger.warn(`[Task] Received response for card ${cardId}, but waiting for ${ctx.taskState.lastWaitingCardId}`)
		return
	}
	const isStandardResponse = Object.values(DiracAskResponse).includes(response as DiracAskResponse)
	ctx.taskState.askResponse = isStandardResponse ? (response as DiracAskResponse) : undefined
	ctx.taskState.askResponseCardId = cardId || ctx.taskState.lastWaitingCardId
	ctx.taskState.askResponseText = text
	ctx.taskState.askResponseImages = images
	ctx.taskState.askResponseFiles = files
	ctx.taskState.askResponseAction = response as string
	ctx.taskState.askResponseValue = value
	// When user sends a text message while a card is awaiting approval,
	// signal that the tool should be skipped and forward to LLM.
	if (response === DiracAskResponse.MESSAGE && text && ctx.taskState.status !== TaskStatus.CANCELLED) {
		ctx.taskState.didRejectTool = true
	}
}
