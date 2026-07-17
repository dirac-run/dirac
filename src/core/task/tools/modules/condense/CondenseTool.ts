import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@/services/telemetry"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { formatResponse } from "@core/formatResponse"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { stripHashes } from "../../../../../shared/utils/line-hashing"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const condense_spec: DiracToolSpec = {
	id: DiracDefaultTool.CONDENSE,
	name: "condense",
	description: "Condense the conversation to free up context window space while preserving the current task.",
	parameters: [
		{
			name: "context",
			required: true,
			instruction:
				"Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps.",
		},
	],
}

type CondenseSource = "automatic" | "user"

type ApprovalResult = { approved: true; card: ICardHandle } | { approved: false; feedback: string }

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

		const source = this.consumeSource(env)
		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		const approval = source === "user" ? await this.requestUserApproval(context, env) : undefined
		if (approval && !approval.approved) {
			this.captureToolUsage(false, env)
			return formatResponse.toolResult(
				`The user provided feedback on the condensed conversation summary:\n<feedback>\n${approval.feedback}\n</feedback>`,
			)
		}

		const range = env.orchestration.getNextTruncationRange("lastTwo")
		const hookResult = await this.runPreCompactHook(source, range, env)
		if (hookResult.cancel) {
			await this.finalizeCancelledApproval(approval)
			return formatResponse.toolError("Context compaction was cancelled by PreCompact hook.")
		}

		let result = continuationPrompt(context)
		if (hookResult.contextModification) {
			result += `\n\n[Context Modification from PreCompact Hook]\n${hookResult.contextModification}`
		}

		await this.applyCompaction(range, env)
		await this.displayCompletedSummary(context, source, approval, env)
		this.captureSuccessfulCondense(source, env)

		return formatResponse.toolResult(result)
	}

	private consumeSource(env: IToolEnvironment): CondenseSource {
		const source = env.orchestration.getTaskState("pendingCondenseSource") ?? "user"
		env.orchestration.setTaskState("pendingCondenseSource", undefined)
		return source
	}

	private async requestUserApproval(context: string, env: IToolEnvironment): Promise<ApprovalResult> {
		if (env.config.isSubagentExecution) {
			throw new Error("Subagents cannot condense the parent conversation.")
		}

		if (env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Dirac wants to condense the conversation...",
				message: "Review the generated conversation summary before condensing.",
			})
		}

		const card = await env.ui.createCard({
			header: "Condense Conversation",
			icon: DiracIcon.CHAT,
			requireApproval: true,
			collapsed: false,
			actions: [
				{ label: "Condense", value: DiracAskResponse.APPROVE, primary: true },
				{ label: "Cancel", value: DiracAskResponse.REJECT, style: "secondary" },
			],
		})
		await card.update({ body: stripHashes(context), renderType: "markdown" })

		const interaction = await card.waitForInteraction()
		if (interaction.action === DiracAskResponse.APPROVE) {
			return { approved: true, card }
		}

		const feedback = interaction.text || "cancel"
		await card.update({ body: `Condense cancelled: ${feedback}` })
		await card.finalize(CardStatus.CANCELLED)
		return { approved: false, feedback }
	}

	private async finalizeCancelledApproval(approval: ApprovalResult | undefined): Promise<void> {
		if (!approval?.approved) return
		await approval.card.update({ body: "Condense cancelled by PreCompact hook." })
		await approval.card.finalize(CardStatus.CANCELLED)
	}

	private async displayCompletedSummary(
		context: string,
		source: CondenseSource,
		approval: ApprovalResult | undefined,
		env: IToolEnvironment,
	): Promise<void> {
		if (source === "user") {
			if (!approval?.approved) throw new Error("Approved user condense is missing its approval card.")
			await approval.card.update({ header: "Conversation Condensed", collapsed: true })
			await approval.card.finalize(CardStatus.SUCCESS)
			return
		}
		if (env.config.isSubagentExecution) return

		const card = await env.ui.createCard({
			header: "Conversation Condensed",
			status: CardStatus.RUNNING,
			icon: DiracIcon.SUMMARIZE,
			collapsed: true,
		})
		await card.update({
			status: CardStatus.SUCCESS,
			body: stripHashes(context),
			renderType: "markdown",
		})
		await card.finalize(CardStatus.SUCCESS)
	}

	private async runPreCompactHook(source: CondenseSource, range: [number, number], env: IToolEnvironment) {
		const telemetryData = this.getContextTelemetry(env)
		return await env.orchestration.runHook(
			"PreCompact",
			{
				ulid: env.config.ulid,
				contextSize: telemetryData?.tokensUsed ?? 0,
				compactionStrategy: source === "automatic" ? "auto-condense" : "user-condense",
				tokensIn: telemetryData?.tokensUsed ?? 0,
				tokensOut: 0,
				tokensInCache: 0,
				tokensOutCache: 0,
				deletedRangeStart: range[0],
				deletedRangeEnd: range[1],
			},
			{ isCancellable: true },
		)
	}

	private async applyCompaction(range: [number, number], env: IToolEnvironment): Promise<void> {
		env.orchestration.setTruncationRange(range)
		env.orchestration.setTaskState("skipNextAutoCondenseCheck", true)
		await env.orchestration.resetTransientState()
		await env.config.messageState.saveDiracMessagesAndUpdateHistory()
	}

	private captureSuccessfulCondense(source: CondenseSource, env: IToolEnvironment): void {
		const telemetryData = this.getContextTelemetry(env)
		if (telemetryData) {
			const apiConfig = env.config.services.stateManager.getApiConfiguration()
			const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
			telemetryService.captureCondense(
				env.config.ulid,
				env.config.api.getModel().id,
				provider,
				source,
				telemetryData.tokensUsed,
				telemetryData.maxContextWindow,
			)
		}
		this.captureToolUsage(true, env)
	}

	private captureToolUsage(success: boolean, env: IToolEnvironment): void {
		const apiConfig = env.config.services.stateManager.getApiConfiguration()
		const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		telemetryService.captureToolUsage(
			env.config.ulid,
			this.spec().id,
			env.config.api.getModel().id,
			provider,
			false,
			success,
			undefined,
			true,
		)
	}

	private getContextTelemetry(env: IToolEnvironment) {
		return env.config.services.contextManager.getContextTelemetryData(
			env.config.messageState.getDiracMessages(),
			env.config.api,
			env.config.taskState.lastAutoCondenseTriggerIndex,
		)
	}
}
