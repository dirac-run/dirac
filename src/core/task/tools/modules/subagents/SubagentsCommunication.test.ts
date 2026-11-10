import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import type { TaskletReceipt } from "@shared/taskletReceipt"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment, TaskletControls, TaskletMessage } from "../../interfaces/IToolEnvironment"
import { PRESENTATION_OPERATION_TIMEOUT_MS } from "../../subagent/PresentationDeadline"
import { SubagentsTool } from "./SubagentsTool"

type CommunicationCard = {
	header: string
	body: string
	collapsed: boolean
	communication: { actor: string; detail: string }
	taskletReceipt: TaskletReceipt
	status: CardStatus
}

function fixture(controls: Partial<TaskletControls>, actor = "Dirac") {
	const cards: { initial: CommunicationCard; updates: CommunicationCard[]; finalized: CardStatus[] }[] = []
	const handles: { update: sinon.SinonStub; finalize: sinon.SinonStub }[] = []
	const createCard = sinon.stub().callsFake(async (initial: CommunicationCard) => {
		const card = { initial, updates: [] as CommunicationCard[], finalized: [] as CardStatus[] }
		cards.push(card)
		const handle = {
			update: sinon.stub().callsFake(async (patch: CommunicationCard) => {
				card.updates.push(patch)
			}),
			finalize: sinon.stub().callsFake(async (status: CardStatus) => {
				card.finalized.push(status)
			}),
		}
		handles.push(handle)
		return handle
	})
	const warn = sinon.stub()
	const env = {
		orchestration: { reportFailure: sinon.stub(), tasklets: controls, agentIdentity: { id: actor } },
		ui: { createCard },
		logging: { warn },
	} as unknown as IToolEnvironment
	return { env, cards, handles, createCard, warn }
}

async function message(env: IToolEnvironment, messages: unknown[]) {
	return JSON.parse(await new SubagentsTool().processCall({ operation: "message", messages }, env))
}

describe("Subagent supervision communication cards", () => {
	afterEach(() => sinon.restore())

	for (const statuses of [["failed"], ["stale", "failed"], ["queued", "failed"], ["resolved"], ["requires_user_approval"]] as const) {
		it(`marks only total operational message failures: ${statuses.join(",")}`, async () => {
			const { env } = fixture({ message: async () => statuses.map((status, index) => ({ taskletId: `agent-${index}`, status })) })
			await message(env, statuses.map((_, index) => ({ tasklet_id: `agent-${index}`, type: "guidance", text: "Check" })))
			assert.equal((env.orchestration.reportFailure as sinon.SinonStub).callCount,
				statuses.every((status) => status === "failed" || status === "stale") ? 1 : 0)
		})
	}

	const cases = [
		...[
			{ type: "guidance", text: "Keep the source hash" },
			{ type: "reply", request_id: "question-1", text: "Keep the source hash" },
			{ type: "permission_decision", request_id: "permission-1", decision: "approve" },
		].map((item) => {
			const status = item.type === "guidance" ? "queued" : "resolved"
			const result = [{ taskletId: "Planck", status, ...(item.request_id ? { requestId: item.request_id } : {}) }]
			return {
				name: item.type,
				operation: "message",
				input: { operation: "message", messages: [{ tasklet_id: "Planck", ...item }] },
				hostResult: result,
				expected: result,
			}
		}),
		{
			name: "interrupt",
			operation: "interrupt",
			input: { operation: "interrupt", tasklet_id: "Planck" },
			hostResult: { id: "Planck", title: "Review code", outcomePersisted: true, outcome: { kind: "interrupted" } },
			expected: { id: "Planck", title: "Review code", outcomePersisted: true, outcome: { kind: "interrupted" } },
		},
		{
			name: "resume",
			operation: "resume",
			input: { operation: "resume", tasklet_id: "Planck", message: "Follow up" },
			hostResult: { id: "Planck", title: "Review code" },
			expected: { id: "Planck", title: "Review code", accepted: true },
		},
	]
	for (const scenario of cases) {
		for (const phase of ["create", "update", "finalize"] as const) {
			it(`preserves ${scenario.name} results when card ${phase} rejects`, async () => {
				const action = sinon.stub().resolves(scenario.hostResult)
				const { env, createCard, warn } = fixture({ [scenario.operation]: action })
				const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
				createCard.resolves(card)
				const presentation = phase === "create" ? createCard : card[phase]
				const error = new Error("Display failed")
				presentation.rejects(error)
				const output = await new SubagentsTool().processCall(scenario.input, env)
				assert.deepEqual(JSON.parse(output), scenario.expected)
				sinon.assert.calledOnce(action)
				sinon.assert.calledOnce(warn)
				assert.equal(warn.firstCall.args[1], error)
				if (phase !== "create") {
					sinon.assert.calledOnce(card.update)
					sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
				}
			})

			for (const lateOutcome of ["resolve", "reject"] as const) {
				it(`bounds stalled card ${phase} with late ${lateOutcome} without losing ${scenario.name} results`, async () => {
					const clock = sinon.useFakeTimers()
					const action = sinon.stub().resolves(scenario.hostResult)
					const { env, createCard, warn } = fixture({ [scenario.operation]: action })
					const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
					createCard.resolves(card)
					let settle!: (value: any) => void
					let reject!: (reason: Error) => void
					const stalled = new Promise<any>((resolve, fail) => {
						settle = resolve
						reject = fail
					})
					const presentation = phase === "create" ? createCard : card[phase]
					presentation.returns(stalled)
					const pending = new SubagentsTool().processCall(scenario.input, env)
					await clock.tickAsync(PRESENTATION_OPERATION_TIMEOUT_MS + 1)
					assert.deepEqual(JSON.parse(await pending), scenario.expected)
					sinon.assert.calledOnce(action)
					sinon.assert.calledOnce(warn)
					const lateError = new Error("Late display failure")
					if (lateOutcome === "reject") reject(lateError)
					else settle(phase === "create" ? card : undefined)
					await clock.tickAsync(0)
					if (phase === "create" && lateOutcome === "resolve")
						sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ABANDONED)
					if (phase === "create" && lateOutcome === "reject")
						assert.equal(warn.lastCall.args[1], lateError)
				})
			}

			it(`preserves the ${scenario.name} operation error when card ${phase} rejects`, async () => {
				const error = new Error("Host operation failed")
				const action = sinon.stub().rejects(error)
				const { env, createCard, warn } = fixture({ [scenario.operation]: action })
				const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
				createCard.resolves(card)
				const presentation = phase === "create" ? createCard : card[phase]
				presentation.rejects(new Error("Display failed"))
				await assert.rejects(new SubagentsTool().processCall(scenario.input, env), (caught) => caught === error)
				sinon.assert.calledOnce(action)
				sinon.assert.calledOnce(warn)
			})
		}
	}

	it("keeps every batch receipt and finishes other cards after one card update fails", async () => {
		const result = [
			{ taskletId: "Planck", status: "queued" as const, messageId: "mail-1" },
			{ taskletId: "Curie", status: "queued" as const, messageId: "mail-2" },
		]
		const { env, handles, cards, warn } = fixture({
			message: async () => {
				handles[0].update.rejects(new Error("Display failed"))
				return result
			},
		})
		assert.deepEqual(
			await message(env, [
				{ tasklet_id: "Planck", type: "guidance", text: "First" },
				{ tasklet_id: "Curie", type: "guidance", text: "Second" },
			]),
			result,
		)
		assert.deepEqual(
			cards.map((card) => card.finalized),
			[[CardStatus.SUCCESS], [CardStatus.SUCCESS]],
		)
		assert.equal(cards[1].updates[0].taskletReceipt.outcome, "queued")
		sinon.assert.calledOnce(warn)
	})

	it("retains exact guidance and identifies each item before and after host admission", async () => {
		const guidance = "  Keep the original spacing.\n\nCheck café ☕ first.\n"
		let calls = 0
		const { env, cards } = fixture({
			message: async (items) => {
				calls++
				assert.deepEqual(items, [
					{ taskletId: "Planck", type: "guidance", text: guidance },
					{ taskletId: "Curie", type: "guidance", text: "Inspect renderer" },
				])
				assert.equal(cards.length, 2)
				return [
					{ taskletId: "Planck", status: "queued", messageId: "mail-one", title: "Review" },
					{ taskletId: "Curie", status: "failed", error: "Recipient settled" },
				]
			},
		})
		const output = await message(env, [
			{ tasklet_id: "Planck", type: "guidance", text: guidance },
			{ tasklet_id: "Curie", type: "guidance", text: "Inspect renderer" },
		])
		assert.equal(calls, 1)
		assert.deepEqual(
			output.map((item: { status: string }) => item.status),
			["queued", "failed"],
		)
		assert.equal(output[0].messageId, "mail-one")
		for (const [index, child] of ["Planck", "Curie"].entries()) {
			for (const card of [cards[index].initial, ...cards[index].updates]) {
				assert.equal(card.header, `Dirac → ${child} · Guidance`)
				assert.doesNotMatch(card.header, /Message agents/)
				assert.equal(card.communication.actor, "Dirac")
				assert.equal(card.collapsed, true)
			}
		}
		assert.ok(cards[0].initial.body.startsWith(guidance))
		assert.ok(cards[0].updates[0].body.startsWith(guidance))
		assert.equal(cards[0].updates[0].communication.detail, "Queued")
		assert.equal(cards[0].updates[0].body, guidance)
		assert.ok(cards[1].updates[0].body.startsWith("Inspect renderer"))
		assert.match(cards[1].updates[0].body, /Operation failed/)
		assert.doesNotMatch(cards[1].updates[0].communication.detail, /Recipient settled/)
		assert.deepEqual(
			cards.map((card) => card.finalized),
			[[CardStatus.SUCCESS], [CardStatus.ERROR]],
		)
	})

	it("preserves exact reply text and choice without interpreting prose as permission", async () => {
		let received: TaskletMessage[] = []
		const { env, cards } = fixture(
			{
				message: async (items) => {
					received = items
					return items.map((item) => ({ taskletId: item.taskletId, status: "resolved" }))
				},
			},
			"Supervisor",
		)
		await message(env, [
			{ tasklet_id: "Bohr", type: "reply", request_id: "question-1", text: "  approve is just prose\n" },
			{ tasklet_id: "Bohr", type: "reply", request_id: "question-2", action: "Use exact choice ✓" },
		])
		assert.ok(received.every((item) => item.type === "reply"))
		assert.ok(cards[0].updates[0].body.startsWith("  approve is just prose\n"))
		assert.ok(cards[1].updates[0].body.startsWith("Choice: Use exact choice ✓"))
		assert.equal(cards[0].updates[0].header, "Supervisor → Bohr · Answer")
		assert.equal(cards[1].updates[0].header, "Supervisor → Bohr · Answer")
		assert.doesNotMatch(cards[0].updates[0].communication.detail, /question-1/)
		assert.doesNotMatch(cards[1].updates[0].communication.detail, /question-2/)
		assert.equal(cards[0].updates[0].taskletReceipt.rows[0].decision, undefined)
	})

	for (const decision of ["approve", "reject", "escalate"] as const) {
		it(`shows an explicit scoped ${decision} decision and actual user-approval outcome`, async () => {
			const { env, cards } = fixture({
				message: async (items) => {
					assert.deepEqual(items, [
						{ taskletId: "Planck", type: "permission_decision", requestId: "permission-1", decision },
					])
					return [{ taskletId: "Planck", requestId: "permission-1", status: "requires_user_approval" }]
				},
			})
			const result = await message(env, [
				{ tasklet_id: "Planck", type: "permission_decision", request_id: "permission-1", decision },
			])
			const card = cards[0].updates[0]
			assert.equal(card.header, "Dirac → Planck · Permission decision")
			assert.doesNotMatch(card.header, /permission-1|approved/)
			assert.doesNotMatch(card.communication.detail, /permission-1/)
			assert.match(card.body, new RegExp(`Requested decision: ${decision}`))
			assert.doesNotMatch(card.body, /permission-1/)
			assert.match(card.body, /User approval required; permission not granted\./)
			assert.match(card.communication.detail, /User approval needed/)
			assert.equal(card.taskletReceipt.rows[0].requestId, "permission-1")
			assert.equal(card.taskletReceipt.outcome, result[0].status)
			assert.deepEqual(cards[0].finalized, [CardStatus.SUCCESS])
		})
	}

	it("retains already-resolved and stale outcomes on their own request cards", async () => {
		const { env, cards } = fixture({
			message: async () => [
				{ taskletId: "Planck", status: "already_resolved" },
				{ taskletId: "Curie", status: "stale", error: "Request no longer pending" },
			],
		})
		const output = await message(env, [
			{ tasklet_id: "Planck", type: "reply", request_id: "r1", text: "Continue" },
			{ tasklet_id: "Curie", type: "permission_decision", request_id: "r2", decision: "reject" },
		])
		assert.deepEqual(
			output.map((item: { status: string }) => item.status),
			["already_resolved", "stale"],
		)
		assert.equal(cards[0].updates[0].taskletReceipt.outcome, "already_resolved")
		assert.equal(cards[1].updates[0].taskletReceipt.outcome, "stale")
		assert.deepEqual(
			cards.map((card) => card.finalized),
			[[CardStatus.SUCCESS], [CardStatus.ERROR]],
		)
	})

	it("keeps exact content and child identities when a message batch fails", async () => {
		const failure = new Error("Planck and Curie admission failed")
		const { env, cards } = fixture({
			message: async () => {
				throw failure
			},
		})
		await assert.rejects(
			message(env, [
				{ tasklet_id: "Planck", type: "guidance", text: "First\n" },
				{ tasklet_id: "Curie", type: "reply", request_id: "r", action: "Second" },
			]),
			(error) => error === failure,
		)
		assert.ok(cards[0].updates[0].body.startsWith("First\n"))
		assert.ok(cards[1].updates[0].body.startsWith("Choice: Second"))
		assert.match(cards[0].updates[0].body, /Operation failed/)
		assert.doesNotMatch(cards[0].updates[0].communication.detail, /Planck and Curie admission failed/)
		assert.deepEqual(
			cards.map((card) => card.finalized),
			[[CardStatus.ERROR], [CardStatus.ERROR]],
		)
	})

	it("lists a readable stable-ID roster while leaving the JSON page unchanged", async () => {
		const page = {
			items: [
				{ id: "Planck", title: "Review code", role: "Reviewer", executionStatus: "thinking", pendingRequestCount: 0 },
				{ id: "Curie", title: "Inspect UI", pendingRequestCount: 1 },
			],
			totalItems: 3,
			nextCursor: "next",
		}
		const { env, cards } = fixture({ list: () => page as ReturnType<TaskletControls["list"]> })
		const output = await new SubagentsTool().processCall({ operation: "list" }, env)
		assert.deepEqual(JSON.parse(output), page)
		assert.equal(cards[0].updates[0].header, "Dirac · Agents")
		assert.match(cards[0].updates[0].body, /Planck \(Reviewer\) — Review code — Running/)
		assert.match(cards[0].updates[0].body, /Curie — Inspect UI — Waiting for parent/)
		assert.match(cards[0].updates[0].body, /2 of 3 items · more available/)
		assert.doesNotMatch(cards[0].updates[0].body, /passive read/)
		assert.doesNotMatch(cards[0].updates[0].body, /"items"|"executionStatus"/)
	})

	it("keeps opaque inspection evidence in tool output, not the human card", async () => {
		const page = {
			view: "messages" as const, taskletId: "Planck", title: "Review code",
			items: [{ id: "opaque-event-id", requestId: "opaque-request-id", text: "Evidence" }], totalItems: 1,
		}
		const { env, cards } = fixture({ inspect: async () => page as Awaited<ReturnType<TaskletControls["inspect"]>> })
		const output = await new SubagentsTool().processCall({ operation: "inspect", tasklet_id: "Planck", view: "messages" }, env)
		assert.deepEqual(JSON.parse(output), page)
		const value = cards[0].updates[0]
		assert.equal(value.header, "Dirac → Planck · Inspect messages")
		assert.match(value.body, /Review code/)
		assert.match(value.body, /1 of 1 items/)
		assert.doesNotMatch([value.header, value.body, value.communication.detail].join("\n"), /opaque-event-id|opaque-request-id/)
	})

	it("shows selected sleep sources without treating a wake as completion", async () => {
		const { env, cards } = fixture({
			sleep: async (options) => {
				assert.deepEqual(options, { taskletIds: ["Planck", "Curie"], timeoutMs: 1000 })
				return { reason: "mail", from: "Bohr", messageId: "m" }
			},
		})
		const output = await new SubagentsTool().processCall(
			{ operation: "sleep", tasklet_ids: ["Planck", "Curie"], timeout_ms: 1000 },
			env,
		)
		assert.deepEqual(JSON.parse(output), { reason: "mail", from: "Bohr", messageId: "m" })
		assert.equal(cards[0].updates[0].header, "Dirac · Wait ended")
		assert.equal(cards[0].updates[0].body, "Agent message received.\n\nAgents: Planck, Curie")
		assert.equal(cards[0].updates[0].communication.detail, "Awake")
	})
})
