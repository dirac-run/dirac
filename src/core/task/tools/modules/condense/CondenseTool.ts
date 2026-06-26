import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@/services/telemetry"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { formatResponse } from "@core/formatResponse"
import { DiracMessageType } from "@shared/ExtensionMessage"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { processFilesIntoText } from "@integrations/misc/extract-text"

export const condense_spec: DiracToolSpec = {
	id: DiracDefaultTool.CONDENSE,
	name: "condense",
	description: "Suggests to condense the conversation to free up context window space.",
	parameters: [
		{
			name: "context",
			required: true,
			instruction: "A summary of the conversation so far.",
		},
	],
}

export class CondenseTool implements IDiracTool {
	spec(): DiracToolSpec {
		return condense_spec
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
		// Show notification if enabled
		if (!env.config.isSubagentExecution && env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dirac wants to condense the conversation...",
				message: `Dirac is suggesting to condense your conversation with: ${context}`,
			})
		}

		const card = !env.config.isSubagentExecution
			? await env.ui.createCard({
					header: "Condense Conversation",
					icon: DiracIcon.CHAT,
					requireApproval: true,
					collapsed: false,
					actions: [
						{ label: "Condense", value: DiracAskResponse.APPROVE, primary: true },
						{ label: "Cancel", value: DiracAskResponse.REJECT, style: "secondary" },
					],
				})
			: undefined

		if (card) {
			await card.update({ body: context })
		} else {
			// Subagents shouldn't really be calling condense, but if they do, we skip it
			return formatResponse.toolResult(formatResponse.condense())
		}

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		const interaction = await card.waitForInteraction()
		const text = interaction.action === DiracAskResponse.APPROVE ? "" : interaction.text || "cancel"
		const images: string[] = []
		const condenseFiles: string[] = []

		const apiConfig = env.config.services.stateManager.getApiConfiguration()
		const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		if (text || (images && images.length > 0) || (condenseFiles && condenseFiles.length > 0)) {
			let fileContentString = ""
			if (condenseFiles && condenseFiles.length > 0) {
				fileContentString = await processFilesIntoText(condenseFiles)
			}

			await card.update({
				body: `Condense cancelled: ${text}`,
			})
			await card.finalize(CardStatus.CANCELLED)

			telemetryService.captureToolUsage(
				env.config.ulid,
				this.spec().id,
				env.config.api.getModel().id,
				provider,
				false, // autoApproved - condense is never auto-approved
				false, // success=false because user provided feedback instead
				undefined,
				true, // isNativeToolCall
			)
			return formatResponse.toolResult(
				`The user provided feedback on the condensed conversation summary:\n<feedback>\n${text}\n</feedback>`,
				images,
				fileContentString,
			)
		}

		const history = env.orchestration.getHistory()
		const lastMessage = history[history.length - 1]
		const summaryAlreadyAppended = lastMessage && lastMessage.content.type === DiracMessageType.MARKDOWN
		const keepStrategy = summaryAlreadyAppended ? "lastTwo" : "none"

		const range = env.orchestration.getNextTruncationRange(keepStrategy)
		env.orchestration.setTruncationRange(range)
		await env.orchestration.resetTransientState()

		telemetryService.captureToolUsage(
			env.config.ulid,
			this.spec().id,
			env.config.api.getModel().id,
			provider,
			false, // autoApproved - condense is never auto-approved
			true,
			undefined,
			true, // isNativeToolCall
		)

		await card.update({
			header: "Conversation Condensed",
			collapsed: true,
		})
		await card.finalize(CardStatus.SUCCESS)

		return formatResponse.toolResult(formatResponse.condense())
	}
}
