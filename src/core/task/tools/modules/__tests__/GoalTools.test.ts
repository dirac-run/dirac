import { strict as assert } from "node:assert"
import type { GoalChildRecord } from "@shared/goal"
import { CardStatus, type Card } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import { GOAL_TOOL_NAMES, isToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import { ToolDiscoveryService } from "../../discovery/ToolDiscoveryService"
import type { CardParams, ICardHandle, IGoalTrait, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { BlockGoalTool } from "../block_goal/BlockGoalTool"
import { CancelTaskTool } from "../cancel_task/CancelTaskTool"
import { ListTasksTool } from "../list_tasks/ListTasksTool"
import { ReadTaskTranscriptTool } from "../read_task_transcript/ReadTaskTranscriptTool"
import { ResolveTaskInteractionTool } from "../resolve_task_interaction/ResolveTaskInteractionTool"
import { SendTaskMessageTool } from "../send_task_message/SendTaskMessageTool"
import { StartTaskTool } from "../start_task/StartTaskTool"
import { UpdateGoalTool } from "../update_goal/UpdateGoalTool"
import { VerifyGoalTool } from "../verify_goal/VerifyGoalTool"
import { WaitForGoalEventsTool } from "../wait_for_goal_events/WaitForGoalEventsTool"

interface GoalCall {
	method: keyof IGoalTrait
	input?: unknown
}

function child(overrides: Partial<GoalChildRecord> = {}): GoalChildRecord {
	return {
		id: "child-1",
		title: "Inspect implementation",
		role: "task",
		status: "starting",
		createdAt: 1,
		lastActivityAt: 1,
		deliveredResponseCursor: 0,
		...overrides,
	}
}

function goalEnvironment(): {
	environment: IToolEnvironment
	calls: GoalCall[]
	cards: Card[]
	abortController: AbortController
} {
	const calls: GoalCall[] = []
	const cards: Card[] = []
	const abortController = new AbortController()
	const goal: IGoalTrait = {
		async startTask(input) {
			calls.push({ method: "startTask", input })
			return child()
		},
		async listTasks(input) {
			calls.push({ method: "listTasks", input })
			return { tasks: [{ ...child(), idleDurationMs: 0 }], nextCursor: "next-tasks" }
		},
		async sendTaskMessage(input) {
			calls.push({ method: "sendTaskMessage", input })
			return child({ status: "running" })
		},
		async cancelTask(input) {
			calls.push({ method: "cancelTask", input })
			return child({ status: "cancelled" })
		},
		async readTaskTranscript(input) {
			calls.push({ method: "readTaskTranscript", input })
			return { entries: [], nextCursor: "next-transcript" }
		},
		async resolveTaskInteraction(input) {
			calls.push({ method: "resolveTaskInteraction", input })
			return { resolved: true, task: child({ status: "running" }) }
		},
		async waitForEvents() {
			calls.push({ method: "waitForEvents" })
			return "Goal wake #1"
		},
		async startVerification(input) {
			calls.push({ method: "startVerification", input })
			return child({ id: "verification-1", role: "verification" })
		},
		async replaceObjective(markdown) {
			calls.push({ method: "replaceObjective", input: markdown })
			return { markdown, revision: 2, updatedAt: 2 }
		},
		async blockGoal(reason) {
			calls.push({ method: "blockGoal", input: reason })
		},
		async commitCompletion(result) {
			calls.push({ method: "commitCompletion", input: result })
			return { committed: true }
		},
	}
	const ui = {
		createCard: async (params: CardParams) => createCardHandle(cards, params),
	}
	const orchestration = {
		getTaskState: (key: string) => {
			if (key !== "abortSignal") throw new Error(`Unexpected Task state '${key}'.`)
			return abortController.signal
		},
	}
	const environment = new Proxy({ goal, ui, orchestration } as unknown as IToolEnvironment, {
		get(target, property, receiver) {
			if (!new Set(["goal", "ui", "orchestration"]).has(String(property))) {
				throw new Error(`Goal tool read unexpected environment property '${String(property)}'.`)
			}
			return Reflect.get(target, property, receiver)
		},
	})
	return { environment, calls, cards, abortController }
}

function createCardHandle(cards: Card[], params: CardParams): ICardHandle {
	const card: Card = {
		id: `card-${cards.length + 1}`,
		header: params.header,
		icon: params.icon,
		status: params.status ?? CardStatus.RUNNING,
		renderType: params.renderType ?? "text",
		body: params.body,
		rawInput: params.rawInput,
		rawOutput: params.rawOutput,
		collapsed: params.collapsed,
	}
	cards.push(card)
	return {
		get id() {
			return card.id
		},
		get header() {
			return card.header
		},
		get icon() {
			return card.icon
		},
		get status() {
			return card.status
		},
		get renderType() {
			return card.renderType
		},
		get body() {
			return card.body
		},
		get rawInput() {
			return card.rawInput
		},
		get rawOutput() {
			return card.rawOutput
		},
		get locations() {
			return card.locations
		},
		get requireApproval() {
			return card.requireApproval
		},
		get requireFeedback() {
			return card.requireFeedback
		},
		get feedbackPlaceholder() {
			return card.feedbackPlaceholder
		},
		get actions() {
			return card.actions
		},
		get collapsed() {
			return card.collapsed ?? true
		},
		get maxHeight() {
			return card.maxHeight
		},
		get cleanupStrategy() {
			return card.cleanupStrategy
		},
		async update(patch) {
			Object.assign(card, patch)
		},
		async appendBody(chunk) {
			card.body = `${card.body ?? ""}${chunk}`
		},
		async finalize(status) {
			card.status = status
		},
		async waitForInteraction() {
			return { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
		},
	}
}

describe("Goal-only tools", () => {
	it("delegate exclusively through the Goal trait and normalize pagination defaults", async () => {
		const { environment, calls, cards } = goalEnvironment()

		assert.equal(
			JSON.parse(await new StartTaskTool().processCall({ task_title: "Inspect", prompt: "Inspect it" }, environment)).id,
			"child-1",
		)
		assert.equal(JSON.parse(await new ListTasksTool().processCall({}, environment)).nextCursor, "next-tasks")
		assert.match(
			await new SendTaskMessageTool().processCall({ task_id: "child-1", message: "Continue" }, environment),
			/queued/,
		)
		assert.equal(JSON.parse(await new CancelTaskTool().processCall({ task_id: "child-1" }, environment)).status, "cancelled")
		assert.equal(
			JSON.parse(await new ReadTaskTranscriptTool().processCall({ task_id: "child-1" }, environment)).nextCursor,
			"next-transcript",
		)
		assert.deepEqual(
			JSON.parse(
				await new ResolveTaskInteractionTool().processCall(
					{ task_id: "child-1", interaction_id: "interaction-1", resolution: "answer", answer: "Yes" },
					environment,
				),
			),
			{ resolved: true },
		)
		assert.equal(await new WaitForGoalEventsTool().processCall({}, environment), "Goal wake #1")
		assert.equal(JSON.parse(await new VerifyGoalTool().processCall({ focus: "Tests" }, environment)).role, "verification")
		assert.equal(
			JSON.parse(await new UpdateGoalTool().processCall({ objective_markdown: "# Revised" }, environment)).revision,
			2,
		)
		assert.match(await new BlockGoalTool().processCall({ reason: "Needs credentials" }, environment), /Needs credentials/)

		assert.deepEqual(calls, [
			{ method: "startTask", input: { taskTitle: "Inspect", prompt: "Inspect it" } },
			{ method: "listTasks", input: { status: undefined, role: undefined, cursor: undefined, limit: 20 } },
			{ method: "sendTaskMessage", input: { taskId: "child-1", message: "Continue" } },
			{ method: "cancelTask", input: { taskId: "child-1", reason: undefined } },
			{ method: "readTaskTranscript", input: { taskId: "child-1", cursor: undefined, limit: 50 } },
			{
				method: "resolveTaskInteraction",
				input: { taskId: "child-1", interactionId: "interaction-1", resolution: "answer", answer: "Yes" },
			},
			{ method: "waitForEvents" },
			{ method: "startVerification", input: { focus: "Tests" } },
			{ method: "replaceObjective", input: "# Revised" },
			{ method: "blockGoal", input: "Needs credentials" },
		])
		assert.deepEqual(
			cards.map((card) => [card.header, card.status, card.collapsed]),
			[
				["Started task: Inspect implementation", CardStatus.SUCCESS, true],
				["Messaged task: Inspect implementation", CardStatus.SUCCESS, true],
				["Cancelled task: Inspect implementation", CardStatus.SUCCESS, true],
				["Resolved task interaction: Inspect implementation", CardStatus.SUCCESS, true],
				["Started verification: Inspect implementation", CardStatus.SUCCESS, true],
			],
		)
		assert.match(cards[0].body ?? "", /Task ID.*child-1/)
		assert.match(cards[0].body ?? "", /Assignment.*Inspect it/s)
	})

	it("finalizes a failed task action card without hiding the action failure", async () => {
		const { environment, cards } = goalEnvironment()
		environment.goal!.startTask = async () => {
			throw new Error("startup failed")
		}

		await assert.rejects(
			new StartTaskTool().processCall({ task_title: "Inspect", prompt: "Inspect it" }, environment),
			/startup failed/,
		)
		assert.equal(cards.length, 1)
		assert.equal(cards[0].status, CardStatus.ERROR)
		assert.equal(cards[0].header, "Failed to start task: Inspect")
		assert.match(cards[0].body ?? "", /startup failed/)
	})

	it("marks a failed task action card cancelled when the coordinator is aborted", async () => {
		const { environment, cards, abortController } = goalEnvironment()
		environment.goal!.startTask = async () => {
			abortController.abort()
			throw new Error("Goal stopped")
		}

		await assert.rejects(
			new StartTaskTool().processCall({ task_title: "Inspect", prompt: "Inspect it" }, environment),
			/Goal stopped/,
		)
		assert.equal(cards[0].status, CardStatus.CANCELLED)
	})

	it("reports both the task action and card finalization failures", async () => {
		const { environment } = goalEnvironment()
		const createCard = environment.ui.createCard
		environment.ui.createCard = async (params) => {
			const card = await createCard(params)
			card.finalize = async () => {
				throw new Error("card finalization failed")
			}
			return card
		}
		environment.goal!.startTask = async () => {
			throw new Error("startup failed")
		}

		await assert.rejects(
			new StartTaskTool().processCall({ task_title: "Inspect", prompt: "Inspect it" }, environment),
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.some((entry) => entry instanceof Error && entry.message === "startup failed") &&
				error.errors.some((entry) => entry instanceof Error && entry.message === "card finalization failed"),
		)
	})

	it("leaves passthrough presentation to the Goal interaction surface", async () => {
		const { environment, calls, cards } = goalEnvironment()

		assert.deepEqual(
			JSON.parse(
				await new ResolveTaskInteractionTool().processCall(
					{ task_id: "child-1", interaction_id: "interaction-1", resolution: "passthrough" },
					environment,
				),
			),
			{ resolved: true },
		)
		assert.deepEqual(calls, [
			{
				method: "resolveTaskInteraction",
				input: { taskId: "child-1", interactionId: "interaction-1", resolution: "passthrough" },
			},
		])
		assert.deepEqual(cards, [])
	})

	it("reports the authoritative status when cancellation is an idempotent no-op", async () => {
		const { environment, cards } = goalEnvironment()
		environment.goal!.cancelTask = async () => child({ status: "completed", endedAt: 5 })

		const result = JSON.parse(await new CancelTaskTool().processCall({ task_id: "child-1" }, environment))

		assert.equal(result.status, "completed")
		assert.equal(cards[0].status, CardStatus.SUCCESS)
		assert.equal(cards[0].header, "Task already completed: Inspect implementation")
	})

	it("rejects missing or blank required text before calling the Goal trait", async () => {
		const { environment, calls } = goalEnvironment()
		const invalidCalls: Array<() => Promise<unknown>> = [
			() => new StartTaskTool().processCall({ task_title: " ", prompt: "prompt" }, environment),
			() => new StartTaskTool().processCall({ task_title: "title", prompt: "\n" }, environment),
			() => new SendTaskMessageTool().processCall({ task_id: "", message: "message" }, environment),
			() => new SendTaskMessageTool().processCall({ task_id: "child-1", message: " " }, environment),
			() => new CancelTaskTool().processCall({ task_id: " " }, environment),
			() => new ReadTaskTranscriptTool().processCall({ task_id: " " }, environment),
			() =>
				new ResolveTaskInteractionTool().processCall(
					{ task_id: "child-1", interaction_id: " ", resolution: "allow" },
					environment,
				),
			() => new UpdateGoalTool().processCall({ objective_markdown: " " }, environment),
			() => new BlockGoalTool().processCall({ reason: " " }, environment),
		]

		for (const call of invalidCalls) await assert.rejects(call, /non-empty string/)
		assert.deepEqual(calls, [])
	})

	it("enforces list and transcript page bounds", async () => {
		const { environment, calls } = goalEnvironment()
		for (const limit of [0, 1.5, 101]) {
			await assert.rejects(new ListTasksTool().processCall({ limit }, environment), /1 through 100/)
		}
		for (const limit of [0, 1.5, 201]) {
			await assert.rejects(
				new ReadTaskTranscriptTool().processCall({ task_id: "child-1", limit }, environment),
				/1 through 200/,
			)
		}
		await new ListTasksTool().processCall({ limit: 100 }, environment)
		await new ReadTaskTranscriptTool().processCall({ task_id: "child-1", limit: 200 }, environment)
		assert.deepEqual(
			calls.map((call) => call.input),
			[
				{ status: undefined, role: undefined, cursor: undefined, limit: 100 },
				{ taskId: "child-1", cursor: undefined, limit: 200 },
			],
		)
	})

	it("requires answer text only for answer interaction resolutions", async () => {
		const { environment, calls } = goalEnvironment()
		const tool = new ResolveTaskInteractionTool()
		await assert.rejects(
			tool.processCall({ task_id: "child-1", interaction_id: "interaction-1", resolution: "answer" }, environment),
			/answer.*non-empty/,
		)
		await assert.rejects(
			tool.processCall(
				{ task_id: "child-1", interaction_id: "interaction-1", resolution: "allow", answer: "extra" },
				environment,
			),
			/only when resolution is 'answer'/,
		)
		await assert.rejects(
			tool.processCall({ task_id: "child-1", interaction_id: "interaction-1", resolution: "later" }, environment),
			/resolution/,
		)
		assert.deepEqual(calls, [])
	})

	it("treats a missing Goal trait as a coordinator construction error", async () => {
		await assert.rejects(
			new StartTaskTool().processCall({ task_title: "Inspect", prompt: "Inspect it" }, {} as IToolEnvironment),
			/Goal coordinator environment/,
		)
	})

	it("discovers all Goal tools as coordinator-only and non-configurable", () => {
		const tools = ToolDiscoveryService.scanBuiltinTools().filter((tool) =>
			(GOAL_TOOL_NAMES as readonly string[]).includes(tool.name),
		)
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [...GOAL_TOOL_NAMES].sort())
		for (const tool of tools) {
			assert.deepEqual(tool.exposure, { kind: "profile_only", profiles: ["goal_coordinator"] })
			assert.equal(isToolAvailableToTaskProfile("goal_coordinator", tool.name), true)
			assert.equal(isToolAvailableToTaskProfile("standalone", tool.name), false)
			assert.equal(isToolAvailableToTaskProfile("goal_child", tool.name), false)
		}

		ToolRegistry.resetInstance()
		const registry = ToolRegistry.getInstance()
		for (const tool of tools) registry.registerBuiltin(tool)
		assert.deepEqual(registry.getConfigurableTools(), [])
		assert.equal(registry.getEnabledTools().length, GOAL_TOOL_NAMES.length)
		assert.equal(registry.scopeToolForSubagent(tools[0], GOAL_TOOL_NAMES), undefined)
		assert.throws(() => registry.disable(tools[0].id), /\(profile_only\) cannot be enabled or disabled directly/)
	})
})
