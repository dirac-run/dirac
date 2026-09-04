import { strict as assert } from "node:assert"
import { CardStatus, SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { SubagentTrajectoryEventType } from "@shared/subagents"
import { describe, it } from "mocha"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { UseSubagentsTool, use_subagents_spec } from "./UseSubagentsTool"

const EMPTY_STATS = {
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheWriteTokens: 0,
	cacheReadTokens: 0,
	totalCost: 0,
	contextTokens: 0,
	contextWindow: 0,
	contextUsagePercentage: 0,
}

interface RecordedCard {
	id: string
	params: any
	updates: any[]
	finalStatuses: unknown[]
}

function createRecordedCardEnvironment(
	runSubagent: (_prompt: string, options: any) => Promise<any>,
	shouldFailUpdate: (params: any) => boolean = () => false,
	beforeCardUpdate: (params: any, patch: any) => Promise<void> = async () => {},
	beforeCreateCard: (params: any) => Promise<void> = async () => {},
): {
	env: IToolEnvironment
	cards: RecordedCard[]
	warnings: unknown[][]
	telemetryMetadata: Record<string, unknown>
} {
	const cards: RecordedCard[] = []
	const warnings: unknown[][] = []
	const telemetryMetadata: Record<string, unknown> = {}
	const env = {
		toolName: "use_subagents",
		config: {
			isSubagentExecution: false,
			ulid: "parent-task",
			taskState: { abortSignal: new AbortController().signal },
		},
		orchestration: {
			getHistory: () => [],
			getTaskState: () => 0,
			setTaskState: () => {},
			runSubagent,
		},
		ui: {
			createCard: async (params: any) => {
				await beforeCreateCard(params)
				const card = {
					id: `card-${cards.length + 1}`,
					params,
					updates: [] as any[],
					finalStatuses: [] as unknown[],
				}
				cards.push(card)
				return {
					id: card.id,
					update: async (patch: any) => {
						if (shouldFailUpdate(params)) throw new Error("presentation failed")
						await beforeCardUpdate(params, patch)
						card.updates.push(patch)
					},
					finalize: async (status: unknown) => {
						card.finalStatuses.push(status)
					},
				}
			},
		},
		telemetry: {
			captureCustomMetadata: (metadata: Record<string, unknown>) => Object.assign(telemetryMetadata, metadata),
		},
		logging: {
			warn: (...args: unknown[]) => warnings.push(args),
			debug: () => {},
		},
	} as unknown as IToolEnvironment
	return { env, cards, warnings, telemetryMetadata }
}

describe("UseSubagentsTool", () => {
	it("reports cancellations separately and keeps named trajectory cards collapsed", async () => {
		const { env, cards } = createRecordedCardEnvironment(async (_prompt, options) => {
			await options.onUpdate({ status: SubagentExecutionStatus.RUNNING, stats: EMPTY_STATS })
			await options.onUpdate({ textChunk: "first chunk" })
			await options.onUpdate({ textChunk: "second chunk" })
			await options.onUpdate({
				status: SubagentExecutionStatus.CANCELLED,
				error: "cancelled by user",
				stats: EMPTY_STATS,
			})
			return { status: SubagentExecutionStatus.CANCELLED, error: "cancelled by user", stats: EMPTY_STATS }
		})

		const result = await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Investigating subagent behavior", prompt: "Investigate" }] },
			env,
		)
		const agentCard = cards.find((card) => card.params.header !== "Run Subagents")

		assert.match(result as string, /Succeeded: 0/)
		assert.match(result as string, /Failed: 0/)
		assert.match(result as string, /Cancelled: 1/)
		assert.ok(agentCard)
		assert.equal(agentCard.params.collapsed, true)
		assert.equal(agentCard.params.header, `${agentCard.params.rawInput.agentName}: Investigating subagent behavior`)
		assert.equal(agentCard.params.rawInput.taskTitle, "Investigating subagent behavior")
		assert.equal(agentCard.updates.length, 2)
		assert.deepEqual(agentCard.finalStatuses, [CardStatus.CANCELLED])
	})

	it("finalizes from the returned result when no terminal progress update is emitted", async () => {
		expectLoggerErrors()
		const { env, cards } = createRecordedCardEnvironment(async () => ({
			status: SubagentExecutionStatus.COMPLETED,
			result: "done",
			stats: EMPTY_STATS,
		}))

		await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Investigating subagent behavior", prompt: "Investigate" }] },
			env,
		)
		const agentCard = cards.find((card) => card.params.header !== "Run Subagents")
		const finalUpdate = agentCard?.updates.at(-1)

		assert.ok(agentCard)
		assert.equal(finalUpdate.rawOutput.status, SubagentExecutionStatus.COMPLETED)
		assert.match(finalUpdate.body, /done/)
		assert.deepEqual(agentCard.finalStatuses, [CardStatus.SUCCESS])
	})

	it("keeps the final card update after delayed trajectory updates", async () => {
		const { env, cards } = createRecordedCardEnvironment(
			async (_prompt, options) => {
				options.onUpdate({
					trajectoryEvent: { type: SubagentTrajectoryEventType.TOOL, text: "first_tool" },
				})
				options.onUpdate({
					trajectoryEvent: { type: SubagentTrajectoryEventType.TOOL, text: "second_tool" },
				})
				return { status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }
			},
			() => false,
			async (_params, patch) => {
				if (patch.rawOutput?.status === SubagentExecutionStatus.COMPLETED) return
				if (patch.body?.includes("second_tool")) {
					await new Promise((resolve) => setTimeout(resolve, 10))
					return
				}
				if (patch.body?.includes("first_tool")) await new Promise((resolve) => setTimeout(resolve, 20))
			},
		)

		await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Tracking tool progress", prompt: "Investigate" }] },
			env,
		)
		const agentCard = cards.find((card) => card.params.rawInput?.taskTitle === "Tracking tool progress")
		const finalUpdate = agentCard?.updates.at(-1)

		assert.ok(agentCard)
		assert.equal(agentCard.params.header, `${agentCard.params.rawInput.agentName}: Tracking tool progress`)
		assert.equal(agentCard.updates.length, 2)
		assert.equal(finalUpdate.status, CardStatus.SUCCESS)
		assert.equal(finalUpdate.rawOutput.status, SubagentExecutionStatus.COMPLETED)
		assert.match(finalUpdate.body, /second_tool/)
		assert.match(finalUpdate.body, /done/)
	})

	it("marks active subagent cards as wrapping up before their final result", async () => {
		const { env, cards } = createRecordedCardEnvironment(async (_prompt, options) => {
			await options.onUpdate({ status: SubagentExecutionStatus.RUNNING, stats: EMPTY_STATS })
			await options.onUpdate({
				isWrappingUp: true,
				trajectoryEvent: { type: SubagentTrajectoryEventType.MESSAGE, text: "Time limit reached. Wrapping up findings." },
				stats: EMPTY_STATS,
			})
			return { status: SubagentExecutionStatus.COMPLETED, result: "partial report", stats: EMPTY_STATS }
		})

		await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Investigating subagent behavior", prompt: "Investigate" }] },
			env,
		)

		const aggregateCard = cards.find((card) => card.params.header === "Run Subagents")
		const agentCard = cards.find((card) => card.params.header !== "Run Subagents")
		assert.ok(aggregateCard)
		assert.ok(agentCard)
		assert.ok(aggregateCard.updates.some((update) => update.header === "Wrapping up 1 subagent"))
		assert.ok(agentCard.updates.some((update) => update.header === `${agentCard.params.rawInput.agentName}: wrapping up`))
		assert.equal(agentCard.updates.at(-1)?.header, `${agentCard.params.rawInput.agentName}: Investigating subagent behavior`)
	})

	it("returns when a presentation update never settles", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		try {
			const { env, cards, warnings } = createRecordedCardEnvironment(
				async (_prompt, options) => {
					options.onUpdate({
						trajectoryEvent: { type: SubagentTrajectoryEventType.TOOL, text: "blocked_tool" },
					})
					return { status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }
				},
				() => false,
				async (params, patch) => {
					if (params.header === "Run Subagents") return
					if (patch.rawOutput?.status === SubagentExecutionStatus.RUNNING) {
						await new Promise<void>(() => {})
					}
				},
			)

			const resultPromise = new UseSubagentsTool().processCall(
				{ subagents: [{ task_title: "Tracking blocked presentation", prompt: "Investigate" }] },
				env,
			)
			await clock.tickAsync(0)
			await clock.tickAsync(1_000)
			const result = await resultPromise

			assert.match(result as string, /Succeeded: 1/)
			assert.equal(warnings.length, 1)
			assert.match(String(warnings[0][1]), /did not drain before the timeout/)
			const agentCard = cards.find((card) => card.params.header !== "Run Subagents")
			assert.ok(agentCard)
			assert.deepEqual(agentCard.finalStatuses, [CardStatus.SUCCESS])
		} finally {
			clock.restore()
		}
	})
	it("does not replay aggregate terminal state after a timed-out update settles late", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		try {
			const { env, cards } = createRecordedCardEnvironment(
				async () => ({ status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }),
				() => false,
				async (params, patch) => {
					if (params.header === "Run Subagents" && patch.status === CardStatus.RUNNING) {
						await new Promise((resolve) => setTimeout(resolve, 1_500))
					}
				},
			)

			const resultPromise = new UseSubagentsTool().processCall(
				{ subagents: [{ task_title: "Tracking delayed aggregate", prompt: "Investigate" }] },
				env,
			)
			await clock.tickAsync(1_000)
			const result = await resultPromise
			const aggregateCard = cards.find((card) => card.params.header === "Run Subagents")

			assert.match(result as string, /Succeeded: 1/)
			assert.ok(aggregateCard)
			assert.deepEqual(aggregateCard.finalStatuses, [CardStatus.SUCCESS])

			await clock.tickAsync(500)
			await Promise.resolve()
			assert.deepEqual(aggregateCard.finalStatuses, [CardStatus.SUCCESS])
			assert.equal(
				aggregateCard.updates.filter(
					(update) => update.header === "Ran 1 subagents" && update.status === CardStatus.SUCCESS,
				).length,
				1,
			)
		} finally {
			clock.restore()
		}
	})
	it("returns when aggregate card creation never settles", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		try {
			const { env, warnings } = createRecordedCardEnvironment(
				async () => ({ status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }),
				() => false,
				async () => {},
				async (params) => {
					if (params.header === "Run Subagents") await new Promise<void>(() => {})
				},
			)

			const resultPromise = new UseSubagentsTool().processCall(
				{ subagents: [{ task_title: "Testing card timeout", prompt: "Investigate" }] },
				env,
			)
			await clock.tickAsync(1_000)
			const result = await resultPromise

			assert.match(result as string, /Succeeded: 1/)
			assert.equal(warnings.length, 1)
			assert.match(String(warnings[0][1]), /card creation timed out/)
		} finally {
			clock.restore()
		}
	})

	it("returns when a subagent card creation never settles", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		try {
			const { env, warnings } = createRecordedCardEnvironment(
				async () => ({ status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }),
				() => false,
				async () => {},
				async (params) => {
					if (params.header !== "Run Subagents") await new Promise<void>(() => {})
				},
			)

			const resultPromise = new UseSubagentsTool().processCall(
				{ subagents: [{ task_title: "Testing card timeout", prompt: "Investigate" }] },
				env,
			)
			await clock.tickAsync(0)
			await clock.tickAsync(1_000)
			const result = await resultPromise

			assert.match(result as string, /Succeeded: 1/)
			assert.equal(warnings.length, 1)
			assert.match(String(warnings[0][1]), /card creation timed out/)
		} finally {
			clock.restore()
		}
	})

	it("derives a task title for legacy calls that omit it", async () => {
		const { env, cards } = createRecordedCardEnvironment(async () => ({
			status: SubagentExecutionStatus.COMPLETED,
			result: "done",
			stats: EMPTY_STATS,
		}))

		const result = await new UseSubagentsTool().processCall(
			{ subagents: [{ prompt: "Investigate the current subagent behavior carefully" }] },
			env,
		)
		const agentCard = cards.find((card) => card.params.header !== "Run Subagents")

		assert.match(result as string, /Succeeded: 1/)
		assert.equal(
			agentCard?.params.header,
			`${agentCard?.params.rawInput.agentName}: Investigate the current subagent behavior`,
		)
		assert.equal(agentCard?.params.rawInput.taskTitle, "Investigate the current subagent behavior")
	})

	it("returns completed execution results when an agent card update fails", async () => {
		const { env, warnings, telemetryMetadata } = createRecordedCardEnvironment(
			async () => ({
				status: SubagentExecutionStatus.COMPLETED,
				result: "done",
				stats: EMPTY_STATS,
			}),
			(params) => params.header !== "Run Subagents",
		)

		const result = await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Investigating subagent behavior", prompt: "Investigate" }] },
			env,
		)

		assert.match(result as string, /Succeeded: 1/)
		assert.equal(warnings.length, 1)
		assert.match(String(warnings[0][0]), /scope=agent/)
		assert.match(String(warnings[0][0]), /phase=terminal_update/)
		assert.match(String(warnings[0][0]), /agentId=/)
		assert.match(String(warnings[0][0]), /cardId=/)
		assert.equal(telemetryMetadata.subagentPresentationIssueCount, 1)
		assert.equal(telemetryMetadata.subagentPresentationTimeoutCount, 0)
	})

	it("keeps identities associated when card creation and completion orders are reversed", async () => {
		const { env, cards } = createRecordedCardEnvironment(
			async (prompt) => {
				await new Promise((resolve) => setTimeout(resolve, prompt === "first prompt" ? 20 : 5))
				return { status: SubagentExecutionStatus.COMPLETED, result: `${prompt} result`, stats: EMPTY_STATS }
			},
			() => false,
			async () => {},
			async (params) => {
				if (params.rawInput?.prompt === "first prompt") await new Promise((resolve) => setTimeout(resolve, 15))
			},
		)

		const result = await new UseSubagentsTool().processCall(
			{
				subagents: [
					{ task_title: "Review first provider", prompt: "first prompt" },
					{ task_title: "Review second provider", prompt: "second prompt" },
				],
			},
			env,
		)
		const agentCards = cards.filter((card) => card.params.rawInput?.isSubagent)
		const firstCard = agentCards.find((card) => card.params.rawInput.prompt === "first prompt")
		const secondCard = agentCards.find((card) => card.params.rawInput.prompt === "second prompt")

		assert.equal(agentCards.length, 2)
		assert.ok(firstCard)
		assert.ok(secondCard)
		assert.notEqual(firstCard.params.rawInput.agentId, secondCard.params.rawInput.agentId)
		assert.notEqual(firstCard.params.rawInput.agentName, secondCard.params.rawInput.agentName)
		assert.match(firstCard.updates.at(-1).body, /first prompt result/)
		assert.match(secondCard.updates.at(-1).body, /second prompt result/)
		assert.match(result as string, new RegExp(`${firstCard.params.rawInput.agentName}: Review first provider · COMPLETED`))
		assert.match(result as string, new RegExp(`${secondCard.params.rawInput.agentName}: Review second provider · COMPLETED`))
	})

	it("routes each subagent through the requested model independently", async () => {
		const routes: boolean[] = []
		const { env } = createRecordedCardEnvironment(async (_prompt, options) => {
			routes.push(options.useUtilityModel)
			return {
				status: SubagentExecutionStatus.COMPLETED,
				result: "done",
				stats: EMPTY_STATS,
			}
		})

		await new UseSubagentsTool().processCall(
			{
				subagents: [
					{ task_title: "Use utility route", prompt: "first", use_utility_model: true },
					{ task_title: "Use primary route", prompt: "second" },
				],
			},
			env,
		)

		assert.deepEqual(routes.sort(), [false, true])
	})

	it("uses a 600-second default timeout without a turn-limit option", async () => {
		let receivedOptions: any
		const { env } = createRecordedCardEnvironment(async (_prompt, options) => {
			receivedOptions = options
			return {
				status: SubagentExecutionStatus.COMPLETED,
				result: "done",
				stats: EMPTY_STATS,
			}
		})

		await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Investigating subagent behavior", prompt: "Investigate" }] },
			env,
		)

		assert.equal(receivedOptions.timeout, 600)
		assert.equal("maxTurns" in receivedOptions, false)
		const subagentsParameter = use_subagents_spec.parameters?.find((parameter) => parameter.name === "subagents")
		assert.ok(subagentsParameter?.items)
		assert.deepEqual(subagentsParameter.items.required, ["task_title", "prompt"])
		assert.equal(
			subagentsParameter.items.properties.task_title.description,
			"Task header for user observability. No more than 5 words or 80 characters.",
		)
		assert.equal("max_turns" in subagentsParameter.items.properties, false)
		assert.equal("use_utility_model" in subagentsParameter.items.properties, false)
		assert.equal(receivedOptions.useUtilityModel, false)
	})

	it("rejects task titles longer than five words", async () => {
		const { env } = createRecordedCardEnvironment(async () => {
			throw new Error("Subagent should not run")
		})

		await assert.rejects(
			() =>
				new UseSubagentsTool().processCall(
					{ subagents: [{ task_title: "This title contains more than five words", prompt: "Investigate" }] },
					env,
				),
			/task_title must contain no more than 5 words/,
		)
	})

	it("rejects task titles longer than eighty characters", async () => {
		const { env } = createRecordedCardEnvironment(async () => {
			throw new Error("Subagent should not run")
		})

		await assert.rejects(
			() => new UseSubagentsTool().processCall({ subagents: [{ task_title: "x".repeat(81), prompt: "Investigate" }] }, env),
			/task_title must contain no more than 80 characters/,
		)
	})

	it("forwards task titles and projects liveness artifacts into bounded cards", async () => {
		let receivedOptions: any
		const { env, cards } = createRecordedCardEnvironment(async (_prompt, options) => {
			receivedOptions = options
			await options.onUpdate({ status: SubagentExecutionStatus.RUNNING, stats: EMPTY_STATS })
			await options.onUpdate({
				phase: "awaiting_first_provider_chunk",
				phaseStartedAt: 1_000,
				lastActivityAt: 2_000,
				isStalled: true,
				transcriptPath: "/tmp/task/subagents/run/transcript.md",
				diagnosticsPath: "/tmp/task/subagents/run/diagnostics.md",
			})
			return { status: SubagentExecutionStatus.COMPLETED, result: "done", stats: EMPTY_STATS }
		})

		await new UseSubagentsTool().processCall(
			{ subagents: [{ task_title: "Observe provider liveness", prompt: "Wait for provider output" }] },
			env,
		)

		const aggregateCard = cards.find((card) => card.params.header === "Run Subagents")
		const agentCard = cards.find((card) => card.params.header !== "Run Subagents")
		assert.equal(receivedOptions.taskTitle, "Observe provider liveness")
		assert.ok(aggregateCard?.updates.some((update) => /⚠ stalled: awaiting_first_provider_chunk/.test(update.body)))
		assert.ok(aggregateCard?.updates.some((update) => /transcript\.md/.test(update.body)))
		assert.ok(agentCard?.updates.some((update) => /\*\*Runtime:\*\* ⚠ stalled/.test(update.body)))
	})
})
