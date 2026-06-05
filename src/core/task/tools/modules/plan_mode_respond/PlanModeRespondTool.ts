import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { findLastIndex } from "@shared/array"
import { DiracPlanModeResponse } from "@shared/proto/dirac/ui"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { parsePartialArrayString } from "@shared/array"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { telemetryService } from "@/services/telemetry"
import { getTaskCompletionTelemetry } from "../../utils"

const PLAN_CARD_HEADER = "Proposed Plan"
const PLAN_ACCEPTED_HEADER = "Plan Accepted"
const PLAN_MODE_TOGGLE_SENTINEL = "PLAN_MODE_TOGGLE_RESPONSE"

export const plan_mode_respond_spec: DiracToolSpec = {
	id: DiracDefaultTool.PLAN_MODE,
	name: "plan_mode_respond",
	description:
		"Proposes a step-by-step solution plan to the user. Use only in PLAN MODE after exploring the codebase. Avoid repeating the plan in text.",
	parameters: [
		{
			name: "response",
			required: true,
			instruction: "The response to provide to the user.",
		},
		{
			name: "needs_more_exploration",
			required: false,
			instruction: "Set to true if more exploration is required.",
			type: "boolean",
		},
	],
}

export class PlanModeRespondTool implements IDiracTool {
	spec(): DiracToolSpec {
		return plan_mode_respond_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { response, options: optionsRaw, needs_more_exploration: needsMoreExploration } = args

		if (!response) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
			return formatResponse.toolError("Missing required parameter: response")
		}

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		if (needsMoreExploration === true || needsMoreExploration === "true") {
			return formatResponse.toolResult(
				`[You have indicated that you need more exploration. Proceed with calling tools to continue the planning process.]`
			)
		}

		if (env.config.yoloModeToggled && env.config.mode === "act") {
			return formatResponse.toolResult(`[Go ahead and execute.]`)
		}

		const options = parsePartialArrayString(optionsRaw || "[]")
		const sharedMessage = { response, options, selected: "" } satisfies DiracPlanModeResponse

		const actModeSwitchResult = await this.handleActModeSwitch(sharedMessage, env)
		if (actModeSwitchResult) return actModeSwitchResult

		env.orchestration.setTaskState("isAwaitingPlanResponse", true)
		const cardHandle = await env.ui.createCard({
			header: PLAN_CARD_HEADER,
			icon: DiracIcon.PLAN,
			body: response,
			renderType: "markdown",
			requireFeedback: true,
			collapsed: false,
			maxHeight: 10000,
			do_not_auto_collapse: true,
		})
		const { text, images, files: planResponseFiles } = await cardHandle.waitForInteraction()
		env.orchestration.setTaskState("isAwaitingPlanResponse", false)

		const userText = text === PLAN_MODE_TOGGLE_SENTINEL ? "" : (text ?? "")

		await this.handleUserResponse(userText, images, planResponseFiles, options, sharedMessage, env)

		const fileContentString = planResponseFiles && planResponseFiles.length > 0 ? await processFilesIntoText(planResponseFiles) : ""

		this.captureTelemetry(env)

		const didSwitchMode = env.orchestration.getTaskState("didRespondToPlanAskBySwitchingMode")
		const selectedOption = optionsRaw && userText && options.includes(userText)

		if (didSwitchMode || selectedOption) {
			await cardHandle.update({ header: PLAN_ACCEPTED_HEADER })
			await cardHandle.finalize(CardStatus.SUCCESS, true)
		} else {
			await cardHandle.finalize(CardStatus.SKIPPED, true)
		}

		if (didSwitchMode) {
			env.orchestration.setTaskState("didRespondToPlanAskBySwitchingMode", false)
			return formatResponse.toolResult(
				`[The user has switched to ACT MODE, so you may now proceed with the task.]` +
					(userText ? `\n\nThe user also provided the following message when switching to ACT MODE:\n<user_message>\n${userText}\n</user_message>` : ""),
				images,
				fileContentString,
			)
		}

		// Checkpoint after plan acceptance to mark this meaningful boundary
		await env.orchestration.saveCheckpoint()

		return formatResponse.toolResult(`<user_message>\n${userText}\n</user_message>`, images, fileContentString)
	}

	private async handleActModeSwitch(sharedMessage: DiracPlanModeResponse, env: IToolEnvironment): Promise<any | null> {
		if (env.config.mode !== "plan" || !env.config.yoloModeToggled) {
			return null
		}

		const switchSuccessful = await env.orchestration.switchToActMode()
		if (!switchSuccessful) return null

		await this.patchLastPlanCard(sharedMessage, env)
		return formatResponse.toolResult(`[The user has switched to ACT MODE, so you may now proceed with the task.]`)
	}

	private async handleUserResponse(
		text: string,
		images: string[] | undefined,
		planResponseFiles: string[] | undefined,
		options: string[],
		sharedMessage: DiracPlanModeResponse,
		env: IToolEnvironment,
	) {
		if (text && options.includes(text)) {
			telemetryService.captureOptionSelected(env.config.ulid, options.length, "plan")
			await this.patchLastPlanCard({ ...sharedMessage, selected: text }, env)
		} else if (text || (images && images.length > 0) || (planResponseFiles && planResponseFiles.length > 0)) {
			telemetryService.captureOptionsIgnored(env.config.ulid, options.length, "plan")
			await env.ui.upsertText(text ?? "", false, "user")
		}
	}

	private async patchLastPlanCard(body: DiracPlanModeResponse, env: IToolEnvironment): Promise<void> {
		const history = env.orchestration.getHistory()
		const lastPlanMessageIndex = findLastIndex(
			history,
			(m: any) => m.content.type === DiracMessageType.CARD && m.content.card.header === PLAN_CARD_HEADER,
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

	private captureTelemetry(env: IToolEnvironment) {
		const apiConfig = env.config.services.stateManager.getApiConfiguration()
		const provider = apiConfig.planModeApiProvider as string

		telemetryService.captureTaskCompleted(env.config.ulid, getTaskCompletionTelemetry(env.config))

		telemetryService.captureToolUsage(
			env.config.ulid,
			this.spec().id,
			env.config.api.getModel().id,
			provider,
			false, // autoApproved
			true,
			undefined,
			true, // isNativeToolCall
		)
	}
}
