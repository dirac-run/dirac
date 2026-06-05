import { getFileMentionFromPath } from "@/core/mentions"
import { HostProvider } from "@/hosts/host-provider"
import { telemetryService } from "@/services/telemetry"
import { CommandContext, Empty } from "@/shared/proto/index.dirac"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../index"
import { DiracAskResponse } from "../../../shared/WebviewMessage"

export async function improveWithDirac(
	controller: Controller,
	request: CommandContext,
	notebookContext?: string,
): Promise<Empty> {
	if (!request.selectedText?.trim() && !notebookContext) {
		Logger.log("❌ No text selected and no notebook context")
		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "Please select some code to improve.",
		})
		return {}
	}
	const filePath = request.filePath || ""
	const fileMention = await getFileMentionFromPath(filePath)
	const hasSelectedText = request.selectedText?.trim()

	// Build prompt
	let prompt = hasSelectedText
		? `Improve the following code from ${fileMention} (e.g., suggest refactorings, optimizations, or better practices):\n\`\`\`${request.language}\n${request.selectedText}\n\`\`\``
		: `Improve the current code in the current notebook cell from ${fileMention}. Suggest refactorings, optimizations, or better practices based on the cell context.`

	if (notebookContext) {
		Logger.log("Adding notebook context to improveWithDirac task")
		prompt += `\n${notebookContext}`
	}

	// Send: notebooks go to existing task if available, non-notebooks always create new task
	if (notebookContext && controller.task) {
		const cardId = controller.task.taskState.lastWaitingCardId
		if (cardId) {
			await controller.task.submitCardResponse(cardId, DiracAskResponse.MESSAGE, prompt)
		}
	} else {
		await controller.initTask(prompt)
	}

	telemetryService.captureButtonClick("codeAction_improveCode", controller.task?.ulid)

	return {}
}
