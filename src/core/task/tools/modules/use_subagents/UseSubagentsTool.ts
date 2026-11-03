import { formatResponse } from "@core/formatResponse"
import { CardStatus, SubagentExecutionStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import {
	allocateSubagentIdentity,
	appendSubagentTrajectoryEvent,
	createSubagentCardInput,
	createSubagentCardOutput,
	formatSubagentTrajectory,
	isTerminalSubagentStatus,
	recordSubagentProgress,
	SUBAGENT_TASK_TITLE_MAX_CHARS,
	SUBAGENT_TASK_TITLE_MAX_WORDS,
	type SubagentTrajectoryEvent,
	SubagentTrajectoryEventType,
	subagentCardStatus,
} from "@shared/subagents"
import { toError } from "@/shared/errors"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { stripHashes } from "../../../../../shared/utils/line-hashing"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { TaskletControls, TaskletInteractionDecision } from "../../interfaces/IToolEnvironment"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"
import { LatestPresentationQueue } from "../../subagent/LatestPresentationQueue"
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS, resolveSubagentTimeoutSeconds } from "../../subagent/SubagentExecutionPolicy"

interface SubagentRequest {
	taskTitle: string
	prompt: string
	timeout: number
	includeHistory: boolean
	useUtilityModel: boolean
}

type PresentationIssueScope = "aggregate" | "agent"
type PresentationIssuePhase = "create" | "intermediate_update" | "terminal_update" | "finalize" | "late_replay"

interface PresentationIssueContext {
	scope: PresentationIssueScope
	phase: PresentationIssuePhase
	requestIndex?: number
	agentId?: number
	agentName?: string
	cardId?: string
	executionStatus?: SubagentExecutionStatus
	timedOut: boolean
}

interface SubagentPresentationIssue extends PresentationIssueContext {
	error: Error
}

export const use_subagents_spec: DiracToolSpec = {
	id: DiracDefaultTool.USE_SUBAGENTS,
	name: "use_subagents",
	description: "Run subagents in parallel.",
	contextRequirements: (context) => context.subagentsEnabled === true,
	parameters: [
		{
			name: "subagents",
			type: "array",
			required: true,
			instruction: "Subagents to run in parallel.",
			items: {
				type: "object",
				properties: {
					task_title: {
						type: "string",
						description: `Task header for user observability. No more than ${SUBAGENT_TASK_TITLE_MAX_WORDS} words or ${SUBAGENT_TASK_TITLE_MAX_CHARS} characters.`,
					},
					prompt: {
						type: "string",
						description: "Task for this subagent.",
					},
					timeout: {
						type: "integer",
						description: `Timeout in seconds. Default: ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}.`,
					},
					include_history: {
						type: "boolean",
						description: "Include the main task conversation history.",
					},
				},
				required: ["task_title", "prompt"],
				additionalProperties: false,
			},
		},
	],
}

export class UseSubagentsTool implements IDiracTool {
	spec(): DiracToolSpec {
		return use_subagents_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		this.validateExecution(env)

		const subagentName = AgentConfigLoader.getInstance().resolveSubagentNameForTool(env.toolName)
		const requests = this.resolveRequests(args, subagentName)

		if (requests.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError(`Missing required parameter: ${subagentName ? "prompt" : "subagents"}`)
		}

		const entries = this.initializeEntries(requests, env.orchestration.getHistory())
		const presentationIssues: SubagentPresentationIssue[] = []
		let cardsCreated = 0
		const taskId = env.config.ulid || "unknown"
		const reportPresentationIssue = (context: PresentationIssueContext, error: unknown) => {
			const normalizedError = toError(error)
			presentationIssues.push({ ...context, error: normalizedError })
			const correlation = [
				`task=${taskId}`,
				`scope=${context.scope}`,
				`phase=${context.phase}`,
				context.requestIndex === undefined ? undefined : `requestIndex=${context.requestIndex}`,
				context.agentId === undefined ? undefined : `agentId=${context.agentId}`,
				context.agentName === undefined ? undefined : `agentName=${context.agentName}`,
				context.cardId === undefined ? undefined : `cardId=${context.cardId}`,
				context.executionStatus === undefined ? undefined : `executionStatus=${context.executionStatus}`,
				`timedOut=${context.timedOut}`,
			]
				.filter((value): value is string => value !== undefined)
				.join(" ")
			env.logging.warn(`[UseSubagentsTool] presentation_issue ${correlation}`, normalizedError)
		}

		entries.forEach((entry, requestIndex) => {
			env.logging.debug(
				`[UseSubagentsTool] identity_allocated task=${taskId} requestIndex=${requestIndex} agentId=${entry.index} agentName=${entry.name}`,
			)
		})

		let card: ICardHandle | undefined
		if (!env.config.isSubagentExecution) {
			try {
				const cardPromise = env.ui.createCard({
					header: "Run Subagents",
					icon: DiracIcon.SUBAGENTS,
					collapsed: true,
				})
				const cardCreation = await waitForPresentationOperation(cardPromise)
				if (cardCreation.timedOut) {
					reportPresentationIssue(
						{ scope: "aggregate", phase: "create", timedOut: true },
						new Error("Aggregate subagent card creation timed out."),
					)
					void cardPromise
						.then((lateCard) => lateCard.finalize(CardStatus.ABANDONED))
						.catch((error) =>
							reportPresentationIssue({ scope: "aggregate", phase: "late_replay", timedOut: false }, error),
						)
				} else {
					card = cardCreation.value
					cardsCreated++
					env.logging.debug(`[UseSubagentsTool] card_created task=${taskId} scope=aggregate cardId=${card.id}`)
				}
			} catch (error) {
				reportPresentationIssue({ scope: "aggregate", phase: "create", timedOut: false }, error)
			}
		}

		const aggregatePresentation = new LatestPresentationQueue((error) => {
			reportPresentationIssue(
				{ scope: "aggregate", phase: "intermediate_update", cardId: card?.id, timedOut: false },
				error,
			)
		})
		const emitStatus = (status: SubagentExecutionStatus) => {
			if (!card) return
			const payload = this.calculateStatusPayload(status, entries)
			const wrappingUpCount = entries.filter(
				(entry) => entry.isWrappingUp && !isTerminalSubagentStatus(entry.status),
			).length
			const patch = {
				status: subagentCardStatus(status),
				body: this.formatSubagentStatusMarkdown(payload),
				renderType: "markdown" as const,
				...(wrappingUpCount > 0
					? { header: `Wrapping up ${wrappingUpCount} subagent${wrappingUpCount === 1 ? "" : "s"}` }
					: {}),
			}
			aggregatePresentation.enqueue(() => card!.update(patch))
		}
		const runAggregateOperation = async (
			operation: Promise<void>,
			phase: "terminal_update" | "finalize",
			timeoutMessage: string,
		) => {
			let operationError: Error | undefined
			const observedOperation = operation.catch((error) => {
				operationError = error as Error
			})
			const outcome = await waitForPresentationOperation(observedOperation)
			if (outcome.timedOut) {
				reportPresentationIssue(
					{ scope: "aggregate", phase, cardId: card?.id, executionStatus: finalStatus, timedOut: true },
					new Error(timeoutMessage),
				)
			} else if (operationError) {
				reportPresentationIssue(
					{ scope: "aggregate", phase, cardId: card?.id, executionStatus: finalStatus, timedOut: false },
					operationError,
				)
			}
		}

		emitStatus(SubagentExecutionStatus.RUNNING)
		await this.runSubagents(requests, subagentName, entries, env, emitStatus, reportPresentationIssue, () => {
			cardsCreated++
		})

		const failures = entries.filter((entry) => entry.status === SubagentExecutionStatus.FAILED).length
		const cancellations = entries.filter((entry) => entry.status === SubagentExecutionStatus.CANCELLED).length
		const finalStatus =
			failures > 0
				? SubagentExecutionStatus.FAILED
				: cancellations > 0
					? SubagentExecutionStatus.CANCELLED
					: SubagentExecutionStatus.COMPLETED

		if (card) {
			const finalPayload = this.calculateStatusPayload(finalStatus, entries)
			const applyFinalAggregateState = async () => {
				await runAggregateOperation(
					card!.update({
						status: subagentCardStatus(finalStatus),
						body: this.formatSubagentStatusMarkdown(finalPayload),
						renderType: "markdown",
						header: `Ran ${requests.length} subagents`,
					}),
					"terminal_update",
					"Final aggregate subagent card update timed out.",
				)
				await runAggregateOperation(
					card!.finalize(subagentCardStatus(finalStatus)),
					"finalize",
					"Aggregate subagent card finalization timed out.",
				)
			}
			aggregatePresentation.stopAcceptingUpdates()
			const intermediateUpdates = await waitForPresentationOperation(
				aggregatePresentation.waitForInFlightPresentation(),
			)
			if (intermediateUpdates.timedOut) {
				reportPresentationIssue(
					{
						scope: "aggregate",
						phase: "intermediate_update",
						cardId: card.id,
						executionStatus: finalStatus,
						timedOut: true,
					},
					new Error("Aggregate subagent presentation did not drain before the timeout."),
				)
			}
			await applyFinalAggregateState()
		}

		const succeeded = entries.filter((entry) => entry.status === SubagentExecutionStatus.COMPLETED).length
		env.telemetry.captureCustomMetadata({
			subagentRequestedCount: entries.length,
			subagentSucceededCount: succeeded,
			subagentFailedCount: failures,
			subagentCancelledCount: cancellations,
			subagentPresentationCardsCreated: cardsCreated,
			subagentPresentationIssueCount: presentationIssues.length,
			subagentPresentationTimeoutCount: presentationIssues.filter((issue) => issue.timedOut).length,
		})

		return formatResponse.toolResult(this.formatFinalResponse(entries))
	}

	private validateExecution(env: IToolEnvironment): void {
		if (env.config.isSubagentExecution) {
			throw new Error("Subagents cannot spawn other subagents.")
		}
	}

	private resolveRequests(args: any, subagentName: string | undefined): SubagentRequest[] {
		if (subagentName) {
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
			if (!prompt) return []
			return [{ taskTitle: this.parseTaskTitle(args.task_title, prompt), prompt, ...this.parseOptions(args) }]
		}

		if (!Array.isArray(args.subagents)) {
			return []
		}

		return args.subagents.map((subagent: any, index: number) => {
			const prompt = typeof subagent?.prompt === "string" ? subagent.prompt.trim() : ""
			if (!prompt) {
				throw new Error(`Subagent ${index + 1} is missing required parameter: prompt`)
			}

			return {
				taskTitle: this.parseTaskTitle(subagent?.task_title, prompt, `Subagent ${index + 1}`),
				prompt,
				...this.parseOptions(subagent),
			}
		})
	}

	private parseTaskTitle(value: unknown, prompt: string, subject = "Subagent"): string {
		const taskTitle = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
		if (!taskTitle) return this.deriveTaskTitle(prompt)
		if (taskTitle.split(" ").length > SUBAGENT_TASK_TITLE_MAX_WORDS) {
			throw new Error(`${subject} parameter task_title must contain no more than ${SUBAGENT_TASK_TITLE_MAX_WORDS} words`)
		}
		if (taskTitle.length > SUBAGENT_TASK_TITLE_MAX_CHARS) {
			throw new Error(
				`${subject} parameter task_title must contain no more than ${SUBAGENT_TASK_TITLE_MAX_CHARS} characters`,
			)
		}
		return taskTitle
	}

	private deriveTaskTitle(prompt: string): string {
		const words = prompt.trim().replace(/\s+/g, " ").split(" ").slice(0, SUBAGENT_TASK_TITLE_MAX_WORDS)
		const title = words.join(" ")
		if (title.length <= SUBAGENT_TASK_TITLE_MAX_CHARS) return title
		return `${title.slice(0, SUBAGENT_TASK_TITLE_MAX_CHARS - 1)}…`
	}

	private parseOptions(args: any): Omit<SubagentRequest, "taskTitle" | "prompt"> {
		const timeout = args.timeout === undefined ? DEFAULT_SUBAGENT_TIMEOUT_SECONDS : Number(args.timeout)
		return {
			timeout: resolveSubagentTimeoutSeconds(timeout),
			includeHistory: args.include_history === true || String(args.include_history) === "true",
			useUtilityModel: args.use_utility_model === true || String(args.use_utility_model) === "true",
		}
	}

	private initializeEntries(
		requests: SubagentRequest[],
		history: ReturnType<IToolEnvironment["orchestration"]["getHistory"]>,
	): SubagentStatusItem[] {
		const reserved: Array<{ id: number; name: string }> = []
		return requests.map((request) => {
			const identity = allocateSubagentIdentity(history, reserved)
			reserved.push(identity)
			return {
				index: identity.id,
				name: identity.name,
				taskTitle: request.taskTitle,
				prompt: request.prompt,
				status: SubagentExecutionStatus.PENDING,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0,
				contextTokens: 0,
				contextWindow: 0,
				contextUsagePercentage: 0,
			}
		})
	}

	private calculateStatusPayload(status: SubagentExecutionStatus, entries: SubagentStatusItem[]): any {
		const completed = entries.filter(
			(e) =>
				e.status === SubagentExecutionStatus.COMPLETED ||
				e.status === SubagentExecutionStatus.FAILED ||
				e.status === SubagentExecutionStatus.CANCELLED,
		).length
		const successes = entries.filter((e) => e.status === SubagentExecutionStatus.COMPLETED).length
		const failures = entries.filter((e) => e.status === SubagentExecutionStatus.FAILED).length
		const toolCalls = entries.reduce((acc: number, e) => acc + (e.toolCalls || 0), 0)
		const inputTokens = entries.reduce((acc: number, e) => acc + (e.inputTokens || 0), 0)
		const outputTokens = entries.reduce((acc: number, e) => acc + (e.outputTokens || 0), 0)
		const cacheWrites = entries.reduce((acc: number, e) => acc + (e.cacheWrites || 0), 0)
		const cacheReads = entries.reduce((acc: number, e) => acc + (e.cacheReads || 0), 0)
		const contextWindow = entries.reduce((acc: number, e) => Math.max(acc, e.contextWindow || 0), 0)
		const maxContextTokens = entries.reduce((acc: number, e) => Math.max(acc, e.contextTokens || 0), 0)
		const maxContextUsagePercentage = entries.reduce((acc: number, e) => Math.max(acc, e.contextUsagePercentage || 0), 0)

		return {
			status,
			total: entries.length,
			completed,
			successes,
			failures,
			toolCalls,
			inputTokens,
			outputTokens,
			cacheWrites,
			cacheReads,
			contextWindow,
			maxContextTokens,
			maxContextUsagePercentage,
			items: entries,
		}
	}

	private async runSubagents(
		requests: SubagentRequest[],
		subagentName: string | undefined,
		entries: SubagentStatusItem[],
		env: IToolEnvironment,
		emitStatus: (status: SubagentExecutionStatus) => void,
		reportPresentationIssue: (context: PresentationIssueContext, error: unknown) => void,
		onCardCreated: () => void,
	): Promise<void> {
		let lastAggregateUpdateAt = 0
		const taskId = env.config.ulid || "unknown"
		const emitRunningStatus = (force = false) => {
			const now = Date.now()
			if (!force && now - lastAggregateUpdateAt < 100) return
			lastAggregateUpdateAt = now
			emitStatus(SubagentExecutionStatus.RUNNING)
		}

		const execution = requests.map(async (request, index) => {
			const entry = entries[index]
			const trajectory: SubagentTrajectoryEvent[] = []
			const issueContext = {
				scope: "agent" as const,
				requestIndex: index,
				agentId: entry.index,
				agentName: entry.name,
			}
			let subagentCard: ICardHandle | undefined
			const reportAgentIssue = (
				phase: PresentationIssuePhase,
				timedOut: boolean,
				error: unknown,
				executionStatus?: SubagentExecutionStatus,
				cardId = subagentCard?.id,
			) => {
				reportPresentationIssue({ ...issueContext, phase, cardId, executionStatus, timedOut }, error)
			}
			const presentation = new LatestPresentationQueue((error) => {
				reportAgentIssue("intermediate_update", false, error)
			})
			const runCardOperation = async (
				operation: Promise<void>,
				phase: "terminal_update" | "finalize",
				timeoutMessage: string,
				executionStatus: SubagentExecutionStatus,
			) => {
				let operationError: Error | undefined
				const observedOperation = operation.catch((error) => {
					operationError = error as Error
				})
				const outcome = await waitForPresentationOperation(observedOperation)
				if (outcome.timedOut) reportAgentIssue(phase, true, new Error(timeoutMessage), executionStatus)
				else if (operationError) reportAgentIssue(phase, false, operationError, executionStatus)
			}

			if (!env.config.isSubagentExecution) {
				try {
					const cardPromise = env.ui.createCard({
						header: `${entry.name}: ${request.taskTitle}`,
						collapsed: true,
						status: CardStatus.RUNNING,
						renderType: "markdown",
						autoScroll: true,
						rawInput: createSubagentCardInput(
							{ id: entry.index, name: entry.name },
							request.prompt,
							request.taskTitle,
						),
						rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, trajectory),
						body: formatSubagentTrajectory({
							id: entry.index,
							name: entry.name,
							taskTitle: request.taskTitle,
							prompt: request.prompt,
							status: SubagentExecutionStatus.RUNNING,
							trajectory,
						}),
					})
					const cardCreation = await waitForPresentationOperation(cardPromise)
					if (cardCreation.timedOut) {
						reportAgentIssue("create", true, new Error(`Subagent '${entry.name}' card creation timed out.`))
						void cardPromise
							.then((lateCard) => lateCard.finalize(CardStatus.ABANDONED))
							.catch((error) => reportAgentIssue("late_replay", false, error))
					} else {
						subagentCard = cardCreation.value
						onCardCreated()
						env.logging.debug(
							`[UseSubagentsTool] card_created task=${taskId} scope=agent requestIndex=${index} agentId=${entry.index} agentName=${entry.name} cardId=${subagentCard.id}`,
						)
					}
				} catch (error) {
					reportAgentIssue("create", false, error)
				}
			}

			let runSettled = false
			try {
				const runResult = await env.orchestration.runSubagent(request.prompt, {
					timeout: request.timeout,
					includeHistory: request.includeHistory,
					useUtilityModel: request.useUtilityModel,
					subagentName,
					agentIdentity: { id: entry.index, name: entry.name },
					taskTitle: request.taskTitle,
					signal: env.config.taskState.abortSignal,
					onUpdate: (update) => {
						if (runSettled) return
						const current = entries[index]
						const trajectoryChanged = update.trajectoryEvent !== undefined || update.status !== undefined
						const runtimeChanged =
							update.phase !== undefined ||
							update.phaseStartedAt !== undefined ||
							update.lastActivityAt !== undefined ||
							update.isStalled !== undefined ||
							update.transcriptPath !== undefined ||
							update.diagnosticsPath !== undefined
						const status = trajectoryChanged ? recordSubagentProgress(trajectory, update) : current.status

						if (update.status) current.status = update.status
						if (update.result !== undefined) current.result = update.result
						if (update.error !== undefined) current.error = update.error
						if (update.latestToolCall !== undefined) current.latestToolCall = update.latestToolCall
						if (update.isWrappingUp) current.isWrappingUp = true
						if (update.phase !== undefined) current.phase = update.phase
						if (update.phaseStartedAt !== undefined) current.phaseStartedAt = update.phaseStartedAt
						if (update.lastActivityAt !== undefined) current.lastActivityAt = update.lastActivityAt
						if (update.isStalled !== undefined) current.isStalled = update.isStalled
						if (update.transcriptPath !== undefined) current.transcriptPath = update.transcriptPath
						if (update.diagnosticsPath !== undefined) current.diagnosticsPath = update.diagnosticsPath
						if (update.stats) {
							current.toolCalls = update.stats.toolCalls
							current.inputTokens = update.stats.inputTokens
							current.outputTokens = update.stats.outputTokens
							current.cacheWrites = update.stats.cacheWriteTokens
							current.cacheReads = update.stats.cacheReadTokens
							current.totalCost = update.stats.totalCost
							current.contextTokens = update.stats.contextTokens
							current.contextWindow = update.stats.contextWindow
							current.contextUsagePercentage = update.stats.contextUsagePercentage
						}

						if (update.stats !== undefined || update.status !== undefined || update.isWrappingUp || runtimeChanged) {
							emitRunningStatus(isTerminalSubagentStatus(status) || update.isWrappingUp === true)
						}
						if (
							!subagentCard ||
							(!trajectoryChanged && !update.isWrappingUp && !runtimeChanged) ||
							isTerminalSubagentStatus(status)
						)
							return

						const cardUpdate = {
							header: current.isWrappingUp
								? `${current.name}: wrapping up`
								: `${current.name}: ${current.taskTitle}`,
							status: subagentCardStatus(status),
							body: stripHashes(
								`${this.formatSubagentLiveState(current)}\n\n${formatSubagentTrajectory({
									id: current.index,
									name: current.name,
									taskTitle: current.taskTitle,
									prompt: current.prompt,
									status,
									trajectory,
								})}`,
							),
							rawOutput: createSubagentCardOutput(status, trajectory),
						}
						presentation.enqueue(() => subagentCard!.update(cardUpdate))
					},
				})
				runSettled = true
				env.logging.debug(
					`[UseSubagentsTool] execution_settled task=${taskId} requestIndex=${index} agentId=${entry.index} agentName=${entry.name} status=${runResult.status}`,
				)

				recordSubagentProgress(trajectory, runResult)
				if (subagentCard) {
					const finalCardUpdate = {
						header: `${entry.name}: ${entry.taskTitle}`,
						status: subagentCardStatus(runResult.status),
						body: stripHashes(
							formatSubagentTrajectory({
								id: entry.index,
								name: entry.name,
								taskTitle: entry.taskTitle,
								prompt: entry.prompt,
								status: runResult.status,
								usage: runResult.stats,
								trajectory,
							}),
						),
						rawOutput: createSubagentCardOutput(runResult.status, trajectory, runResult.stats),
					}
					const applyTerminalCardState = async () => {
						await runCardOperation(
							subagentCard!.update(finalCardUpdate),
							"terminal_update",
							`Subagent '${entry.name}' final card update timed out.`,
							runResult.status,
						)
						await runCardOperation(
							subagentCard!.finalize(subagentCardStatus(runResult.status)),
							"finalize",
							`Subagent '${entry.name}' card finalization timed out.`,
							runResult.status,
						)
					}
					presentation.stopAcceptingUpdates()
					const intermediateUpdates = await waitForPresentationOperation(
						presentation.waitForInFlightPresentation(),
					)
					if (intermediateUpdates.timedOut) {
						reportAgentIssue(
							"intermediate_update",
							true,
							new Error(`Subagent '${entry.name}' presentation did not drain before the timeout.`),
							runResult.status,
						)
					}
					await applyTerminalCardState()
					env.logging.debug(
						`[UseSubagentsTool] terminal_reconciled task=${taskId} requestIndex=${index} agentId=${entry.index} agentName=${entry.name} cardId=${subagentCard.id} status=${runResult.status}`,
					)
				}

				return runResult
			} catch (error) {
				runSettled = true
				const message = (error as Error).message || "Subagent execution failed"
				appendSubagentTrajectoryEvent(trajectory, { type: SubagentTrajectoryEventType.ERROR, text: message })
				if (subagentCard) {
					const failedCardUpdate = {
						header: `${entry.name}: ${entry.taskTitle}`,
						status: CardStatus.ERROR,
						body: formatSubagentTrajectory({
							id: entry.index,
							name: entry.name,
							taskTitle: entry.taskTitle,
							prompt: entry.prompt,
							status: SubagentExecutionStatus.FAILED,
							trajectory,
						}),
						rawOutput: createSubagentCardOutput(SubagentExecutionStatus.FAILED, trajectory),
					}
					const applyFailedCardState = async () => {
						await runCardOperation(
							subagentCard!.update(failedCardUpdate),
							"terminal_update",
							`Subagent '${entry.name}' failed card update timed out.`,
							SubagentExecutionStatus.FAILED,
						)
						await runCardOperation(
							subagentCard!.finalize(CardStatus.ERROR),
							"finalize",
							`Subagent '${entry.name}' failed card finalization timed out.`,
							SubagentExecutionStatus.FAILED,
						)
					}
					presentation.stopAcceptingUpdates()
					const intermediateUpdates = await waitForPresentationOperation(
						presentation.waitForInFlightPresentation(),
					)
					if (intermediateUpdates.timedOut) {
						reportAgentIssue(
							"intermediate_update",
							true,
							new Error(`Subagent '${entry.name}' presentation did not drain before the timeout.`),
							SubagentExecutionStatus.FAILED,
						)
					}
					await applyFailedCardState()
				}
				throw error
			}
		})

		const results = await Promise.allSettled(execution)
		results.forEach((result, index) => {
			const entry = entries[index]
			if (result.status === "rejected") {
				entry.status = SubagentExecutionStatus.FAILED
				entry.error = (result.reason as Error)?.message || "Subagent execution failed"
				env.logging.debug(
					`[UseSubagentsTool] result_reconciled task=${taskId} requestIndex=${index} agentId=${entry.index} agentName=${entry.name} status=${entry.status}`,
				)
				return
			}

			const runResult = result.value
			entry.status = runResult.status
			entry.result = runResult.result
			entry.error = runResult.error
			entry.toolCalls = runResult.stats.toolCalls
			entry.inputTokens = runResult.stats.inputTokens
			entry.outputTokens = runResult.stats.outputTokens
			entry.cacheWrites = runResult.stats.cacheWriteTokens
			entry.cacheReads = runResult.stats.cacheReadTokens
			entry.totalCost = runResult.stats.totalCost
			entry.contextTokens = runResult.stats.contextTokens
			entry.contextWindow = runResult.stats.contextWindow
			entry.contextUsagePercentage = runResult.stats.contextUsagePercentage
			env.logging.debug(
				`[UseSubagentsTool] result_reconciled task=${taskId} requestIndex=${index} agentId=${entry.index} agentName=${entry.name} status=${entry.status}`,
			)
		})
	}

	private formatFinalResponse(entries: SubagentStatusItem[]): string {
		const succeeded = entries.filter((entry) => entry.status === SubagentExecutionStatus.COMPLETED).length
		const failed = entries.filter((entry) => entry.status === SubagentExecutionStatus.FAILED).length
		const cancelled = entries.filter((entry) => entry.status === SubagentExecutionStatus.CANCELLED).length
		const totalToolCalls = entries.reduce((acc, entry) => acc + (entry.toolCalls || 0), 0)
		const maxContextTokens = entries.reduce((acc, entry) => Math.max(acc, entry.contextTokens || 0), 0)
		const contextWindow = entries.reduce((acc, entry) => Math.max(acc, entry.contextWindow || 0), 0)
		const maxContextUsagePercentage = entries.reduce((acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0), 0)
		const totalCacheReads = entries.reduce((acc, entry) => acc + (entry.cacheReads || 0), 0)
		const totalCacheWrites = entries.reduce((acc, entry) => acc + (entry.cacheWrites || 0), 0)

		return [
			"Subagent results:",
			`Total: ${entries.length}`,
			`Succeeded: ${succeeded}`,
			`Failed: ${failed}`,
			`Cancelled: ${cancelled}`,
			`Tool calls: ${totalToolCalls}`,
			`Peak context usage: ${maxContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${maxContextUsagePercentage.toFixed(1)}%)`,
			`Cache: ${totalCacheReads.toLocaleString()} reads, ${totalCacheWrites.toLocaleString()} writes`,
			"",
			...entries.map((entry) => {
				const header = `${entry.name}: ${entry.taskTitle} · ${entry.status.toUpperCase()} - ${entry.prompt}`
				const detail = (entry.status === SubagentExecutionStatus.COMPLETED ? entry.result : entry.error)?.trim()
				return detail ? `${header}\n${detail}` : header
			}),
		]
			.filter((line): line is string => line !== undefined)
			.join("\n")
	}
	private formatSubagentLiveState(item: SubagentStatusItem): string {
		const phase = item.phase ?? "waiting to start"
		const phaseElapsedSeconds = item.phaseStartedAt ? Math.max(0, Math.floor((Date.now() - item.phaseStartedAt) / 1000)) : 0
		const idleSeconds = item.lastActivityAt ? Math.max(0, Math.floor((Date.now() - item.lastActivityAt) / 1000)) : 0
		const activity = item.isStalled ? "⚠ stalled" : "active"
		const artifactPaths = [
			item.transcriptPath ? `transcript: \`${item.transcriptPath}\`` : undefined,
			item.diagnosticsPath ? `diagnostics: \`${item.diagnosticsPath}\`` : undefined,
		]
			.filter((value): value is string => value !== undefined)
			.join(" · ")
		return [
			`**Runtime:** ${activity} · phase \`${phase}\` for ${phaseElapsedSeconds}s · idle ${idleSeconds}s`,
			artifactPaths ? `**Artifacts:** ${artifactPaths}` : undefined,
		]
			.filter((value): value is string => value !== undefined)
			.join("\n")
	}

	private formatSubagentStatusMarkdown(payload: any): string {
		let md = `### Subagent Status (${payload.completed}/${payload.total})\n\n`
		md += `| Agent | Status | Live state | Prompt | Tokens (In/Out) | Cost |\n`
		md += `|-------|--------|------------|--------|-----------------|------|\n`
		payload.items.forEach((item: SubagentStatusItem) => {
			const displayStatus = item.isWrappingUp && !isTerminalSubagentStatus(item.status) ? "wrapping up" : item.status
			const statusIcon =
				item.status === SubagentExecutionStatus.COMPLETED
					? "✓"
					: item.status === SubagentExecutionStatus.FAILED
						? "❌"
						: item.status === SubagentExecutionStatus.CANCELLED
							? "⊘"
							: "⏳"
			const tokens = `${item.inputTokens.toLocaleString()} / ${item.outputTokens.toLocaleString()}`
			const cost = `$${item.totalCost.toFixed(4)}`
			const phase = item.phase ?? "waiting"
			const idleSeconds = item.lastActivityAt ? Math.max(0, Math.floor((Date.now() - item.lastActivityAt) / 1000)) : 0
			const liveState = item.isStalled ? `⚠ stalled: ${phase}` : `${phase} · idle ${idleSeconds}s`
			md += `| ${item.name}: ${item.taskTitle} | ${statusIcon} ${displayStatus} | ${liveState} | ${item.prompt} | ${tokens} | ${cost} |\n`
		})
		const artifactLinks = payload.items
			.map((item: SubagentStatusItem) => {
				if (!item.transcriptPath && !item.diagnosticsPath) return undefined
				const paths = [
					item.transcriptPath ? `transcript: \`${item.transcriptPath}\`` : undefined,
					item.diagnosticsPath ? `diagnostics: \`${item.diagnosticsPath}\`` : undefined,
				]
					.filter((value): value is string => value !== undefined)
					.join(" · ")
				return `- **${item.name}** — ${paths}`
			})
			.filter((value: string | undefined): value is string => value !== undefined)
		if (artifactLinks.length > 0) md += `\n\n**Run artifacts**\n${artifactLinks.join("\n")}`
		md += `\n\n**Total Cost:** $${payload.items.reduce((acc: number, i: SubagentStatusItem) => acc + i.totalCost, 0).toFixed(4)}`
		return md
	}
}

const operations = ["list", "inspect", "transcript", "steer", "interrupt", "resume", "resolve", "sleep"] as const
type Operation = (typeof operations)[number]
const resolutions = ["answer", "approve", "reject", "escalate"] as const

export const tasklets_spec: DiracToolSpec = {
	id: "tasklets",
	name: "tasklets",
	description:
		"Supervise this ordinary root's private tasklets. Inspect returns retained results, responses and pending interactions; transcript returns full conversation/presentation without preview truncation. Guidance is queued, not necessarily consumed, and does not answer an interaction. Resume explicitly reopens a terminal tasklet under the same ID and returns acceptance, not completion. Resolve questions with answer (optionally action for a displayed choice), permissions with approve/reject/escalate; approval never exceeds current parent authority. Escalate asks the user through the parent. Sleep voluntarily waits for communication, a deadline or any user message without consuming events, joining children or polling. Omit tasklet_ids for any child; [] waits only for time/user input and requires timeout_ms. Inspect after waking; a wake is not completion.",
	parameters: [
		{ name: "operation", required: true, instruction: "Control operation.", enum: operations },
		{
			name: "tasklet_id",
			required: false,
			instruction: "Stable tasklet ID; required except for list and sleep.",
			minLength: 1,
		},
		{
			name: "message",
			required: false,
			instruction: "Required guidance for steer; optional follow-up for resume or reason for interrupt.",
			minLength: 1,
		},
		{
			name: "request_id",
			required: false,
			instruction: "Stable pending interaction ID, required for resolve.",
			minLength: 1,
		},
		{
			name: "resolution",
			required: false,
			instruction: "Required for resolve. Questions and permissions are distinct.",
			enum: resolutions,
		},
		{
			name: "answer",
			required: false,
			instruction: "Free-text answer for resolution=answer. Supply answer, action or both.",
			minLength: 1,
		},
		{
			name: "action",
			required: false,
			instruction:
				"Displayed choice value for resolution=answer, including approve for operational Retry; not a permission grant.",
			minLength: 1,
		},
		{
			name: "tasklet_ids",
			type: "array",
			required: false,
			instruction: "Only for sleep: communication sources. Omit for any; [] for time/user only.",
			items: { type: "string", minLength: 1 },
		},
		{
			name: "timeout_ms",
			type: "integer",
			required: false,
			instruction: "Only for sleep: optional relative deadline in milliseconds.",
			minimum: 0,
			maximum: 2147483647,
		},
	],
}

export class TaskletsTool implements IDiracTool {
	spec(): DiracToolSpec {
		return tasklets_spec
	}
	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, env: IToolEnvironment): Promise<string> {
		const controls = env.orchestration.tasklets
		if (!controls) throw new Error("Tasklet controls are available only to an owning ordinary root")
		const args = requireArguments(input)
		const operation = requireOperation(args.operation)
		validateParameters(args, operation)
		const card = await env.ui.createCard({ header: `Tasklets: ${operation}`, collapsed: true, rawInput: args })
		try {
			const result = await executeOperation(controls, operation, args)
			const output = JSON.stringify(result, null, 2)
			await card.update({
				body: operation === "transcript" ? "Full transcript returned to the parent." : `Tasklet ${operation} finished.`,
				status: CardStatus.SUCCESS,
			})
			await card.finalize(CardStatus.SUCCESS)
			return output
		} catch (error) {
			await card.update({ body: error instanceof Error ? error.message : String(error), status: CardStatus.ERROR })
			await card.finalize(CardStatus.ERROR)
			throw error
		}
	}
}

function requireArguments(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Tasklet control arguments must be an object")
	return input as Record<string, unknown>
}

function requireOperation(value: unknown): Operation {
	if (typeof value !== "string" || !operations.includes(value as Operation))
		throw new Error(`Unknown tasklet operation: ${String(value)}`)
	return value as Operation
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key]
	if (typeof value !== "string" || !value.trim()) throw new Error(`Parameter '${key}' must be a non-empty string`)
	return value
}

function validateParameters(args: Record<string, unknown>, operation: Operation): void {
	const fields: Record<Operation, string[]> = {
		list: [],
		inspect: ["tasklet_id"],
		transcript: ["tasklet_id"],
		steer: ["tasklet_id", "message"],
		interrupt: ["tasklet_id", "message"],
		resume: ["tasklet_id", "message"],
		resolve: ["tasklet_id", "request_id", "resolution", "answer", "action"],
		sleep: ["tasklet_ids", "timeout_ms"],
	}
	for (const key of Object.keys(args)) {
		if (key !== "operation" && !fields[operation].includes(key))
			throw new Error(`Parameter '${key}' is not valid for ${operation}`)
	}
	if (operation !== "list" && operation !== "sleep") requireString(args, "tasklet_id")
	if (operation === "steer" || args.message !== undefined) requireString(args, "message")
	if (operation === "resolve") {
		requireString(args, "request_id")
		if (!resolutions.includes(args.resolution as (typeof resolutions)[number]))
			throw new Error("Unknown tasklet interaction resolution")
		if (args.resolution === "answer") {
			if (args.answer === undefined && args.action === undefined)
				throw new Error("An answer or displayed action is required")
			if (args.answer !== undefined) requireString(args, "answer")
			if (args.action !== undefined) requireString(args, "action")
		} else if (args.answer !== undefined || args.action !== undefined)
			throw new Error("answer/action are valid only for resolution=answer")
	}
	if (operation === "sleep") {
		if (
			args.tasklet_ids !== undefined &&
			(!Array.isArray(args.tasklet_ids) || args.tasklet_ids.some((id) => typeof id !== "string" || !id.trim()))
		)
			throw new Error("tasklet_ids must be an array of non-empty IDs")
		if (
			args.timeout_ms !== undefined &&
			(!Number.isInteger(args.timeout_ms) || (args.timeout_ms as number) < 0 || (args.timeout_ms as number) > 2147483647)
		)
			throw new Error("timeout_ms must be an integer from 0 to 2147483647")
		if (Array.isArray(args.tasklet_ids) && args.tasklet_ids.length === 0 && args.timeout_ms === undefined)
			throw new Error("Time-only sleep requires timeout_ms")
	}
}

function executeOperation(controls: TaskletControls, operation: Operation, args: Record<string, unknown>): unknown {
	const id = args.tasklet_id as string
	switch (operation) {
		case "list":
			return controls.list()
		case "inspect":
			return controls.inspect(id)
		case "transcript":
			return controls.readTranscript(id)
		case "steer":
			return controls.steer(id, args.message as string)
		case "interrupt":
			return controls.interrupt(id, args.message as string | undefined)
		case "resume":
			return controls.resume(id, args.message as string | undefined)
		case "resolve": {
			const decision: TaskletInteractionDecision =
				args.resolution === "answer"
					? {
							operation: "answer",
							response: {
								action: (args.action as string | undefined) ?? DiracAskResponse.MESSAGE,
								response: Object.values(DiracAskResponse).includes(args.action as DiracAskResponse)
									? (args.action as DiracAskResponse)
									: DiracAskResponse.MESSAGE,
								...(args.action === undefined ? {} : { value: args.action as string }),
								...(args.answer === undefined ? {} : { text: args.answer as string }),
							},
						}
					: { operation: args.resolution as "approve" | "reject" | "escalate" }
			return controls.resolveInteraction(id, args.request_id as string, decision)
		}
		case "sleep":
			return controls.sleep({
				taskletIds: args.tasklet_ids as string[] | undefined,
				timeoutMs: args.timeout_ms as number | undefined,
			})
	}
}
