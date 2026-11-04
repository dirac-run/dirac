import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracDefaultTool } from "@/shared/tools"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@shared/icons"
import { ResponseCardHeader, ResponseOperation, responseCardInput } from "@shared/responseTool"
import { formatResponse } from "@core/formatResponse"

export async function requestQuestionResponse(question: string, options: string[], env: IToolEnvironment): Promise<any> {
	// Show notification if enabled
	if (env.config.autoApprovalSettings.enableNotifications) {
		env.system.showNotification({
			subtitle: "Dirac has a question...",
			message: question.replace(/\n/g, " "),
		})
	}

	if (env.config.yoloModeToggled) {
		env.telemetry.captureCustomMetadata({ answerType: "unavailable" })
		await env.ui.upsertText(
			`[YOLO MODE] Auto-responding to question: "${question.substring(0, 100)}${question.length > 100 ? "..." : ""}"`,
		)
		return formatResponse.toolResult(
			`[YOLO MODE: User input is not available in non-interactive mode. You must use available tools (read_file, list_files, search_files, etc.) to gather the information you need instead of asking the user. Proceed with using tools to find the answer to your question: "${question}"]`,
		)
	}

	const cardHandle = await env.ui.createCard({
		header: ResponseCardHeader.QUESTION,
		toolName: DiracDefaultTool.RESPOND,
		icon: DiracIcon.FOLLOW_UP,
		body: question,
		rawInput: responseCardInput(ResponseOperation.QUESTION, question, options.length ? options : undefined),
		renderType: "markdown",
		requireFeedback: true,
		feedbackPlaceholder: "Or type your own answer…",
		actions: options.map((option) => ({ label: option, value: option })),
		collapsed: false,
		maxHeight: 1200,
	})
	const { response, value, text: interactionText, images, files: followupFiles } = await cardHandle.waitForInteraction()
	if (response === DiracAskResponse.REJECT) {
		env.telemetry.captureCustomMetadata({ answerType: "declined" })
		await cardHandle.update({
			header: ResponseCardHeader.QUESTION_DECLINED,
			body: `${question}\n\n*The user declined to answer.*`,
			rawOutput: { declined: true },
			requireFeedback: false,
			actions: [],
			collapsed: true,
			outcome: "declined",
		})
		await cardHandle.finalize(CardStatus.SKIPPED)
		return formatResponse.toolResult("The user declined to answer the follow-up question.")
	}

	const selectedChoice = value && options.includes(value) ? value : undefined
	const text = selectedChoice || interactionText || value
	await cardHandle.update({
		header: ResponseCardHeader.ANSWERED,
		body: `${question}\n\n---\n\n**Answer:** ${text || "(no answer)"}`,
		rawOutput: { answer: text || "", selectedChoice },
		requireFeedback: false,
		actions: [],
		collapsed: true,
		outcome: "accepted",
	})
	await cardHandle.finalize(CardStatus.SUCCESS)

	if (text) {
		await env.ui.upsertText(text, false, "user")
	}

	if (selectedChoice) {
		env.telemetry.captureOptionSelected(options.length, env.config.mode)
	} else {
		env.telemetry.captureOptionsIgnored(options.length, env.config.mode)
	}
	env.telemetry.captureCustomMetadata({
		answerType: selectedChoice ? "choice" : text ? "free_text" : "empty",
	})

	let fileContentString = ""
	if (followupFiles && followupFiles.length > 0) {
		fileContentString = await env.workspace.formatAttachedFiles(followupFiles)
	}

	return formatResponse.toolResult(`<answer>\n${text ?? ""}\n</answer>`, images, fileContentString)
}
