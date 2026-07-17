import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { findLastIndex } from "@shared/array"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@shared/icons"
import { parsePartialArrayString } from "@shared/array"
import { formatResponse } from "@core/formatResponse"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@/services/telemetry"

export const ask_followup_question_spec: DiracToolSpec = {
	id: DiracDefaultTool.ASK,
	name: "ask_followup_question",
	description: "Asks the user a clarifying question when you encounter ambiguities or need more details.",
	parameters: [
		{
			name: "question",
			required: true,
			instruction: "The question to ask the user.",
		},
		{
			name: "options",
			required: false,
			instruction: "Optional array of 2-5 predefined answer options. DO NOT include options to toggle Act mode.",
		},
	],
}

export class AskFollowupQuestionTool implements IDiracTool {
	spec(): DiracToolSpec {
		return ask_followup_question_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { question, options: optionsRaw } = args

		if (!question) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError("Missing required parameter: question")
		}
		// Show notification if enabled
		if (!env.config.isSubagentExecution && env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dirac has a question...",
				message: question.replace(/\n/g, " "),
			})
		}

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		if (env.config.yoloModeToggled) {
			await env.ui.upsertText(
				`[YOLO MODE] Auto-responding to question: "${question.substring(0, 100)}${question.length > 100 ? "..." : ""}"`,
			)
			return formatResponse.toolResult(
				`[YOLO MODE: User input is not available in non-interactive mode. You must use available tools (read_file, list_files, search_files, etc.) to gather the information you need instead of asking the user. Proceed with using tools to find the answer to your question: "${question}"]`,
			)
		}

		const sharedMessage = {
			question,
			options: parsePartialArrayString(optionsRaw || "[]"),
			selected: "",
		}
		const cardHandle = await env.ui.createCard({
			header: `Question: ${question.length > 60 ? question.substring(0, 57) + "..." : question}`,
			icon: DiracIcon.FOLLOW_UP,
			body: question,
			rawInput: { tool: "ask_followup_question", question, options: sharedMessage.options },
			renderType: "markdown",
			requireFeedback: true,
			feedbackPlaceholder: "Type another answer",
			actions: sharedMessage.options.map((opt) => ({ label: opt, value: opt })),
			collapsed: false,
			maxHeight: 1200,
		})
		const { response, value, text: interactionText, images, files: followupFiles } = await cardHandle.waitForInteraction()
		if (response === DiracAskResponse.REJECT) {
			await cardHandle.update({
				header: `Declined: ${question.length > 40 ? question.substring(0, 37) + "..." : question}`,
				body: "The user declined to answer.",
				collapsed: true,
				outcome: "declined",
			})
			await cardHandle.finalize(CardStatus.SKIPPED)
			return formatResponse.toolResult("The user declined to answer the follow-up question.")
		}

		const text = interactionText || value

		await cardHandle.update({
			header: `Answered: ${question.length > 40 ? question.substring(0, 37) + "..." : question}`,
			body: `**Answer:** ${text || "(no answer)"}`,
			collapsed: true,
			outcome: "accepted",
		})
		await cardHandle.finalize(CardStatus.SUCCESS)

		const apiConfig = env.config.services.stateManager.getApiConfiguration()
		const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		const options = parsePartialArrayString(optionsRaw || "[]")
		if (optionsRaw && text && options.includes(text)) {
			const history = env.orchestration.getHistory()
			telemetryService.captureOptionSelected(env.config.ulid, options.length, env.config.mode)

			const lastFollowupMessageIndex = findLastIndex(
				history,
				(m: any) => m.content.type === DiracMessageType.CARD && m.content.card.header === "Follow-up Question",
			)
			if (lastFollowupMessageIndex !== -1) {
				const lastMsg = history[lastFollowupMessageIndex]
				if (lastMsg.content.type === DiracMessageType.CARD) {
					await env.orchestration.updateMessage(lastFollowupMessageIndex, {
						content: {
							...lastMsg.content,
							card: {
								...lastMsg.content.card,
								body: JSON.stringify({
									...sharedMessage,
									selected: text,
								}),
							},
						},
					})
				}
			}
		} else {
			telemetryService.captureOptionsIgnored(env.config.ulid, options.length, env.config.mode)
			await env.ui.upsertText(text ?? "", false, "user")
		}

		let fileContentString = ""
		if (followupFiles && followupFiles.length > 0) {
			fileContentString = await processFilesIntoText(followupFiles)
		}

		telemetryService.captureToolUsage(
			env.config.ulid,
			this.spec().id,
			env.config.api.getModel().id,
			provider,
			false, // autoApproved - ask_followup_question is never auto-approved
			true,
			undefined,
			true, // isNativeToolCall
		)

		return formatResponse.toolResult(`<answer>\n${text}\n</answer>`, images, fileContentString)
	}
}
