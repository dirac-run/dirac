import { formatResponse } from "@core/formatResponse"
import { CardStatus } from "@shared/ExtensionMessage"
import { SUBAGENT_TASK_TITLE_MAX_CHARS, SUBAGENT_TASK_TITLE_MAX_WORDS } from "@shared/subagents"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { toError } from "@/shared/errors"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import type { TaskletControls, TaskletInteractionDecision } from "../../interfaces/IToolEnvironment"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS, resolveSubagentTimeoutSeconds } from "../../subagent/SubagentExecutionPolicy"

export const use_subagents_spec: DiracToolSpec = {
	id: DiracDefaultTool.USE_SUBAGENTS,
	name: "use_subagents",
	description:
		"Start subagents asynchronously. Returns per-assignment accepted tasklet IDs or startup errors, not completed results. Accepted children continue independently; later results and requests arrive through parent communication. Use tasklets to inspect stable IDs or voluntarily sleep for communication, rather than joining or polling.",
	contextRequirements: (context) => context.subagentsEnabled === true,
	parameters: [
		{
			name: "subagents",
			type: "array",
			required: true,
			instruction: "Assignments to start concurrently; acceptance does not mean assignment completion.",
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

	async processCall(args: unknown, env: IToolEnvironment): Promise<string> {
		const controls = env.orchestration.tasklets
		if (!controls) throw new Error("Tasklet spawning is available only to an owning root")
		const agentName = AgentConfigLoader.getInstance().resolveSubagentNameForTool(env.toolName)
		const batch = args && typeof args === "object" && "subagents" in args ? args.subagents : undefined
		const assignments: unknown[] = agentName ? [args] : Array.isArray(batch) ? batch : []
		if (assignments.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError(`Missing required parameter: ${agentName ? "prompt" : "subagents"}`)
		}

		const card = await this.createSpawnCard(env)
		const results = await Promise.all(
			assignments.map(async (assignment, index) => {
				let title: string | undefined
				try {
					const request = this.parseRequest(assignment, `Subagent ${index + 1}`)
					title = request.title
					const record = await controls.start({ ...request, agentName })
					const outcome = record.outcome
					const error =
						outcome?.kind === "failed"
							? outcome.error.message
							: outcome?.kind === "interrupted" || outcome?.kind === "cancelled"
								? (outcome.reason ?? "Tasklet startup was cancelled")
								: undefined
					return {
						index,
						id: record.id,
						title: record.title,
						accepted: error === undefined,
						...(outcome ? { outcome } : {}),
						...(error === undefined ? {} : { error }),
					}
				} catch (error) {
					return { index, ...(title ? { title } : {}), accepted: false, error: toError(error).message }
				}
			}),
		)
		if (card) {
			const accepted = results.filter((result) => result.accepted).length
			const status = accepted === results.length ? CardStatus.SUCCESS : CardStatus.ERROR
			await this.present(
				card.update({
					header: "Subagent startup",
					body: `${accepted} accepted; ${results.length - accepted} startup errors. Acceptance is not assignment completion. Use tasklets to inspect or sleep for later communication.`,
					status,
				}),
				env,
			)
			await this.present(card.finalize(status), env)
		}
		return JSON.stringify({ subagents: results }, null, 2)
	}

	private parseRequest(input: unknown, subject: string) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error(`${subject} assignment must be an object`)
		const args = input as Record<string, unknown>
		const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
		if (!prompt) throw new Error(`${subject} is missing required parameter: prompt`)
		return {
			title: this.parseTaskTitle(args.task_title, prompt, subject),
			prompt,
			timeoutSeconds: resolveSubagentTimeoutSeconds(
				args.timeout === undefined ? DEFAULT_SUBAGENT_TIMEOUT_SECONDS : Number(args.timeout),
			),
			includeHistory: args.include_history === true || args.include_history === "true",
			useUtilityModel: args.use_utility_model === true || args.use_utility_model === "true",
		}
	}

	private parseTaskTitle(value: unknown, prompt: string, subject: string): string {
		const taskTitle = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
		if (!taskTitle) {
			const title = prompt.replace(/\s+/g, " ").split(" ").slice(0, SUBAGENT_TASK_TITLE_MAX_WORDS).join(" ")
			return title.length <= SUBAGENT_TASK_TITLE_MAX_CHARS ? title : `${title.slice(0, SUBAGENT_TASK_TITLE_MAX_CHARS - 1)}…`
		}
		if (taskTitle.split(" ").length > SUBAGENT_TASK_TITLE_MAX_WORDS)
			throw new Error(`${subject} parameter task_title must contain no more than ${SUBAGENT_TASK_TITLE_MAX_WORDS} words`)
		if (taskTitle.length > SUBAGENT_TASK_TITLE_MAX_CHARS)
			throw new Error(
				`${subject} parameter task_title must contain no more than ${SUBAGENT_TASK_TITLE_MAX_CHARS} characters`,
			)
		return taskTitle
	}

	private async createSpawnCard(env: IToolEnvironment): Promise<ICardHandle | undefined> {
		const creation = env.ui.createCard({ header: "Start Subagents", icon: DiracIcon.SUBAGENTS, collapsed: true })
		try {
			const result = await waitForPresentationOperation(creation)
			if (!result.timedOut) return result.value
			env.logging.warn("[UseSubagentsTool] Spawn card creation timed out")
			void creation
				.then((card) => this.present(card.finalize(CardStatus.ABANDONED), env))
				.catch((error) => {
					env.logging.warn("[UseSubagentsTool] Late spawn card creation failed", toError(error))
				})
		} catch (error) {
			env.logging.warn("[UseSubagentsTool] Spawn card creation failed", toError(error))
		}
		return undefined
	}

	private async present(operation: Promise<void>, env: IToolEnvironment): Promise<void> {
		try {
			const result = await waitForPresentationOperation(operation)
			if (result.timedOut) env.logging.warn("[UseSubagentsTool] Spawn card presentation timed out")
		} catch (error) {
			env.logging.warn("[UseSubagentsTool] Spawn card presentation failed", toError(error))
		}
	}
}

const operations = ["list", "inspect", "transcript", "steer", "interrupt", "resume", "resolve", "sleep"] as const
type Operation = (typeof operations)[number]
const resolutions = ["answer", "approve", "reject", "escalate"] as const

export const tasklets_spec: DiracToolSpec = {
	id: "tasklets",
	name: "tasklets",
	description:
		"Supervise this root's private tasklets. Inspect returns retained results, responses and pending interactions; transcript returns full conversation/presentation without preview truncation. Guidance is queued, not necessarily consumed, and does not answer an interaction. Resume explicitly reopens a terminal tasklet under the same ID and returns acceptance, not completion. Resolve questions with answer (optionally action for a displayed choice), permissions with approve/reject/escalate; approval never exceeds current parent authority. Escalate asks the user through the parent. Sleep voluntarily waits for communication, a deadline or any user message without consuming events, joining children or polling. Omit tasklet_ids for any child; [] waits only for time/user input and requires timeout_ms. Inspect after waking; a wake is not completion.",
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
		if (!controls) throw new Error("Tasklet controls are available only to an owning root")
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
