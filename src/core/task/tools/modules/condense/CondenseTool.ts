import { formatResponse } from "@core/formatResponse"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { formatCurrentTurnUserRequests } from "@core/text-condensation/CurrentTurnUserRequests"
import { CONVERSATION_CONTINUATION_TEMPLATE_ID } from "@core/text-condensation/templates"
import { showSystemNotification } from "@integrations/notifications"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { telemetryService } from "@/services/telemetry"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
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
			required: false,
			instruction:
				"Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps. Omit only when the Utility model conversation-condensation capability is available.",
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
		const source = this.getSource(env)
		const signal = env.orchestration.getTaskState("abortSignal")
		const currentTurnUserRequests = env.orchestration.getCurrentTurnUserRequests()
		const context = await this.resolveContext(args.context, currentTurnUserRequests, signal, env)
		this.throwIfCancelled(signal)
		if (context === null) {
			return formatResponse.toolResult(
				"Utility condensation failed. Generate the comprehensive continuation summary from the current conversation yourself and call `condense` again with the complete `context` parameter. Do not call it again without context.",
			)
		}
		if (context === undefined) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError("Missing required parameter: context")
		}

		this.consumeSource(env)
		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		const approval = source === "user" ? await this.requestUserApproval(context, env) : undefined
		this.throwIfCancelled(signal)
		if (approval && !approval.approved) {
			this.captureToolUsage(false, env)
			return formatResponse.toolResult(
				`The user provided feedback on the condensed conversation summary:\n<feedback>\n${approval.feedback}\n</feedback>`,
			)
		}

		const range = env.orchestration.getNextTruncationRange("lastTwo")
		const hookResult = await this.runPreCompactHook(source, range, env)
		this.throwIfCancelled(signal)
		if (hookResult.cancel) {
			await this.finalizeCancelledApproval(approval)
			return formatResponse.toolError("Context compaction was cancelled by PreCompact hook.")
		}

		let result = continuationPrompt(context, currentTurnUserRequests)
		if (hookResult.contextModification) {
			result += `\n\n[Context Modification from PreCompact Hook]\n${hookResult.contextModification}`
		}

		await this.applyCompaction(range, env, signal)
		await this.runPostCompactionEffects(context, source, approval, env)

		return formatResponse.toolResult(result)
	}

	private throwIfCancelled(signal: AbortSignal): void {
		if (signal.aborted) throw new Error("Task instance aborted")
	}

	private async runPostCompactionEffects(
		context: string,
		source: CondenseSource,
		approval: ApprovalResult | undefined,
		env: IToolEnvironment,
	): Promise<void> {
		try {
			await env.orchestration.resetTransientState()
		} catch (error) {
			env.logging.warn("Failed to reset transient state after conversation compaction", error)
		}

		try {
			await this.displayCompletedSummary(context, source, approval, env)
		} catch (error) {
			env.logging.warn("Failed to present completed conversation compaction", error)
		}

		try {
			env.orchestration.notifyContextCompacted()
		} catch (error) {
			env.logging.warn("Failed to report completed conversation compaction", error)
		}

		try {
			this.captureSuccessfulCondense(source, env)
		} catch (error) {
			env.logging.warn("Failed to record completed conversation compaction", error)
		}
	}

	private getSource(env: IToolEnvironment): CondenseSource {
		return env.orchestration.getTaskState("pendingCondenseSource") ?? "user"
	}

	private consumeSource(env: IToolEnvironment): void {
		env.orchestration.setTaskState("pendingCondenseSource", undefined)
	}

	private async resolveContext(
		context: unknown,
		currentTurnUserRequests: readonly string[],
		signal: AbortSignal,
		env: IToolEnvironment,
	): Promise<string | null | undefined> {
		if (typeof context === "string" && context.trim().length > 0) return context

		const condensation = env.conversationCondensation
		if (!condensation?.isAvailable(CONVERSATION_CONTINUATION_TEMPLATE_ID)) return undefined

		try {
			const result = await condensation.condenseConversation(CONVERSATION_CONTINUATION_TEMPLATE_ID, {
				historyScope: "effective",
				signal,
				additionalSourceText: formatCurrentTurnUserRequests(currentTurnUserRequests),
			})
			if (signal.aborted) throw new Error("Task instance aborted")
			if (result.text.trim().length === 0) {
				throw new Error("Utility condensation returned empty context")
			}
			return result.text
		} catch (error) {
			if (signal.aborted) throw error
			env.logging.warn("Utility conversation condensation failed", error)
			return null
		}
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

	private async applyCompaction(range: [number, number], env: IToolEnvironment, signal: AbortSignal): Promise<void> {
		const previousConversationHistoryDeletedRange = env.orchestration.getTaskState("conversationHistoryDeletedRange")
		const previousSkipNextAutoCondenseCheck = env.orchestration.getTaskState("skipNextAutoCondenseCheck")
		const previousPendingCompaction = env.orchestration.getTaskState("pendingApiConversationCompaction")
		const previousProviderState = env.config.messageState.getApiConversationProviderState()
		const pendingCompaction = {
			previousConversationHistoryDeletedRange,
			conversationHistoryDeletedRange: range,
		}

		this.throwIfCancelled(signal)
		try {
			await env.config.messageState.overwriteApiConversationProviderState({
				...previousProviderState,
				pendingCompaction,
			})
			this.throwIfCancelled(signal)

			env.orchestration.setTruncationRange(range)
			env.orchestration.setTaskState("skipNextAutoCondenseCheck", true)
			env.orchestration.setTaskState("pendingApiConversationCompaction", pendingCompaction)
			await env.config.messageState.saveDiracMessagesAndUpdateHistory()
			this.throwIfCancelled(signal)
		} catch (error) {
			env.orchestration.setTaskState("conversationHistoryDeletedRange", previousConversationHistoryDeletedRange)
			env.orchestration.setTaskState("skipNextAutoCondenseCheck", previousSkipNextAutoCondenseCheck)
			env.orchestration.setTaskState("pendingApiConversationCompaction", previousPendingCompaction)
			await env.config.messageState.overwriteApiConversationProviderState(previousProviderState)
			await env.config.messageState.saveDiracMessagesAndUpdateHistory()
			throw error
		}
	}

	private captureSuccessfulCondense(source: CondenseSource, env: IToolEnvironment): void {
		const telemetryData = this.getContextTelemetry(env)
		if (telemetryData) {
			const provider = env.config.providerId
			telemetryService.captureCondense(
				env.config.ulid,
				env.config.model.id,
				provider,
				source,
				telemetryData.tokensUsed,
				telemetryData.maxContextWindow,
			)
		}
		this.captureToolUsage(true, env)
	}

	private captureToolUsage(success: boolean, env: IToolEnvironment): void {
		const provider = env.config.providerId
		telemetryService.captureToolUsage(
			env.config.ulid,
			this.spec().id,
			env.config.model.id,
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
			env.config.model.info.contextWindow || 256_000,
			env.config.taskState.lastAutoCondenseTriggerIndex,
		)
	}
}
