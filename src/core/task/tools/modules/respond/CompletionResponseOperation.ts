import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { CardHeader } from "@shared/cardIdentity"
import { DiracDefaultTool } from "@/shared/tools"
import { DiracIcon } from "@/shared/icons"
import { CardKind, CardStatus, SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"
import { ResponseOperation, responseCardInput } from "@shared/responseTool"
import {
	allocateSubagentIdentity,
	createSubagentCardInput,
	createSubagentCardOutput,
	formatSubagentTrajectory,
	isTerminalSubagentStatus,
	recordSubagentProgress,
	subagentCardStatus,
	type SubagentTrajectoryEvent,
} from "@shared/subagents"
import {
	completionVerificationCandidateFingerprint,
	completionVerificationTaskPreview,
	formatPreviousVerificationFailures,
} from "./CompletionVerificationContext"

const COMPLETION_VERIFICATION_INSTRUCTIONS = `1. All requested changes have been made (verify using a test script/\`execute_command\` when possible)
2. No steps were skipped or partially completed
3. Edge cases and error handling are addressed
4. The solution matches what was asked for, not just what was convenient
5. Output files contain exactly what was specified - no extra columns, fields, debug output, or commentary
6. If the task specifies numerical thresholds or accuracy targets, verify your result meets the criteria. If close but not passing, iterate rather than declaring completion`

export class CompletionResponseOperation {
	async execute(result: string, env: IToolEnvironment): Promise<any> {
		const doubleCheckResponse = await this.handleDoubleCheckCompletion(env, result)
		if (doubleCheckResponse) {
			return doubleCheckResponse
		}

		env.orchestration.setTaskState("doubleCheckCompletionPending", false)

		const completion = env.goal
			? await env.goal.commitCompletion(result)
			: await env.orchestration.commitAttemptCompletion(result)
		if (!completion.committed) {
			return `Completion rejected: ${completion.error}`
		}
		env.orchestration.setTaskState("completionCommitted", true)
		env.orchestration.setTaskState("didAttemptCompletion", true)
		env.orchestration.setTaskState("completionResponse", result)

		if (env.config.executionProfile !== "goal_child") {
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
				if (!env.config.isSubagentExecution && env.config.autoApprovalSettings.enableNotifications) {
					env.system.showNotification({
						subtitle: "Task Completed",
						message: result.replace(/\n/g, " "),
					})
				}
				if (!env.config.isSubagentExecution) {
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
				}
			} catch (error) {
				env.logging.warn("Completion succeeded, but a completion notification failed", error)
			}
		}
		env.telemetry.captureCustomMetadata({ operation: ResponseOperation.COMPLETE, mode: env.config.mode })

		return result
	}

	private async handleDoubleCheckCompletion(env: IToolEnvironment, result: string): Promise<any | undefined> {
		if (!env.config.doubleCheckCompletionEnabled || env.orchestration.getTaskState("doubleCheckCompletionPending")) {
			return undefined
		}

		const taskPreview = completionVerificationTaskPreview(env)
		if (!taskPreview) {
			return "Completion verification failed internally: initial task context is unavailable. Completion was not accepted."
		}

		if (env.config.subagentsEnabled) {
			return await this.runVerificationSubagent(env, result, taskPreview)
		}

		env.orchestration.setTaskState("doubleCheckCompletionPending", true)
		const previousFailures = env.orchestration.getTaskState("completionVerificationFailure")?.reports ?? []
		const previousFailureSection = formatPreviousVerificationFailures(previousFailures)

		return `Verification Required: User wants you to fully verify your solution before submitting.

<initial_task>
${taskPreview}
</initial_task>

<verification_checklist>
${COMPLETION_VERIFICATION_INSTRUCTIONS}
</verification_checklist>${previousFailureSection}

If everything checks out, call respond with operation "complete" and your final result.`
	}

	private async runVerificationSubagent(
		env: IToolEnvironment,
		result: string,
		taskPreview: string,
	): Promise<any | undefined> {
		const history = env.orchestration.getHistory()
		const previousFailure = env.orchestration.getTaskState("completionVerificationFailure")
		if (previousFailure && !previousFailure.candidateFingerprint) {
			return "Completion verification remains failed because the rejected candidate could not be fingerprinted safely. Start a new task to retry with trustworthy verification state."
		}
		if (previousFailure?.candidateFingerprint) {
			try {
				const currentFingerprint = await completionVerificationCandidateFingerprint(env, result)
				if (currentFingerprint === previousFailure.candidateFingerprint) {
					return `Verification Subagent Report:\n${previousFailure.reports.at(-1)}\n\nCompletion was not re-verified because the completion result and workspace artifacts are unchanged. Address the prior failure before trying again.`
				}
			} catch (error) {
				env.logging.warn("Completion verification workspace fingerprint failed.", error)
				return "Completion verification failed internally: the workspace could not be fingerprinted safely. Completion was not accepted and no new verifier was launched."
			}
		}

		const identity = allocateSubagentIdentity(history)
		const trajectory: SubagentTrajectoryEvent[] = []
		const taskTitle = "Verifying task completion"
		const previousFailureSection = formatPreviousVerificationFailures(previousFailure?.reports ?? [])

		const subagentPrompt = `You are the verifier of a given solution. Please verify the following task completion.

<initial_task>
${taskPreview}
</initial_task>

<completion_result>
${result}
</completion_result>${previousFailureSection}

<verification_checklist>
${COMPLETION_VERIFICATION_INSTRUCTIONS}
</verification_checklist>

If the solution passes all checks, respond with exactly "VERIFICATION: SUCCESS" and nothing else.
Otherwise, respond with "VERIFICATION: FAILED" followed by all the details on what failed.`

		let card: ICardHandle | undefined
		if (!env.config.isSubagentExecution) {
			const cardPromise = env.ui.createCard({
				header: taskTitle,
				icon: DiracIcon.COMPLETE,
				status: CardStatus.RUNNING,
				collapsed: true,
				renderType: "markdown",
				autoScroll: true,
				rawInput: createSubagentCardInput(identity, subagentPrompt, taskTitle),
				rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, trajectory),
				body: formatSubagentTrajectory({
					...identity,
					prompt: subagentPrompt,
					status: SubagentExecutionStatus.RUNNING,
					trajectory,
				}),
			})
			const cardCreation = await waitForPresentationOperation(cardPromise)
			if (cardCreation.timedOut) {
				env.logging.warn("Verification subagent card creation timed out.")
				void cardPromise
					.then((lateCard) => lateCard.finalize(CardStatus.ABANDONED))
					.catch((error) => env.logging.warn("Late verification subagent card cleanup failed.", error))
			} else {
				card = cardCreation.value
			}
		}

		let discardQueuedPresentationUpdates = false
		let presentationUpdates = Promise.resolve()
		let presentationError: Error | undefined
		const enqueuePresentationUpdate = (present: () => Promise<void>) => {
			presentationUpdates = presentationUpdates
				.then(async () => {
					if (discardQueuedPresentationUpdates) return
					await present()
				})
				.catch((error) => {
					presentationError ??= error as Error
				})
		}
		const runCardOperation = async (operation: Promise<void>, timeoutMessage: string) => {
			let operationError: Error | undefined
			const observedOperation = operation.catch((error) => {
				operationError = error as Error
			})
			const outcome = await waitForPresentationOperation(observedOperation)
			if (outcome.timedOut) presentationError ??= new Error(timeoutMessage)
			else if (operationError) presentationError ??= operationError
		}

		const runResult = await env.orchestration.runSubagent(subagentPrompt, {
			subagentName: "verifier",
			agentIdentity: identity,
			taskTitle,
			onUpdate: (update) => {
				if (update.trajectoryEvent === undefined && update.status === undefined) return
				const status = recordSubagentProgress(trajectory, update)
				if (!card || isTerminalSubagentStatus(status)) return
				const patch = {
					status: subagentCardStatus(status),
					body: formatSubagentTrajectory({ ...identity, prompt: subagentPrompt, status, trajectory }),
					rawOutput: createSubagentCardOutput(status, trajectory),
				}
				enqueuePresentationUpdate(() => card!.update(patch))
			},
		})

		recordSubagentProgress(trajectory, runResult)
		if (card) {
			const finalPatch = {
				status: subagentCardStatus(runResult.status),
				body: formatSubagentTrajectory({
					...identity,
					prompt: subagentPrompt,
					status: runResult.status,
					trajectory,
					usage: runResult.stats,
				}),
				rawOutput: createSubagentCardOutput(runResult.status, trajectory, runResult.stats),
			}
			const applyTerminalCardState = async () => {
				await runCardOperation(card!.update(finalPatch), "Verification subagent final card update timed out.")
				await runCardOperation(
					card!.finalize(subagentCardStatus(runResult.status)),
					"Verification subagent card finalization timed out.",
				)
			}
			const intermediateUpdates = await waitForPresentationOperation(presentationUpdates)
			if (intermediateUpdates.timedOut) {
				discardQueuedPresentationUpdates = true
				presentationError ??= new Error("Verification subagent presentation did not drain before the timeout.")
				void presentationUpdates
					.then(applyTerminalCardState)
					.catch((error) => env.logging.warn("Late verification subagent terminal replay failed.", error))
			}
			await applyTerminalCardState()
		}
		if (presentationError) {
			env.logging.warn("Verification subagent completed with a presentation error.", presentationError)
		}

		if (runResult.status !== SubagentExecutionStatus.COMPLETED) {
			const report = `Verification subagent execution failed: ${runResult.error ?? "Unknown error"}`
			return await this.recordVerificationFailure(env, result, report, `Verification Subagent Failed:\n${runResult.error}`)
		}
		if (runResult.result?.trim() === "VERIFICATION: SUCCESS") {
			env.orchestration.setTaskState("completionVerificationFailure", undefined)
			return undefined
		}
		const report = runResult.result?.trim() || "Verifier returned no result."
		return await this.recordVerificationFailure(env, result, report, `Verification Subagent Report:\n${report}`)
	}

	private async recordVerificationFailure(
		env: IToolEnvironment,
		result: string,
		report: string,
		response: string,
	): Promise<string> {
		const previousReports = env.orchestration.getTaskState("completionVerificationFailure")?.reports ?? []
		const reports = [...previousReports, report]
		try {
			const candidateFingerprint = await completionVerificationCandidateFingerprint(env, result)
			env.orchestration.setTaskState("completionVerificationFailure", { candidateFingerprint, reports })
			return `${response}\n\nThe solution could not be verified successfully. Please address the issues listed above and try again.`
		} catch (error) {
			env.logging.warn("Rejected completion candidate could not be fingerprinted.", error)
			env.orchestration.setTaskState("completionVerificationFailure", { reports })
			return `${response}\n\nCompletion remains rejected, and further verification is blocked because the rejected candidate could not be fingerprinted safely.`
		}
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
