import { formatResponse } from "@core/formatResponse"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { DiracIcon } from "@shared/icons"
import { telemetryService } from "@/services/telemetry"
import { CardStatus } from "@/shared/ExtensionMessage"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const new_task_spec: DiracToolSpec = {
	id: DiracDefaultTool.NEW_TASK,
	name: "new_task",
	description: "Creates a new task with preloaded context from the current conversation.",
	parameters: [
		{
			name: "context",
			required: true,
			instruction:
				"Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps.",
		},
	],
}

export class NewTaskTool implements IDiracTool {
	spec(): DiracToolSpec {
		return new_task_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { context } = args

		if (!context) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError("Missing required parameter: context")
		}

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		// Show notification if enabled
		if (!env.config.isSubagentExecution && env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dirac wants to start a new task...",
				message: `Dirac is suggesting to start a new task with: ${context}`,
			})
		}
		const cardHandle = await env.ui.createCard({
			header: "New Task",
			icon: DiracIcon.CHAT,
			requireApproval: true,
			body: context,
			requireFeedback: true,
			collapsed: false,
		})
		const { text, images, files: newTaskFiles } = await cardHandle.waitForInteraction()

		const apiConfig = env.config.services.stateManager.getApiConfiguration()
		const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		if (text || (images && images.length > 0) || (newTaskFiles && newTaskFiles.length > 0)) {
			let fileContentString = ""
			if (newTaskFiles && newTaskFiles.length > 0) {
				fileContentString = await processFilesIntoText(newTaskFiles)
			}
			await env.ui.upsertText(text ?? "", false, "user")
			await cardHandle.finalize(CardStatus.CANCELLED)

			telemetryService.captureToolUsage(
				env.config.ulid,
				this.spec().id,
				env.config.api.getModel().id,
				provider,
				false, // autoApproved - new_task is never auto-approved
				false, // success=false because user provided feedback instead
				undefined,
				true, // isNativeToolCall
			)
			return formatResponse.toolResult(
				`The user provided feedback instead of creating a new task:\n<feedback>\n${text}\n</feedback>`,
				images,
				fileContentString,
			)
		}

		await cardHandle.update({
			header: "New Task Created",
			collapsed: true,
		})
		await cardHandle.finalize(CardStatus.SUCCESS)

		return formatResponse.toolResult(`The user has created a new task with the provided context.`)
	}
}
