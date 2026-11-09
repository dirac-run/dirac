import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import type { TaskletReceipt } from "@shared/taskletReceipt"
import type { IToolEnvironment, TaskletControls } from "../../interfaces/IToolEnvironment"
import { normalizeOptionalToolParameters } from "../../runtime/normalizeOptionalToolParameters"
import { SubagentsTool, subagents_spec } from "../subagents/SubagentsTool"

function fixture(controls: Partial<TaskletControls> = {}) {
	const finalized: CardStatus[] = []
	const updates: Record<string, unknown>[] = []
	const environment = {
		orchestration: { tasklets: controls, agentIdentity: { id: "Dirac" } },
		ui: {
			createCard: async () => ({
				update: async (patch: Record<string, unknown>) => {
					updates.push(patch)
				},
				finalize: async (status: CardStatus) => {
					finalized.push(status)
				},
			}),
		},
	} as unknown as IToolEnvironment
	return { environment, finalized, updates }
}

describe("SubagentsTool input and result contracts", () => {
	it("documents passive bounded inspection, canonical messaging and acceptance rather than completion", () => {
		assert.match(subagents_spec.description, /passive|Passive/)
		assert.match(subagents_spec.description, /message/)
		assert.match(subagents_spec.description, /not completion/)
		assert.match(subagents_spec.description, /current parent authority/)
	})

	it("rejects environments without parent controls", async () => {
		await assert.rejects(
			new SubagentsTool().processCall({ operation: "list" }, { orchestration: {} } as IToolEnvironment),
			/owning root/,
		)
	})

	for (const input of [
		null,
		[],
		{ operation: "spawn" },
		{ operation: "inspect" },
		{ operation: "steer", tasklet_id: "a", message: "old transport" },
		{ operation: "resolve", tasklet_id: "a", request_id: "r", resolution: "approve" },
		{ operation: "transcript", tasklet_id: "a" },
		{ operation: "list", tasklet_id: "a" },
		{ operation: "list", view: "result" },
		{ operation: "inspect", tasklet_id: "a", message: "ignored" },
		{ operation: "inspect", tasklet_id: "a", view: "result" },
		{ operation: "inspect", tasklet_id: "a", call_id: "not-a-result-view" },
		{ operation: "inspect", tasklet_id: "a", limit: 51 },
		{ operation: "message", messages: [] },
		{ operation: "message", messages: [{ tasklet_id: "a", type: "reply", request_id: "r" }] },
		{ operation: "message", messages: [{ tasklet_id: "a", type: "guidance", text: "x", decision: "approve" }] },
		{ operation: "message", messages: [{ tasklet_id: "a", type: "permission_decision", request_id: "r", decision: "yes" }] },
		{ operation: "message", messages: ["approve", null] },
		{ operation: "message", messages: Array.from({ length: 21 }, () => ({ tasklet_id: "a", type: "question", text: "x" })) },
		{
			operation: "message",
			messages: ["approve", "reject"].map((decision) => ({
				tasklet_id: "a",
				type: "permission_decision",
				request_id: "r",
				decision,
			})),
		},
		{ operation: "sleep", timeout_ms: -1 },
		{ operation: "sleep", timeout_ms: 1.5 },
		{ operation: "sleep", timeout_ms: 2147483648 },
		{ operation: "sleep", tasklet_ids: [1] },
		{ operation: "sleep", tasklet_ids: [] },
		{ operation: "list", extra: true },
	]) {
		it(`rejects invalid input ${JSON.stringify(input)}`, async () => {
			const { environment, finalized } = fixture()
			await assert.rejects(new SubagentsTool().processCall(input, environment))
			assert.deepEqual(finalized, [])
		})
	}

	it("accepts strict-provider null placeholders only after schema-based normalization, including nested items", async () => {
		const input = {
			operation: "message",
			tasklet_id: null,
			view: null,
			cursor: null,
			limit: null,
			call_id: null,
			message_type: null,
			message: null,
			tasklet_ids: null,
			timeout_ms: null,
			messages: [
				{ tasklet_id: "child", type: "reply", request_id: "request", text: "Continue", action: null, decision: null },
			],
		}
		const { environment } = fixture({
			message: async (items) => {
				assert.deepEqual(items, [{ taskletId: "child", type: "reply", requestId: "request", text: "Continue" }])
				return [{ taskletId: "child", requestId: "request", status: "resolved" }]
			},
		})
		const output = await new SubagentsTool().processCall(normalizeOptionalToolParameters(input, subagents_spec), environment)
		assert.equal(JSON.parse(output)[0].status, "resolved")
	})

	it("passes exact view/call/cursor parameters without loading another view", async () => {
		const page = { title: "Review storage", items: [{ callId: "call", result: "exact result" }], totalItems: 1 }
		const { environment, updates } = fixture({
			inspect: async (id, query) => {
				assert.equal(id, "a")
				assert.deepEqual(query, { view: "result", callId: "call", cursor: "cursor", limit: 1 })
				return page
			},
		})
		assert.deepEqual(
			JSON.parse(
				await new SubagentsTool().processCall(
					{ operation: "inspect", tasklet_id: "a", view: "result", call_id: "call", cursor: "cursor", limit: 1 },
					environment,
				),
			),
			page,
		)
		assert.equal(updates[0].header, "Dirac inspected tool result of a — Review storage")
		assert.match(String(updates[0].body), /exact result/)
		assert.equal((updates[0].taskletReceipt as TaskletReceipt).outcome, "retrieved")
	})

	it("maps an addressed reply without inferring permission and presents actual partial failure", async () => {
		const { environment, finalized, updates } = fixture({
			message: async (items) => {
				assert.deepEqual(items, [
					{ taskletId: "a", type: "reply", requestId: "r", text: "Use option two", action: "choice-2" },
					{ taskletId: "b", type: "permission_decision", requestId: "s", decision: "approve" },
				])
				return [
					{ taskletId: "a", title: "Review storage", request: "Which format?", requestId: "r", status: "resolved" },
					{
						taskletId: "b",
						title: "Review lifecycle",
						request: "Run command",
						requestId: "s",
						status: "failed",
						error: "Authority changed",
					},
				]
			},
		})
		const result = JSON.parse(
			await new SubagentsTool().processCall(
				{
					operation: "message",
					messages: [
						{ tasklet_id: "a", type: "reply", request_id: "r", text: "Use option two", action: "choice-2" },
						{ tasklet_id: "b", type: "permission_decision", request_id: "s", decision: "approve" },
					],
				},
				environment,
			),
		)
		assert.deepEqual(
			result.map((item: { status: string }) => item.status),
			["resolved", "failed"],
		)
		assert.deepEqual(finalized, [CardStatus.SUCCESS, CardStatus.ERROR])
		const reply = updates[0].taskletReceipt as TaskletReceipt
		const permission = updates[1].taskletReceipt as TaskletReceipt
		assert.equal(reply.outcome, "resolved")
		assert.equal(permission.outcome, "failed")
		assert.equal(reply.rows[0].choice, "choice-2")
		assert.equal(permission.rows[0].decision, "approve")
		assert.equal(permission.rows[0].requestId, "s")
		assert.equal(updates[0].header, "Dirac replied to a — Review storage")
		assert.equal(updates[0].body, "Use option two\nchoice-2")
		assert.equal(updates[1].header, "Dirac failed to approve b's request")
		assert.match(String(updates[1].body), /This request only, within parent authority/)
		assert.match((updates[1].communication as { detail: string }).detail, /Authority changed/)
		assert.equal(updates[0].collapsed, false)
		assert.equal(updates[1].collapsed, false)
	})

	it("bounds the entire serialized message batch while retaining every addressed outcome", async () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			tasklet_id: `child-${index}`,
			type: "guidance",
			text: "Investigate",
		}))
		const { environment } = fixture({
			message: async (items) =>
				items.map((item) => ({
					taskletId: item.taskletId,
					status: "failed",
					title: '😀"\\'.repeat(8000),
					error: "x".repeat(8000),
				})),
		})
		const output = await new SubagentsTool().processCall({ operation: "message", messages }, environment)
		assert.ok(Buffer.byteLength(output) <= 16 * 1024)
		assert.equal(JSON.parse(output).length, 20)
	})

	it("distinguishes a retrieved pending-request view from a child's state", async () => {
		const { environment, finalized, updates } = fixture({
			inspect: async () => ({ taskletId: "child", title: "Audit protocol", view: "pending", items: [], totalItems: 0 }),
		})
		await new SubagentsTool().processCall({ operation: "inspect", tasklet_id: "child", view: "pending" }, environment)
		const receipt = updates[0].taskletReceipt as TaskletReceipt
		assert.equal(updates[0].header, "Dirac inspected pending requests of child — Audit protocol")
		assert.equal(receipt.outcome, "retrieved")
		assert.equal(receipt.returnedCount, 0)
		assert.equal(receipt.rows[0].observedState, undefined)
		assert.deepEqual(finalized, [CardStatus.SUCCESS])
	})

	it("does not infer running or completion from acceptance or a successful status read", async () => {
		const summaries = [
			{ title: "Accepted", outcomePersisted: false },
			{ title: "Starting", outcomePersisted: false, executionStatus: "preparing" },
			{ title: "Settling", outcomePersisted: false, outcome: { kind: "completed" } },
			{ title: "Waiting", outcomePersisted: false, pendingRequestCount: 1 },
			{ title: "Failed settlement", outcomePersisted: false, settlementError: { message: "write failed" } },
			{ title: "Done", outcomePersisted: true, outcome: { kind: "completed" } },
		]
		const { environment, updates } = fixture({
			list: () => ({ items: summaries, totalItems: summaries.length }) as ReturnType<TaskletControls["list"]>,
		})
		await new SubagentsTool().processCall({ operation: "list" }, environment)
		const receipt = updates[0].taskletReceipt as TaskletReceipt
		assert.equal(receipt.outcome, "retrieved")
		assert.deepEqual(
			receipt.rows.map((row) => row.observedState),
			[undefined, "starting", "settling", "waiting_for_parent", "settlement_failed", "completed"],
		)
	})

	it("keeps queued guidance and wake receipts distinct from completion", async () => {
		const { environment, updates } = fixture({
			message: async () => [{ taskletId: "child", title: "Audit", status: "queued" }],
			sleep: async () => ({ reason: "event", taskletId: "child", eventId: "event" }),
		})
		await new SubagentsTool().processCall(
			{ operation: "message", messages: [{ tasklet_id: "child", type: "guidance", text: "Check persistence first" }] },
			environment,
		)
		const guidance = updates[0].taskletReceipt as TaskletReceipt
		assert.equal(guidance.operation, "guidance")
		assert.equal(guidance.outcome, "queued")
		assert.equal(guidance.rows[0].message, "Check persistence first")
		assert.equal(updates[0].body, "Check persistence first")
		assert.equal(updates[0].header, "Dirac sent guidance to child — Audit")
		assert.match((updates[0].communication as { detail: string }).detail, /consumption is not confirmed/)
		await new SubagentsTool().processCall({ operation: "sleep" }, environment)
		const wake = updates[1].taskletReceipt as TaskletReceipt
		assert.equal(wake.outcome, "woke")
		assert.equal(wake.wakeReason, "event")
		assert.match(String(updates[1].body), /wake is not assignment completion/)
	})

	it("fails rather than returning an accidentally unbounded control result", async () => {
		const { environment, finalized } = fixture({ inspect: async () => ({ items: ["x".repeat(100000)], totalItems: 1 }) })
		await assert.rejects(
			new SubagentsTool().processCall({ operation: "inspect", tasklet_id: "a" }, environment),
			/aggregate bound/,
		)
		assert.deepEqual(finalized, [CardStatus.ERROR])
	})

	it("preserves host failures and finalizes the card", async () => {
		const { environment, finalized } = fixture({
			inspect: async () => {
				throw new Error("unknown handle")
			},
		})
		await assert.rejects(
			new SubagentsTool().processCall({ operation: "inspect", tasklet_id: "missing" }, environment),
			/unknown handle/,
		)
		assert.deepEqual(finalized, [CardStatus.ERROR])
	})
})
