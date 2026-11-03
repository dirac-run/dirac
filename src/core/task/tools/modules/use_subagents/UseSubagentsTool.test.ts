import { strict as assert } from "node:assert"
import type { TaskletRecord } from "@core/storage/taskStorage"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment, TaskletControls } from "../../interfaces/IToolEnvironment"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { PRESENTATION_OPERATION_TIMEOUT_MS } from "../../subagent/PresentationDeadline"
import { UseSubagentsTool, use_subagents_spec } from "./UseSubagentsTool"

function record(id: string, title = "Inspect code", outcome?: TaskletRecord["outcome"]): TaskletRecord {
	return {
		id,
		title,
		prompt: "Inspect",
		rootTaskId: "root",
		conversationUlid: "conversation",
		createdAt: 1,
		...(outcome ? { outcome } : {}),
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(start: TaskletControls["start"] = async (input) => record("tasklet:accepted", input.title)) {
	const updates: any[] = []
	const finalized: CardStatus[] = []
	const warnings: unknown[][] = []
	const card = {
		id: "spawn-card",
		update: async (patch: any) => {
			updates.push(patch)
		},
		finalize: async (status: CardStatus) => {
			finalized.push(status)
		},
	}
	const createCard = sinon.stub().resolves(card)
	const legacyCall = () => {
		throw new Error("Legacy batch execution/accounting must not be used")
	}
	let mistakes = 0
	const env = {
		toolName: "use_subagents",
		orchestration: {
			tasklets: { start },
			runSubagent: legacyCall,
			getHistory: legacyCall,
			getTaskState: () => mistakes,
			setTaskState: (_key: string, value: number) => {
				mistakes = value
			},
		},
		ui: { createCard },
		telemetry: { captureCustomMetadata: legacyCall },
		logging: { warn: (...args: unknown[]) => warnings.push(args) },
	} as unknown as IToolEnvironment
	return { env, card, createCard, updates, finalized, warnings, mistakes: () => mistakes }
}

async function spawn(env: IToolEnvironment, subagents: unknown[]) {
	return JSON.parse(await new UseSubagentsTool().processCall({ subagents }, env)).subagents
}

const assignment = { task_title: "Inspect code", prompt: "Inspect" }

describe("UseSubagentsTool asynchronous tasklet startup", () => {
	let resolveName: sinon.SinonStub
	beforeEach(() => {
		resolveName = sinon.stub().returns(undefined)
		sinon
			.stub(AgentConfigLoader, "getInstance")
			.returns({ resolveSubagentNameForTool: resolveName } as unknown as AgentConfigLoader)
	})
	afterEach(() => sinon.restore())

	it("describes asynchronous acceptance, later communication and inspection/sleep", () => {
		assert.match(use_subagents_spec.description, /asynchronously/)
		assert.match(use_subagents_spec.description, /not completed results/)
		assert.match(use_subagents_spec.description, /later results and requests/)
		assert.match(use_subagents_spec.description, /tasklets to inspect/)
		assert.match(use_subagents_spec.description, /sleep/)
		assert.match(String(use_subagents_spec.parameters![0].instruction), /acceptance does not mean assignment completion/)
	})

	it("uses the environment capability guard even with no legacy config", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { tasklets?: TaskletControls }).tasklets
		await assert.rejects(new UseSubagentsTool().processCall({ subagents: [assignment] }, env), /owning ordinary root/)
		assert.equal(createCard.callCount, 0)
		assert.equal(resolveName.callCount, 0)
	})

	it("returns stable acceptance and finishes only its own card while child execution remains pending", async () => {
		const execution = deferred<void>()
		let childCompleted = false
		void execution.promise.then(() => {
			childCompleted = true
		})
		const start = sinon.stub().resolves(record("tasklet:live"))
		const { env, createCard, finalized, updates } = fixture(start)
		assert.deepEqual(await spawn(env, [assignment]), [
			{ index: 0, id: "tasklet:live", title: "Inspect code", accepted: true },
		])
		assert.equal(childCompleted, false)
		assert.equal(createCard.callCount, 1, "The spawn tool must not create child cards")
		assert.equal(createCard.firstCall.args[0].collapsed, true)
		assert.deepEqual(finalized, [CardStatus.SUCCESS])
		assert.match(updates[0].body, /Acceptance is not assignment completion/)
		assert.deepEqual(start.firstCall.args[0], {
			title: "Inspect code",
			prompt: "Inspect",
			agentName: undefined,
			timeoutSeconds: 600,
			includeHistory: false,
			useUtilityModel: false,
		})
		assert.equal(resolveName.firstCall.args[0], "use_subagents")
		execution.resolve()
	})

	it("starts assignments concurrently and keeps request order despite reversed acceptance", async () => {
		const first = deferred<TaskletRecord>()
		const secondStarted = deferred<void>()
		const start = sinon.stub()
		start.onFirstCall().returns(first.promise)
		start.onSecondCall().callsFake(async () => {
			secondStarted.resolve()
			return record("tasklet:second", "Second")
		})
		const { env } = fixture(start)
		const pending = spawn(env, [assignment, { task_title: "Second", prompt: "Second prompt" }])
		await secondStarted.promise
		assert.equal(start.callCount, 2)
		first.resolve(record("tasklet:first"))
		assert.deepEqual(
			(await pending).map((result: any) => [result.index, result.id]),
			[
				[0, "tasklet:first"],
				[1, "tasklet:second"],
			],
		)
	})

	it("resolves a named route and forwards profile, Utility, history and timeout choices", async () => {
		resolveName.returns("Code reviewer")
		const start = sinon.stub().resolves(record("tasklet:named", "Review code"))
		const { env } = fixture(start)
		Object.defineProperty(env, "toolName", { value: "code_reviewer" })
		const results = JSON.parse(
			await new UseSubagentsTool().processCall(
				{
					task_title: "  Review   code ",
					prompt: " Review this diff ",
					timeout: "42",
					include_history: "true",
					use_utility_model: true,
				},
				env,
			),
		).subagents
		assert.equal(resolveName.firstCall.args[0], "code_reviewer")
		assert.deepEqual(start.firstCall.args[0], {
			title: "Review code",
			prompt: "Review this diff",
			agentName: "Code reviewer",
			timeoutSeconds: 42,
			includeHistory: true,
			useUtilityModel: true,
		})
		assert.deepEqual(results, [{ index: 0, id: "tasklet:named", title: "Review code", accepted: true }])
	})

	it("maps explicit generic options and derives a bounded title when omitted", async () => {
		const start = sinon.stub().callsFake(async (input) => record("tasklet:generic", input.title))
		const { env } = fixture(start)
		const results = await spawn(env, [
			{ prompt: "x".repeat(100), timeout: 12, include_history: true, use_utility_model: "true" },
		])
		assert.equal(results[0].title.length, 80)
		assert.ok(results[0].title.endsWith("…"))
		assert.deepEqual(start.firstCall.args[0], {
			title: results[0].title,
			prompt: "x".repeat(100),
			agentName: undefined,
			timeoutSeconds: 12,
			includeHistory: true,
			useUtilityModel: true,
		})
	})

	for (const input of [undefined, {}, { subagents: [] }, { subagents: "invalid" }]) {
		it(`reports a missing batch without creating a card: ${JSON.stringify(input)}`, async () => {
			const { env, createCard, mistakes } = fixture()
			assert.match(await new UseSubagentsTool().processCall(input, env), /Missing required parameter: subagents/)
			assert.equal(mistakes(), 1)
			assert.equal(createCard.callCount, 0)
		})
	}

	it("preserves successful handles across malformed assignments, validation errors and host startup rejection", async () => {
		const start = sinon.stub().callsFake(async (input) => {
			if (input.prompt === "Bad model") throw new Error("Utility model is unavailable")
			return record(`tasklet:${input.prompt}`, input.title)
		})
		const { env, finalized, updates } = fixture(start)
		const results = await spawn(env, [
			null,
			assignment,
			{ prompt: "Bad model" },
			[],
			{ prompt: " " },
			{ prompt: "Bad title", task_title: "one two three four five six" },
			{ prompt: "Bad timeout", timeout: 0 },
			{ task_title: "Second", prompt: "Second" },
		])
		assert.equal(results.length, 8)
		assert.deepEqual(
			results.filter((result: any) => result.accepted).map((result: any) => result.id),
			["tasklet:Inspect", "tasklet:Second"],
		)
		assert.match(results[0].error, /assignment must be an object/)
		assert.match(results[2].error, /Utility model is unavailable/)
		assert.equal(results[2].title, "Bad model")
		assert.match(results[3].error, /assignment must be an object/)
		assert.match(results[4].error, /missing required parameter: prompt/)
		assert.match(results[5].error, /task_title/)
		assert.match(results[6].error, /timeout/)
		assert.equal(start.callCount, 3)
		assert.deepEqual(finalized, [CardStatus.ERROR])
		assert.match(updates[0].body, /2 accepted; 6 startup errors/)
	})

	for (const outcome of [
		{ kind: "failed", error: { name: "Error", message: "Construction failed" }, failedAt: 2 },
		{ kind: "interrupted", reason: "Root stopped", interruptedAt: 2 },
		{ kind: "cancelled", cancelledAt: 2 },
		{ kind: "completed", response: "Finished very quickly", completedAt: 2 },
	] as TaskletRecord["outcome"][]) {
		it(`preserves a known ID and ${outcome!.kind} outcome returned during startup`, async () => {
			const { env } = fixture(async () => record("tasklet:known", "Host title", outcome))
			const [result] = await spawn(env, [assignment])
			assert.equal(result.id, "tasklet:known")
			assert.equal(result.title, "Host title")
			assert.deepEqual(result.outcome, outcome)
			assert.equal(result.accepted, outcome!.kind === "completed")
			if (outcome!.kind !== "completed") assert.equal(typeof result.error, "string")
		})
	}

	it("returns named malformed input as a startup failure rather than crashing the batch path", async () => {
		resolveName.returns("Reviewer")
		const start = sinon.stub()
		const { env, finalized } = fixture(start)
		const result = JSON.parse(await new UseSubagentsTool().processCall(null, env)).subagents[0]
		assert.equal(result.accepted, false)
		assert.match(result.error, /assignment must be an object/)
		assert.equal(start.callCount, 0)
		assert.deepEqual(finalized, [CardStatus.ERROR])
	})

	for (const phase of ["create", "update", "finalize"] as const) {
		it(`does not hide acceptance when card ${phase} rejects`, async () => {
			const { env, card, createCard, finalized, warnings } = fixture()
			if (phase === "create") createCard.rejects(new Error("Card failed"))
			else sinon.stub(card, phase).rejects(new Error("Card failed"))
			const [result] = await spawn(env, [assignment])
			assert.equal(result.accepted, true)
			assert.equal(warnings.length, 1)
			if (phase === "update") assert.deepEqual(finalized, [CardStatus.SUCCESS])
		})
	}

	for (const phase of ["create", "update", "finalize"] as const) {
		it(`bounds stalled card ${phase} independently of child execution`, async () => {
			const clock = sinon.useFakeTimers()
			const { env, card, createCard, finalized, warnings } = fixture()
			const stalled = deferred<any>()
			if (phase === "create") createCard.returns(stalled.promise)
			else sinon.stub(card, phase).returns(stalled.promise)
			const pending = spawn(env, [assignment])
			await clock.tickAsync(PRESENTATION_OPERATION_TIMEOUT_MS + 1)
			const [result] = await pending
			assert.equal(result.id, "tasklet:accepted")
			assert.equal(result.accepted, true)
			assert.equal(warnings.length, 1)
			if (phase === "create") {
				stalled.resolve(card)
				await clock.tickAsync(0)
				assert.deepEqual(finalized, [CardStatus.ABANDONED])
			} else {
				stalled.resolve(undefined)
				await clock.tickAsync(0)
			}
		})
	}
})
