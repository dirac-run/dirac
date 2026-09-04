import { formatResponse } from "@core/formatResponse"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracContent, type DiracUserContent } from "@shared/messages/content"
import type { DeepReadonly } from "./runtime/TaskWorkingConfiguration"
import type { Settings } from "@shared/storage/state-keys"
import type { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"
import { ToolSkippedByUserMessage } from "./tools/types/ToolSkippedByUserMessage"

export interface TaskMistakeLimitContext {
	taskState: TaskState
	settings: DeepReadonly<Settings>
	taskMessenger: TaskMessenger
	postStateToWebview?: () => Promise<void>
}

export async function handleMistakeLimitReached(
	ctx: TaskMistakeLimitContext,
	userContent: DiracContent[],
): Promise<{ didEndLoop: boolean; userContent: DiracContent[] }> {
	if (ctx.taskState.consecutiveMistakeCount < ctx.settings.maxConsecutiveMistakes) {
		return { didEndLoop: false, userContent }
	}

	// In yolo mode, don't wait for user input - fail the task
	if (ctx.settings.yoloModeToggled) {
		const errorMessage =
			`[YOLO MODE] Task failed: Too many consecutive mistakes (${ctx.taskState.consecutiveMistakeCount}). ` +
			`The model may not be capable enough for this task. Consider using a more capable model.`
		const card = await ctx.taskMessenger.createCard({
			status: CardStatus.ERROR,
			header: "Task Failed",
			body: errorMessage,
		})
		await card.finalize(CardStatus.ERROR)
		ctx.taskState.status = TaskStatus.CANCELLED
		await ctx.postStateToWebview?.()
		// End the task loop with failure
		return { didEndLoop: true, userContent } // didEndLoop = true, signals task completion/failure
	}

	const autoApprovalSettings = ctx.settings.autoApprovalSettings
	if (autoApprovalSettings.enableNotifications) {
		showSystemNotification({
			subtitle: "Error",
			message: "Dirac is having trouble. Would you like to continue the task?",
		})
	}

	const cardHandle = await ctx.taskMessenger.createCard({
		header: "Mistake Limit Reached",
		body: `Tool use failure. Can potentially be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`,
		requireFeedback: true,
		feedbackPlaceholder: "Provide guidance to Dirac...",
	})
	let response: DiracAskResponse
	let text: string | undefined
	let images: string[] | undefined
	let files: string[] | undefined
	try {
		const result = await cardHandle.waitForInteraction()
		response = result.response
		text = result.text
		images = result.images
		files = result.files
	} catch (error) {
		if (error instanceof ToolSkippedByUserMessage) {
			await cardHandle.finalize(CardStatus.SKIPPED)
			ctx.taskState.pendingUserMessage = error.userMessage
			ctx.taskState.pendingUserImages = error.userImages
			ctx.taskState.pendingUserFiles = error.userFiles
			ctx.taskState.consecutiveMistakeCount = 0
			return { didEndLoop: false, userContent }
		}
		throw error
	}

	await cardHandle.finalize(CardStatus.SUCCESS)

	if (response === DiracAskResponse.MESSAGE) {
		// Display the user's message in the chat UI
		await ctx.taskMessenger.upsertText(text || "", false, images, files, "user")

		// This userContent is for the *next* API call.
		const feedbackUserContent: DiracUserContent[] = []
		feedbackUserContent.push({
			type: "text",
			isUserInput: true,
			text: formatResponse.tooManyMistakes(text),
		})

		if (images && images.length > 0) {
			feedbackUserContent.push(...formatResponse.imageBlocks(images))
		}

		let fileContentString = ""
		if (files && files.length > 0) {
			fileContentString = await processFilesIntoText(files)
		}

		if (fileContentString) {
			feedbackUserContent.push({
				type: "text",
				text: fileContentString,
			})
		}

		userContent = feedbackUserContent
	}

	ctx.taskState.consecutiveMistakeCount = 0
	ctx.taskState.apiErrorRetryAttempts = 0
	ctx.taskState.emptyResponseRetryAttempts = 0
	return { didEndLoop: false, userContent }
}
