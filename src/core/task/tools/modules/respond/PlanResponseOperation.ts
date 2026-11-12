import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracDefaultTool } from "@/shared/tools"
import { findLastIndex } from "@shared/array"
import { DiracPlanModeResponse } from "@shared/proto/dirac/ui"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import {
	isPlanResponseCard,
	PlanInteractionResponse,
	ResponseCardHeader,
	ResponseOperation,
	responseCardInput,
} from "@shared/responseTool"
import { formatResponse } from "@core/formatResponse"

export async function presentPlanForApproval(response: string, env: IToolEnvironment): Promise<any> {
	const options: string[] = []
	const sharedMessage = { response, options, selected: "" } satisfies DiracPlanModeResponse
	const yoloMode = env.config.yoloModeToggled

	const cardHandle = await env.ui.createCard({
		header: ResponseCardHeader.PROPOSED_PLAN,
		toolName: DiracDefaultTool.RESPOND,
		icon: DiracIcon.PLAN,
		body: response,
		rawInput: responseCardInput(ResponseOperation.PLAN, response),
		renderType: "markdown",
		requireFeedback: !yoloMode,
		collapsed: false,
		maxHeight: 10000,
		do_not_auto_collapse: true,
	})

	if (!yoloMode) {
		env.orchestration.setTaskState("isAwaitingPlanResponse", true)
		await env.ui.publishState()
	}

	if (yoloMode) {
		const wasPlanMode = env.config.mode === "plan"
		if (wasPlanMode) {
			const switchSuccessful = await env.orchestration.switchToActMode()
			if (!switchSuccessful) {
				env.orchestration.reportFailure()
				await cardHandle.finalize(CardStatus.ERROR, true)
				return formatResponse.toolError("Failed to switch to ACT MODE.")
			}
		}

		await cardHandle.update({ header: ResponseCardHeader.PLAN_ACCEPTED })
		await cardHandle.finalize(CardStatus.SUCCESS, true)
		return formatResponse.toolResult(
			wasPlanMode
				? `[The user has switched to ACT MODE, so you may now proceed with the task.]`
				: `[Go ahead and execute.]`,
		)
	}

	const {
		value,
		text,
		images,
		files: planResponseFiles,
	} = await cardHandle.waitForInteraction().finally(async () => {
		env.orchestration.setTaskState("isAwaitingPlanResponse", false)
		await env.ui.publishState()
	})

	const userText = text === PlanInteractionResponse.MODE_TOGGLE ? "" : (text ?? "")

	await promptUserDecision(userText, images, planResponseFiles, options, sharedMessage, env)

	const fileContentString =
		planResponseFiles && planResponseFiles.length > 0 ? await env.workspace.formatAttachedFiles(planResponseFiles) : ""

	const didSwitchMode = value === PlanInteractionResponse.MODE_TOGGLE
	const selectedOption = userText && options.includes(userText)

	if (didSwitchMode || selectedOption) {
		await cardHandle.update({ header: ResponseCardHeader.PLAN_ACCEPTED })
		await cardHandle.finalize(CardStatus.SUCCESS, true)
	} else {
		await cardHandle.finalize(CardStatus.SKIPPED, true)
	}

	if (didSwitchMode) {
		return formatResponse.toolResult(
			`[The user has switched to ACT MODE, so you may now proceed with the task.]` +
			(userText
				? `\n\nThe user also provided the following message when switching to ACT MODE:\n<user_message>\n${userText}\n</user_message>`
				: ""),
			images,
			fileContentString,
		)
	}

	// Checkpoint after plan acceptance to mark this meaningful boundary
	await env.orchestration.saveCheckpoint()

	return formatResponse.toolResult(`<user_message>\n${userText}\n</user_message>`, images, fileContentString)
}

async function promptUserDecision(
	text: string,
	images: string[] | undefined,
	planResponseFiles: string[] | undefined,
	options: string[],
	sharedMessage: DiracPlanModeResponse,
	env: IToolEnvironment,
) {
	if (text && options.includes(text)) {
		env.telemetry.captureOptionSelected(options.length, env.config.mode)
		await patchLastPlanCard({ ...sharedMessage, selected: text }, env)
	} else if (text || (images && images.length > 0) || (planResponseFiles && planResponseFiles.length > 0)) {
		env.telemetry.captureOptionsIgnored(options.length, env.config.mode)
		await env.ui.upsertText(text ?? "", false, "user")
	}
}

async function patchLastPlanCard(body: DiracPlanModeResponse, env: IToolEnvironment): Promise<void> {
	const history = env.orchestration.getHistory()
	const lastPlanMessageIndex = findLastIndex(
		history,
		(m: any) => m.content.type === DiracMessageType.CARD && isPlanResponseCard(m.content.card),
	)
	if (lastPlanMessageIndex === -1) return

	const lastMsg = history[lastPlanMessageIndex]
	if (lastMsg.content.type !== DiracMessageType.CARD) return

	await env.orchestration.updateMessage(lastPlanMessageIndex, {
		content: {
			...lastMsg.content,
			card: {
				...lastMsg.content.card,
				body: JSON.stringify(body),
			},
		},
	})
}
