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
	if (ctx.taskState.status !== TaskStatus.COMPLETED) ctx.taskState.status = TaskStatus.AWAITING_USER_INPUT
	const messageTs = Date.now()
	ctx.taskState.lastMessageTs = messageTs
	ctx.taskState.waitingForFollowUp = true
	try {
		await pWaitFor(
			() => ctx.taskState.askResponse !== undefined || ctx.taskState.lastMessageTs !== messageTs || ctx.taskState.abort,
			{ interval: 100 },
		)
		if (ctx.taskState.abort || ctx.taskState.lastMessageTs !== messageTs) return undefined
		const text = ctx.taskState.askResponseText || ""
		const images = ctx.taskState.askResponseImages
		const files = ctx.taskState.askResponseFiles
		const userContent: DiracContent[] = text
			? [{ type: "text", text: `<feedback>\n${text}\n</feedback>`, isUserInput: true }]
			: []
		if (images?.length) userContent.push(...formatResponse.imageBlocks(images))
		if (files?.length) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) userContent.push({ type: "text", text: fileContentString })
		}
		return userContent
	} finally {
		ctx.taskState.waitingForFollowUp = false
	}
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
		userEdits?: Record<string, string>
	},
): Promise<void> {
	const { cardId, response, text, images, files, value, userEdits } = params
	const state = ctx.taskState
	if (!cardId && response !== DiracAskResponse.MESSAGE) {
		Logger.warn(`[Task] Received unaddressed card action ${response}`)
		return
	}
	const targetCardId = cardId || state.lastWaitingCardId
	const pending = targetCardId ? state.pendingCardInteractions.get(targetCardId) : undefined
	if (cardId && (!pending || pending.signal.aborted)) {
		Logger.warn(`[Task] Received response for card ${cardId}, but it has no pending interaction`)
		return
	}
	const isStandardResponse = Object.values(DiracAskResponse).includes(response as DiracAskResponse)
	const standardResponse = isStandardResponse ? (response as DiracAskResponse) : undefined
	if (pending) {
		if (pending.signal.aborted || pending.response) return
		pending.response = { response: standardResponse, action: response, text, images, files, value, userEdits }
	} else {
		state.askResponse = standardResponse
		state.askResponseCardId = undefined
		state.askResponseText = text
		state.askResponseImages = images
		state.askResponseFiles = files
		state.askResponseUserEdits = userEdits
		state.askResponseAction = response
		state.askResponseValue = value
	}
	// Card feedback is owned by that waiter's ToolSkippedByUserMessage outcome, not the current model turn.
	if (!pending && response === DiracAskResponse.MESSAGE && text && state.status !== TaskStatus.CANCELLED) {
		ctx.taskState.didRejectTool = true
	}
}
