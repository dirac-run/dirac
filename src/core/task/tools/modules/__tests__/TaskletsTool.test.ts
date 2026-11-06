import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import type { IToolEnvironment, TaskletControls } from "../../interfaces/IToolEnvironment"
import { normalizeOptionalToolParameters } from "../../runtime/normalizeOptionalToolParameters"
import { TaskletsTool, tasklets_spec } from "../use_subagents/UseSubagentsTool"

function fixture(controls: Partial<TaskletControls> = {}) {
	const finalized: CardStatus[] = []
	const updates: Record<string, unknown>[] = []
	const environment = {
		orchestration: { tasklets: controls },
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

describe("TaskletsTool input and result contracts", () => {
	it("documents passive bounded inspection, canonical messaging and acceptance rather than completion", () => {
		assert.match(tasklets_spec.description, /passive|Passive/)
		assert.match(tasklets_spec.description, /message/)
		assert.match(tasklets_spec.description, /acceptance, not completion/)
		assert.match(tasklets_spec.description, /current parent authority/)
	})

	it("rejects environments without parent controls", async () => {
		await assert.rejects(
			new TaskletsTool().processCall({ operation: "list" }, { orchestration: {} } as IToolEnvironment),
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
		{ operation: "message", messages: [{ tasklet_id: "a", type: "reply", reply_to: "r" }] },
		{ operation: "message", messages: [{ tasklet_id: "a", type: "guidance", text: "x", decision: "approve" }] },
		{ operation: "message", messages: [{ tasklet_id: "a", type: "permission_decision", reply_to: "r", decision: "yes" }] },
		{ operation: "message", messages: ["approve", null] },
		{ operation: "message", messages: Array.from({ length: 21 }, () => ({ tasklet_id: "a", type: "question", text: "x" })) },
		{
			operation: "message",
			messages: ["approve", "reject"].map((decision) => ({
				tasklet_id: "a",
				type: "permission_decision",
				reply_to: "r",
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
			await assert.rejects(new TaskletsTool().processCall(input, environment))
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
				{ tasklet_id: "child", type: "reply", reply_to: "request", text: "Continue", action: null, decision: null },
			],
		}
		const { environment } = fixture({
			message: async (items) => {
				assert.deepEqual(items, [{ taskletId: "child", type: "reply", replyTo: "request", text: "Continue" }])
				return [{ taskletId: "child", replyTo: "request", status: "resolved" }]
			},
		})
		const output = await new TaskletsTool().processCall(normalizeOptionalToolParameters(input, tasklets_spec), environment)
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
				await new TaskletsTool().processCall(
					{ operation: "inspect", tasklet_id: "a", view: "result", call_id: "call", cursor: "cursor", limit: 1 },
					environment,
				),
			),
			page,
		)
		assert.match(String(updates[0].header), /Review storage.*result/)
	})

	it("maps an addressed reply without inferring permission and presents actual partial failure", async () => {
		const { environment, finalized, updates } = fixture({
			message: async (items) => {
				assert.deepEqual(items, [
					{ taskletId: "a", type: "reply", replyTo: "r", text: "Use option two", action: "choice-2" },
					{ taskletId: "b", type: "permission_decision", replyTo: "s", decision: "approve" },
				])
				return [
					{ taskletId: "a", title: "Review storage", request: "Which format?", replyTo: "r", status: "resolved" },
					{
						taskletId: "b",
						title: "Review lifecycle",
						request: "Run command",
						replyTo: "s",
						status: "failed",
						error: "Authority changed",
					},
				]
			},
		})
		const result = JSON.parse(
			await new TaskletsTool().processCall(
				{
					operation: "message",
					messages: [
						{ tasklet_id: "a", type: "reply", reply_to: "r", text: "Use option two", action: "choice-2" },
						{ tasklet_id: "b", type: "permission_decision", reply_to: "s", decision: "approve" },
					],
				},
				environment,
			),
		)
		assert.deepEqual(
			result.map((item: { status: string }) => item.status),
			["resolved", "failed"],
		)
		assert.deepEqual(finalized, [CardStatus.ERROR])
		assert.match(String(updates[0].header), /partial failure/)
		assert.match(String(updates[0].body), /Use option two/)
		assert.match(String(updates[0].body), /Authority changed/)
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
		const output = await new TaskletsTool().processCall({ operation: "message", messages }, environment)
		assert.ok(Buffer.byteLength(output) <= 16 * 1024)
		assert.equal(JSON.parse(output).length, 20)
	})

	it("fails rather than returning an accidentally unbounded control result", async () => {
		const { environment, finalized } = fixture({ inspect: async () => ({ items: ["x".repeat(100000)], totalItems: 1 }) })
		await assert.rejects(
			new TaskletsTool().processCall({ operation: "inspect", tasklet_id: "a" }, environment),
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
			new TaskletsTool().processCall({ operation: "inspect", tasklet_id: "missing" }, environment),
			/unknown handle/,
		)
		assert.deepEqual(finalized, [CardStatus.ERROR])
	})
})
