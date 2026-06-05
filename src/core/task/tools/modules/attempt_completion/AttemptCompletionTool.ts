import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { DiracIcon } from "@/shared/icons"
import { formatResponse } from "@core/prompts/responses"
import {
	DiracMessageType,
	CardStatus
} from "@shared/ExtensionMessage"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@/services/telemetry"
import { getTaskCompletionTelemetry } from "../../utils"

export const attempt_completion_spec: DiracToolSpec = {
	id: DiracDefaultTool.ATTEMPT,
	name: "attempt_completion",
	description: "Presents a brief and informative summary of the final result. Keep it concise while covering important changes. Avoid redundant text.",
	parameters: [
		{
			name: "result",
			required: true,
			instruction: "The final result of the task.",
		},
		{
			name: "command",
			required: false,
			instruction: "Optional CLI command to demo the result (e.g., 'open index.html'). Do not use 'echo' or 'cat'.",
		},
	],
}


export class AttemptCompletionTool implements IDiracTool {
	spec(): DiracToolSpec {
		return attempt_completion_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { result, command } = args

		if (!result) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
			return formatResponse.toolError("Missing required parameter: result")
		}

		env.orchestration.setTaskState("consecutiveMistakeCount", 0)

		// Double-check completion
		const doubleCheckResponse = await this.handleDoubleCheckCompletion(env, result)
		if (doubleCheckResponse) {
			return doubleCheckResponse
		}

		env.orchestration.setTaskState("doubleCheckCompletionPending", false)

		// Show notification if enabled
		if (!env.config.isSubagentExecution && env.config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Task Completed",
				message: result.replace(/\n/g, " "),
			})
		}

		let commandResult: any
		if (command) {
			const cmdExecResult = await this.handleCommandExecution(env, result, command)
			if (cmdExecResult.userRejected) {
				return cmdExecResult.commandResult
			}
			commandResult = cmdExecResult.commandResult
		} else {
			await this.handleCompletionResult(env, result)
		}

		// Run TaskComplete hook
		await env.orchestration.runHook("TaskComplete", {
			taskComplete: {
				taskMetadata: {
					taskId: env.config.taskId,
					ulid: env.config.ulid,
					result,
					command: command || "",
				},
			},
		})

		return result
	}

	private async handleDoubleCheckCompletion(env: IToolEnvironment, result: string): Promise<any | undefined> {
		if (!env.config.doubleCheckCompletionEnabled || env.orchestration.getTaskState("doubleCheckCompletionPending")) {
			return undefined
		}

		const subagentsEnabled = env.config.services.stateManager.getGlobalSettingsKey("subagentsEnabled")
		if (subagentsEnabled) {
			return await this.runVerificationSubagent(env, result)
		}

		env.orchestration.setTaskState("doubleCheckCompletionPending", true)
		const verificationInstructions = `1. All requested changes have been made (verify using a test script/\`execute_command\` when possible)
2. No steps were skipped or partially completed
3. Edge cases and error handling are addressed
4. The solution matches what was asked for, not just what was convenient
5. Output files contain exactly what was specified - no extra columns, fields, debug output, or commentary
6. If the task specifies numerical thresholds or accuracy targets, verify your result meets the criteria. If close but not passing, iterate rather than declaring completion`

		const history = env.orchestration.getHistory()
		const firstTaskMsgObj = history.find((m) => m.content.type === DiracMessageType.MARKDOWN && m.content.content.includes("<task>"))
		const firstTaskMessage = firstTaskMsgObj?.content.type === DiracMessageType.MARKDOWN ? firstTaskMsgObj.content.content.trim() : undefined
		const taskPreview = firstTaskMessage ? (firstTaskMessage.length > 8000 ? firstTaskMessage.slice(0, 8000) + "\n...[truncated]" : firstTaskMessage) : ""
		const taskSection = taskPreview ? `\n\n<initial_task>\n${taskPreview}\n</initial_task>` : ""

		return `Verification Required: User wants you to fully verify your solution before submitting.

<verification_checklist>
${verificationInstructions}
</verification_checklist>${taskSection}

If everything checks out, call attempt_completion again with your final result.`
	}

	private async runVerificationSubagent(env: IToolEnvironment, result: string): Promise<any | undefined> {
		const history = env.orchestration.getHistory()
		const firstTaskMsgObjSub = history.find((m) => m.content.type === DiracMessageType.MARKDOWN && m.content.content.includes("<task>"))
		const firstTaskMessage = firstTaskMsgObjSub?.content.type === DiracMessageType.MARKDOWN ? firstTaskMsgObjSub.content.content.trim() : undefined
		const taskPreview = firstTaskMessage ? (firstTaskMessage.length > 8000 ? firstTaskMessage.slice(0, 8000) + "\n...[truncated]" : firstTaskMessage) : "No task description available."

		const subagentPrompt = `You are the verifier of a given solution. Please verify the following task completion.

<initial_task>
${taskPreview}
</initial_task>

<completion_result>
${result}
</completion_result>

<verification_checklist>
1. All requested changes have been made (verify using a test script/\`execute_command\` when possible)
2. No steps were skipped or partially completed
3. Edge cases and error handling are addressed
4. The solution matches what was asked for, not just what was convenient
5. Output files contain exactly what was specified - no extra columns, fields, debug output, or commentary
6. If the task specifies numerical thresholds or accuracy targets, verify your result meets the criteria. If close but not passing, iterate rather than declaring completion
</verification_checklist>

If the solution passes all checks, respond with "VERIFICATION: SUCCESS".
Otherwise, respond with "VERIFICATION: FAILED" followed by all the details on what failed.`

		const card = !env.config.isSubagentExecution ? await env.ui.createCard({
			header: "Verifying Solution",
			icon: DiracIcon.COMPLETE,
			status: CardStatus.RUNNING,
			collapsed: true,
			maxHeight: 10000, // setting it very high to avoid scroll in a scroll
		}) : undefined

		const runResult = await env.orchestration.runSubagent(subagentPrompt, {
			onUpdate: async (update) => {
				if (card) {
					await card.update({
						status: update.status === "completed" ? CardStatus.SUCCESS : update.status === "failed" ? CardStatus.ERROR : CardStatus.RUNNING,
						body: update.result || update.error || ""
					})
				}
			},
		})

		if (runResult.status === "completed") {
			if (runResult.result?.includes("VERIFICATION: SUCCESS")) {
				return undefined
			} else {
				return `Verification Subagent Report:\n${runResult.result}\n\nThe solution could not be verified successfully. Please address the issues listed above and try again.`
			}
		} else {
			return `Verification Subagent Failed:\n${runResult.error}\n\nPlease verify the task manually or try again.`
		}
	}

	private async handleCommandExecution(env: IToolEnvironment, result: string, command: string): Promise<{ userRejected: boolean; commandResult: any }> {
		const history = env.orchestration.getHistory()
		const lastMessage = history[history.length - 1]

		// Check if last message was a command approval card
		const isCommandAsk = lastMessage?.content.type === "card" && lastMessage.content.card.requireApproval
		if (!isCommandAsk) {
			const card = await env.ui.createCard({
				icon: DiracIcon.COMPLETE,
				header: "Task Completed",
				body: result,
				renderType: "markdown",
				collapsed: false,
				maxHeight: 1200,
			})
			await card.finalize(CardStatus.SUCCESS, true)
			await env.orchestration.saveCheckpoint(true, card.id)
			if (!env.config.isSubagentExecution) {
				telemetryService.captureTaskCompleted(env.config.ulid, getTaskCompletionTelemetry(env.config))
				await env.orchestration.runHook("Notification", {
					notification: {
						event: "task_completed",
						source: "attempt_completion",
						message: result,
						waitingForUserInput: true,
					},
				})
			}
		} else {
			await env.orchestration.saveCheckpoint(true)
		}

		const [userRejected, execCommandResult] = await env.system.executeCommand(command)
		if (userRejected) {
			env.orchestration.setTaskState("didRejectTool", true)
			return { userRejected: true, commandResult: execCommandResult }
		}

		return { userRejected: false, commandResult: execCommandResult }
	}

	private async handleCompletionResult(env: IToolEnvironment, result: string): Promise<void> {
		const card = await env.ui.createCard({
			icon: DiracIcon.COMPLETE,
			header: "Task Completed",
			body: result,
			renderType: "markdown",
			collapsed: false,
			maxHeight: 1200,
		})
		await card.finalize(CardStatus.SUCCESS, true)

		const ts = Date.now()
		await env.orchestration.saveCheckpoint(true, card.id)
		if (!env.config.isSubagentExecution) {
			telemetryService.captureTaskCompleted(env.config.ulid, getTaskCompletionTelemetry(env.config))
			await env.orchestration.runHook("Notification", {
				notification: {
					event: "task_completed",
					source: "attempt_completion",
					message: result,
					waitingForUserInput: true,
				},
			})
		}
	}
}
