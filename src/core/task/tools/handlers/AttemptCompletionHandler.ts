import type Anthropic from "@anthropic-ai/sdk"
import type { ToolUse } from "@core/assistant-message"
import { DiracSaySubagentStatus, DiracSubagentUsageInfo, SubagentStatusItem } from "@shared/ExtensionMessage"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { COMPLETION_RESULT_CHANGES_FLAG } from "@shared/ExtensionMessage"
import { SubagentRunner } from "../subagent/SubagentRunner"
import { Logger } from "@shared/services/Logger"
import { DiracDefaultTool } from "@shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import { buildUserFeedbackContent } from "../../utils/buildUserFeedbackContent"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getTaskCompletionTelemetry } from "../utils"
import { ToolResultUtils } from "../utils/ToolResultUtils"

const TASK_PREVIEW_MAX_CHARS = 8000

function getInitialTaskPreview(config: TaskConfig): string | undefined {
	const firstTaskMessage = config.messageState
		.getDiracMessages()
		.find((message) => message.say === "task")
		?.text?.trim()
	if (!firstTaskMessage) {
		return undefined
	}
	if (firstTaskMessage.length <= TASK_PREVIEW_MAX_CHARS) {
		return firstTaskMessage
	}
	return `${firstTaskMessage.slice(0, TASK_PREVIEW_MAX_CHARS)}\n...[truncated]`
}

function getVerificationInstructions(): string {
	return `1. All requested changes have been made (verify using a test script/\`execute_command\` when possible)
2. No steps were skipped or partially completed
3. Edge cases and error handling are addressed
4. The solution matches what was asked for, not just what was convenient
5. Output files contain exactly what was specified - no extra columns, fields, debug output, or commentary
6. If the task specifies numerical thresholds or accuracy targets, verify your result meets the criteria. If close but not passing, iterate rather than declaring completion`
}

export class AttemptCompletionHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DiracDefaultTool.ATTEMPT

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Handle partial block streaming for attempt_completion
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const result = uiHelpers.removeClosingTag(block, "result", block.params.result)
		if (result) {
			await uiHelpers.say("completion_result", result, undefined, undefined, block.partial)
		}
		// We will handle command in the final execution step
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		// Validate required parameters
		if (!result) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "result")
		}

		config.taskState.consecutiveMistakeCount = 0

		// Double-check completion: reject attempt_completion calls that haven't been re-verified
		const doubleCheckResponse = await this.handleDoubleCheckCompletion(config, result)
		if (doubleCheckResponse) {
			return doubleCheckResponse
		}

		// Reset so the next attempt_completion pair triggers double-check again
		config.taskState.doubleCheckCompletionPending = false

		// Run PreToolUse hook before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Task Completed",
				message: result.replace(/\n/g, " "),
			})
		}

		// Remove any partial completion_result message that may exist
		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "completion_result")

		let commandResult: any
		if (command) {
			const cmdExecResult = await this.handleCommandExecution(config, block, result, command)
			if (cmdExecResult.userRejected) {
				return cmdExecResult.commandResult
			}
			commandResult = cmdExecResult.commandResult
		} else {
			await this.handleCompletionResult(config, block, result)
		}

		// End command_output ask if necessary
		if (config.messageState.getDiracMessages().at(-1)?.ask === "command_output") {
			await config.callbacks.say("command_output", "")
		}

		// Run hooks
		await this.runTaskCompleteHook(config, block)
		await this.runNotificationHook(config, {
			event: "task_complete",
			source: "attempt_completion",
			message: result,
			waitingForUserInput: false,
		})

		return await this.handlePostCompletionFeedback(config, block, result, commandResult)
	}

	private async handleDoubleCheckCompletion(config: TaskConfig, result: string): Promise<ToolResponse | undefined> {
		if (!config.doubleCheckCompletionEnabled || config.taskState.doubleCheckCompletionPending) {
			return undefined
		}

		// Remove the partial completion_result message that was shown during streaming
		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "completion_result")

		const subagentsEnabled = config.services.stateManager.getGlobalSettingsKey("subagentsEnabled")
		const taskPreview = getInitialTaskPreview(config)
		const verificationInstructions = getVerificationInstructions()

		if (subagentsEnabled) {
			return await this.runVerificationSubagent(config, result, taskPreview, verificationInstructions)
		}

		config.taskState.doubleCheckCompletionPending = true
		const taskSection = taskPreview ? `\n\n<initial_task>\n${taskPreview}\n</initial_task>` : ""
		return `Verification Required: User wants you to fully verify your solution before submitting.

<verification_checklist>
${verificationInstructions}
</verification_checklist>${taskSection}

If everything checks out, call attempt_completion again with your final result.`
	}

	private async runVerificationSubagent(
		config: TaskConfig,
		result: string,
		taskPreview: string | undefined,
		verificationInstructions: string,
	): Promise<ToolResponse> {
		const runner = new SubagentRunner(config, "verifier")

		// UI state for subagent
		const entry: SubagentStatusItem = {
			index: 1,
			prompt: "Verification",
			status: "pending",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWrites: 0,
			cacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
			latestToolCall: undefined,
		}

		const emitStatus = async (status: DiracSaySubagentStatus["status"], partial: boolean) => {
			const payload: DiracSaySubagentStatus = {
				status,
				total: 1,
				completed: entry.status === "completed" || entry.status === "failed" ? 1 : 0,
				successes: entry.status === "completed" ? 1 : 0,
				failures: entry.status === "failed" ? 1 : 0,
				toolCalls: entry.toolCalls,
				inputTokens: entry.inputTokens,
				outputTokens: entry.outputTokens,
				cacheWrites: entry.cacheWrites,
				cacheReads: entry.cacheReads,
				contextWindow: entry.contextWindow,
				maxContextTokens: entry.contextTokens,
				maxContextUsagePercentage: entry.contextUsagePercentage,
				items: [entry],
			}
			await config.callbacks.say("subagent", JSON.stringify(payload), undefined, undefined, partial)
		}

		let statusUpdateQueue: Promise<void> = Promise.resolve()
		const queueStatusUpdate = (status: DiracSaySubagentStatus["status"], partial: boolean): Promise<void> => {
			statusUpdateQueue = statusUpdateQueue.catch(() => undefined).then(() => emitStatus(status, partial))
			return statusUpdateQueue
		}

		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "subagent")
		await queueStatusUpdate("running", true)

		const abortPollInterval = setInterval(() => {
			if (!config.taskState.abort) {
				return
			}
			clearInterval(abortPollInterval)
			void runner.abort()
		}, 100)

		try {
			const subagentPrompt = `You are the verifier of a given solution. Please verify the following task completion.

<initial_task>
${taskPreview || "No task description available."}
</initial_task>

<completion_result>
${result}
</completion_result>

<verification_checklist>
${verificationInstructions}
</verification_checklist>

If the solution passes all checks, respond with "VERIFICATION: SUCCESS".
Otherwise, respond with "VERIFICATION: FAILED" followed by all the details on what failed.`

			const runResult = await runner.run(
				subagentPrompt,
				async (update) => {
					if (update.status) entry.status = update.status
					if (update.result) entry.result = update.result
					if (update.error) entry.error = update.error
					if (update.latestToolCall) entry.latestToolCall = update.latestToolCall
					if (update.stats) {
						entry.toolCalls = update.stats.toolCalls
						entry.inputTokens = update.stats.inputTokens
						entry.outputTokens = update.stats.outputTokens
						entry.cacheWrites = update.stats.cacheWriteTokens
						entry.cacheReads = update.stats.cacheReadTokens
						entry.totalCost = update.stats.totalCost
						entry.contextTokens = update.stats.contextTokens
						entry.contextWindow = update.stats.contextWindow
						entry.contextUsagePercentage = update.stats.contextUsagePercentage
					}
					await queueStatusUpdate("running", true)
				},
				300, // timeout
				undefined, // maxTurns
				false, // includeHistory
			)

			clearInterval(abortPollInterval)
			await queueStatusUpdate(runResult.status === "failed" ? "failed" : "completed", false)

			const subagentUsagePayload: DiracSubagentUsageInfo = {
				source: "subagents",
				tokensIn: runResult.stats.inputTokens,
				tokensOut: runResult.stats.outputTokens,
				cacheWrites: runResult.stats.cacheWriteTokens,
				cacheReads: runResult.stats.cacheReadTokens,
				cost: runResult.stats.totalCost,
			}
			await config.callbacks.say("subagent_usage", JSON.stringify(subagentUsagePayload))

			if (runResult.status === "completed") {
				const isSuccess = runResult.result?.includes("VERIFICATION: SUCCESS")
				if (isSuccess) {
					config.taskState.doubleCheckCompletionPending = true
					return `Verification Subagent Report:
${runResult.result}

The verification was successful.`
				} else {
					return `Verification Subagent Report:
${runResult.result}

The solution could not be verified successfully. Please address the issues listed above and try again.`
				}
			} else {
				return `Verification Subagent Failed:
${runResult.error}

Please verify the task manually or try again.`
			}
		} catch (error) {
			clearInterval(abortPollInterval)
			return `Verification Subagent Error: ${(error as Error).message}`
		}
	}

	private async handleCommandExecution(
		config: TaskConfig,
		block: ToolUse,
		result: string,
		command: string,
	): Promise<{ userRejected: boolean; commandResult: any }> {
		const lastMessage = config.messageState.getDiracMessages().at(-1)

		if (lastMessage && lastMessage.ask !== "command") {
			// haven't sent a command message yet so first send completion_result then command
			const completionMessageTs = await config.callbacks.say("completion_result", result, undefined, undefined, false)
			await config.callbacks.saveCheckpoint(true, completionMessageTs)
			await this.addNewChangesFlagToLastCompletionResultMessage(config)
			telemetryService.captureTaskCompleted(config.ulid, getTaskCompletionTelemetry(config))
			const apiConfig = config.services.stateManager.getApiConfiguration()
			const provider = (config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
			telemetryService.captureToolUsage(
				config.ulid,
				this.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				undefined,
				block.isNativeToolCall,
			)
		} else {
			// we already sent a command message, meaning the complete completion message has also been sent
			await config.callbacks.saveCheckpoint(true)
		}

		// Check if command should be auto-approved
		const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(DiracDefaultTool.BASH)
		const autoApproveSafe = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult

		if (autoApproveSafe) {
			// Auto-approve flow - show command as 'say' instead of 'ask'
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "command")
			await config.callbacks.say("command", command, undefined, undefined, false)
		} else {
			// Manual approval flow - need to ask for approval
			showNotificationForApproval(
				`Dirac wants to execute a command: ${command}`,
				config.autoApprovalSettings.enableNotifications,
			)

			const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("command", command, config)
			if (!didApprove) {
				return { userRejected: true, commandResult: formatResponse.toolDenied() }
			}
		}

		// Execute the command
		const [userRejected, execCommandResult] = await config.callbacks.executeCommandTool(command, undefined, {
			useBackgroundExecution: true,
		})

		if (userRejected) {
			config.taskState.didRejectTool = true
			return { userRejected: true, commandResult: execCommandResult }
		}

		return { userRejected: false, commandResult: execCommandResult }
	}

	private async handleCompletionResult(config: TaskConfig, block: ToolUse, result: string): Promise<void> {
		// Send the complete completion_result message (partial was already removed above)
		const completionMessageTs = await config.callbacks.say("completion_result", result, undefined, undefined, false)
		await config.callbacks.saveCheckpoint(true, completionMessageTs)
		await this.addNewChangesFlagToLastCompletionResultMessage(config)
		telemetryService.captureTaskCompleted(config.ulid, getTaskCompletionTelemetry(config))
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const provider = (config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		telemetryService.captureToolUsage(
			config.ulid,
			this.name,
			config.api.getModel().id,
			provider,
			false,
			true,
			undefined,
			block.isNativeToolCall,
		)
	}

	private async handlePostCompletionFeedback(
		config: TaskConfig,
		block: ToolUse,
		result: string,
		commandResult: any,
	): Promise<ToolResponse> {
		const { response, text, images, files: completionFiles } = await config.callbacks.ask("completion_result", "", false)
		const prefix = "[attempt_completion] Result: Done"

		if (response === "yesButtonClicked") {
			return prefix
		}

		await config.callbacks.say("user_feedback", text ?? "", images, completionFiles)

		// Run UserPromptSubmit hook when user provides post-completion feedback
		let hookContextModification: string | undefined
		if (text || (images && images.length > 0) || (completionFiles && completionFiles.length > 0)) {
			const userContentForHook = await buildUserFeedbackContent(text, images, completionFiles)
			const hookResult = await config.callbacks.runUserPromptSubmitHook(userContentForHook, "feedback")

			if (hookResult.cancel === true) {
				return formatResponse.toolDenied()
			}
			hookContextModification = hookResult.contextModification
		}

		const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
		if (commandResult) {
			if (typeof commandResult === "string") {
				toolResults.push({ type: "text", text: commandResult })
			} else if (Array.isArray(commandResult)) {
				toolResults.push(...commandResult)
			}
		}

		if (text) {
			toolResults.push(
				{
					type: "text",
					text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
				},
				{
					type: "text",
					text: `<feedback>\n${text}\n</feedback>`,
				},
			)
		}

		if (hookContextModification) {
			toolResults.push({
				type: "text" as const,
				text: `<hook_context source="UserPromptSubmit">\n${hookContextModification}\n</hook_context>`,
			})
		}

		const fileContentString = completionFiles?.length ? await processFilesIntoText(completionFiles) : ""
		if (fileContentString) {
			toolResults.push({ type: "text" as const, text: fileContentString })
		}

		if (images && images.length > 0) {
			toolResults.push(...formatResponse.imageBlocks(images))
		}

		const apiConfig = config.services.stateManager.getApiConfiguration()
		const provider = (config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		telemetryService.captureToolUsage(
			config.ulid,
			this.name,
			config.api.getModel().id,
			provider,
			false,
			false,
			undefined,
			block.isNativeToolCall,
		)

		return [
			{ type: "text" as const, text: prefix },
			...toolResults,
		]
	}

	private async addNewChangesFlagToLastCompletionResultMessage(config: TaskConfig) {
		const hasNewChanges = await config.callbacks.doesLatestTaskCompletionHaveNewChanges()
		const diracMessages = config.messageState.getDiracMessages()
		const lastCompletionResultMessageIndex = findLastIndex(diracMessages, (m: any) => m.say === "completion_result")
		const lastCompletionResultMessage =
			lastCompletionResultMessageIndex !== -1 ? diracMessages[lastCompletionResultMessageIndex] : undefined

		if (
			lastCompletionResultMessage &&
			lastCompletionResultMessageIndex !== -1 &&
			hasNewChanges &&
			!lastCompletionResultMessage.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG)
		) {
			await config.messageState.updateDiracMessage(lastCompletionResultMessageIndex, {
				text: lastCompletionResultMessage.text + COMPLETION_RESULT_CHANGES_FLAG,
			})
		}
	}

	private async runTaskCompleteHook(config: TaskConfig, block: ToolUse): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe(config.services.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) {
			return
		}

		try {
			const { executeHook } = await import("@core/hooks/hook-executor")

			await executeHook({
				hookName: "TaskComplete",
				hookInput: {
					taskComplete: {
						taskMetadata: {
							taskId: config.taskId,
							ulid: config.ulid,
							result: block.params.result || "",
							command: block.params.command || "",
						},
					},
				},
				isCancellable: false, // Non-cancellable - task is already complete
				say: config.callbacks.say,
				setActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				clearActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled,
				model: getHookModelContext(config.api, config.services.stateManager),
			})
		} catch (error) {
			// TaskComplete hook failed - non-fatal, just log
			Logger.error("[TaskComplete Hook] Failed (non-fatal):", error)
		}
	}

	private async runNotificationHook(
		config: TaskConfig,
		notification: {
			event: string
			source: string
			message: string
			waitingForUserInput: boolean
		},
	): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe(config.services.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) {
			return
		}

		try {
			const { executeHook } = await import("@core/hooks/hook-executor")

			await executeHook({
				hookName: "Notification",
				hookInput: {
					notification: {
						...notification,
						message: notification.message.slice(0, TASK_PREVIEW_MAX_CHARS),
					},
				},
				isCancellable: false,
				say: async () => undefined,
				setActiveHookExecution: undefined,
				clearActiveHookExecution: undefined,
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled,
				model: getHookModelContext(config.api, config.services.stateManager),
			})
		} catch (error) {
			Logger.error("[Notification Hook] Failed (non-fatal):", error)
		}
	}
}
