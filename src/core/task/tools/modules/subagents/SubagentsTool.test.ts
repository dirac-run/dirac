import { strict as assert } from "node:assert"
import type { TaskletRecord } from "@core/storage/taskStorage"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment, TaskletControls } from "../../interfaces/IToolEnvironment"
import { PRESENTATION_OPERATION_TIMEOUT_MS } from "../../subagent/PresentationDeadline"
import { SubagentsTool, subagents_spec } from "./SubagentsTool"

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
	const unexpectedBatchAccounting = () => {
		throw new Error("The spawn tool must not perform batch execution accounting")
	}
	let mistakes = 0
	const env = {
		toolName: "subagents",
		config: { subagentsEnabled: true },
		orchestration: {
			reportFailure: sinon.stub(),
			agentIdentity: { id: "Dirac" },
			tasklets: { start },
			getHistory: unexpectedBatchAccounting,
			getTaskState: () => mistakes,
			setTaskState: (_key: string, value: number) => {
				mistakes = value
			},
		},
		ui: { createCard },
		telemetry: { captureCustomMetadata: unexpectedBatchAccounting },
		logging: { warn: (...args: unknown[]) => warnings.push(args) },
	} as unknown as IToolEnvironment
	assert.equal("runSubagent" in env.orchestration, false)
	return { env, card, createCard, updates, finalized, warnings, mistakes: () => mistakes }
}

async function spawn(env: IToolEnvironment, subagents: unknown[]) {
	return JSON.parse(await new SubagentsTool().processCall({ operation: "create", assignments: subagents }, env)).subagents
}

const assignment = { type: "default", task_header: "Inspect code", task_description: "Inspect" }

describe("SubagentsTool asynchronous tasklet startup", () => {
	afterEach(() => sinon.restore())

	it("caps assignment batches at 16 in schema and before creating cards or starting children", async () => {
		assert.equal(subagents_spec.parameters!.find((parameter) => parameter.name === "assignments")!.maxItems, 16)
		const start = sinon.stub().resolves(record("Planck"))
		const { env, createCard } = fixture(start)
		await assert.rejects(
			spawn(
				env,
				Array.from({ length: 17 }, () => assignment),
			),
			/no more than 16/,
		)
		sinon.assert.notCalled(start)
		sinon.assert.notCalled(createCard)
		assert.equal(
			(
				await spawn(
					env,
					Array.from({ length: 16 }, () => assignment),
				)
			).length,
			16,
		)
		assert.equal(start.callCount, 16)
	})

	it("requires every assignment field and rejects all retired options without starting children", async () => {
		const start = sinon.stub()
		const { env } = fixture(start)
		const invalid = [
			...Object.keys(assignment).map((key) =>
				Object.fromEntries(Object.entries(assignment).filter(([field]) => field !== key)),
			),
			...["timeout", "include_history", "use_utility_model", "prompt", "task_title", "unknown"].map((key) => ({
				...assignment,
				[key]: true,
			})),
		]
		const results = await spawn(env, invalid)
		assert.equal(results.length, invalid.length)
		assert.ok(results.every((result: { accepted: boolean }) => !result.accepted))
		sinon.assert.notCalled(start)
		await assert.rejects(new SubagentsTool().processCall({ operation: "create", subagents: [assignment] }, env), /not valid/)
		await assert.rejects(new SubagentsTool().processCall({ assignments: [assignment] }, env), /Unknown tasklet operation/)
	})

	it("forwards a selected role and complete trimmed instructions through the environment only", async () => {
		const start = sinon.stub().resolves(record("Planck", "Review code"))
		const { env } = fixture(start)
		await spawn(env, [{ type: "Reviewer", task_header: " Review   code ", task_description: " Review this diff " }])
		sinon.assert.calledOnceWithExactly(start, { type: "Reviewer", title: "Review code", prompt: "Review this diff" })
	})

	it("keeps the accepted saved role in spawn results and receipt labels", async () => {
		const { env, updates } = fixture(async () => ({ ...record("Feynman", "Review code"), role: "Reviewer" }))
		const [result] = await spawn(env, [{ type: "Reviewer", task_header: "Review code", task_description: "Review" }])
		assert.equal(result.role, "Reviewer")
		assert.equal(updates[0].taskletReceipt.rows[0].role, "Reviewer")
		assert.equal(updates[0].header, "Dirac → Feynman · Start agents")
		assert.match(updates[0].body, /Feynman \(Reviewer\) — Review code/)
	})

	it("describes asynchronous acceptance, later communication and inspection/sleep", () => {
		assert.match(subagents_spec.description, /asynchronously/)
		assert.match(subagents_spec.description, /not completed results/)
		assert.match(
			String(subagents_spec.parameters!.find((parameter) => parameter.name === "assignments")!.instruction),
			/Acceptance is not completion/,
		)
	})

	it("uses the environment capability guard even with no legacy config", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { tasklets?: TaskletControls }).tasklets
		await assert.rejects(
			new SubagentsTool().processCall({ operation: "create", assignments: [assignment] }, env),
			/owning root/,
		)
		assert.equal(createCard.callCount, 0)
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
		assert.equal(createCard.firstCall.args[0].communication.actor, "Dirac")
		assert.equal(updates[0].header, "Dirac → tasklet:live · Start agents")
		assert.deepEqual(finalized, [CardStatus.SUCCESS])
		assert.equal(updates[0].communication.detail, "Accepted")
		assert.equal(updates[0].body, "Inspect\n\ntasklet:live — Inspect code")
		assert.equal(updates[0].taskletReceipt.operation, "spawn")
		assert.equal(updates[0].taskletReceipt.outcome, "accepted")
		assert.deepEqual(
			updates[0].taskletReceipt.rows.map((row: { title: string; outcome: string }) => [row.title, row.outcome]),
			[["Inspect code", "accepted"]],
		)
		assert.deepEqual(start.firstCall.args[0], {
			title: "Inspect code",
			prompt: "Inspect",
			type: "default",
		})
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
		const pending = spawn(env, [assignment, { ...assignment, task_header: "Second", task_description: "Second prompt" }])
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

	for (const input of [
		{ operation: "create" },
		{ operation: "create", assignments: [] },
		{ operation: "create", assignments: "invalid" },
	]) {
		it(`reports a missing batch without creating a card: ${JSON.stringify(input)}`, async () => {
			const { env, createCard, mistakes } = fixture()
			assert.match(await new SubagentsTool().processCall(input, env), /assignments must be a non-empty array/)
			assert.equal(mistakes(), 1)
			assert.equal(createCard.callCount, 0)
		})
	}

	it("preserves successful handles across malformed assignments, validation errors and host startup rejection", async () => {
		const start = sinon.stub().callsFake(async (input) => {
			if (input.prompt === "Bad model") throw new Error("Role model is unavailable")
			return record(`tasklet:${input.prompt}`, input.title)
		})
		const { env, finalized, updates } = fixture(start)
		const results = await spawn(env, [
			null,
			assignment,
			{ ...assignment, task_header: "Bad model", task_description: "Bad model" },
			[],
			{ ...assignment, task_description: " " },
			{ ...assignment, task_header: "one two three four five six" },
			{ ...assignment, timeout: 0 },
			{ ...assignment, task_header: "Second", task_description: "Second" },
		])
		assert.equal(results.length, 8)
		assert.deepEqual(
			results.filter((result: any) => result.accepted).map((result: any) => result.id),
			["tasklet:Inspect", "tasklet:Second"],
		)
		assert.match(results[0].error, /assignment must be an object/)
		assert.match(results[2].error, /Role model is unavailable/)
		assert.equal(results[2].title, "Bad model")
		assert.match(results[3].error, /assignment must be an object/)
		assert.match(results[4].error, /task_description/)
		assert.match(results[5].error, /task_header/)
		assert.match(results[6].error, /timeout/)
		assert.equal(start.callCount, 3)
		assert.deepEqual(finalized, [CardStatus.ERROR])
		assert.equal(updates[0].taskletReceipt.outcome, "partial_failure")
		sinon.assert.notCalled(env.orchestration.reportFailure as sinon.SinonStub)
		assert.equal(updates[0].taskletReceipt.rows.filter((row: { outcome: string }) => row.outcome === "accepted").length, 2)
		assert.equal(updates[0].taskletReceipt.rows.filter((row: { outcome: string }) => row.outcome === "failed").length, 6)
		assert.match(updates[0].body, /Operation failed/)
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
			assert.equal((env.orchestration.reportFailure as sinon.SinonStub).callCount, outcome?.kind === "failed" ? 1 : 0)
			assert.equal(result.id, "tasklet:known")
			assert.equal(result.title, "Host title")
			assert.deepEqual(result.outcome, outcome)
			assert.equal(result.accepted, outcome!.kind === "completed")
			if (outcome!.kind !== "completed") assert.equal(typeof result.error, "string")
		})
	}

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
