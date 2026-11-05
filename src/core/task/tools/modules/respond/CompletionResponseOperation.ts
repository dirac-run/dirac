import { CardHeader } from "@shared/cardIdentity"
import { CardKind, CardStatus } from "@shared/ExtensionMessage"
import { ResponseOperation, responseCardInput } from "@shared/responseTool"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool } from "@/shared/tools"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export class CompletionResponseOperation {
	async execute(result: string, env: IToolEnvironment): Promise<any> {
		const completion = env.goal
			? await env.goal.commitCompletion(result)
			: await env.orchestration.commitAttemptCompletion(result)
		if (!completion.committed) {
			return `Completion rejected: ${completion.error}`
		}
		env.orchestration.setTaskState("completionCommitted", true)
		env.orchestration.setTaskState("didAttemptCompletion", true)
		env.orchestration.commitCompletionResponse(result)

		if (env.config.executionProfile !== "tasklet") {
			try {
				await this.handleCompletionResult(env, result)
				if (env.config.executionProfile === "standalone") {
					await env.orchestration.runHook("TaskComplete", {
						taskComplete: {
							taskMetadata: {
								taskId: env.config.taskId,
								ulid: env.config.ulid,
								result,
							},
						},
					})
				}
			} catch (error) {
				env.logging.warn("Completion was committed, but a completion artifact failed", error)
			}

			try {
				if (env.config.autoApprovalSettings.enableNotifications) {
					env.system.showNotification({
						subtitle: "Task Completed",
						message: result.replace(/\n/g, " "),
					})
				}
				env.telemetry.captureTaskCompleted()
				if (env.config.executionProfile === "standalone") {
					await env.orchestration.runHook("Notification", {
						notification: {
							event: "task_completed",
							source: `${DiracDefaultTool.RESPOND}:${ResponseOperation.COMPLETE}`,
							message: result,
							waitingForUserInput: true,
						},
					})
				}
			} catch (error) {
				env.logging.warn("Completion succeeded, but a completion notification failed", error)
			}
		}
		env.telemetry.captureCustomMetadata({ operation: ResponseOperation.COMPLETE, mode: env.config.mode })

		return result
	}

	private async handleCompletionResult(env: IToolEnvironment, result: string): Promise<void> {
		const card = await env.ui.createCard({
			kind: CardKind.TASK_COMPLETION,
			toolName: DiracDefaultTool.RESPOND,
			icon: DiracIcon.COMPLETE,
			header: CardHeader.TASK_COMPLETED,
			body: result,
			rawInput: responseCardInput(ResponseOperation.COMPLETE, result),
			renderType: "markdown",
			collapsed: false,
			maxHeight: 1200,
		})
		await card.finalize(CardStatus.SUCCESS, true)
		await env.orchestration.saveCheckpoint(true, card.id)
	}
}
