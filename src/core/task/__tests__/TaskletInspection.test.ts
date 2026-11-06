import assert from "node:assert/strict"
import { ResponseOperation } from "@shared/responseTool"
import { describe, it } from "mocha"
import {
	inspectTasklet,
	MAX_TASKLET_INSPECTION_BYTES,
	pageInspectionItems,
	type TaskletInspectionSource,
} from "../TaskletInspection"
import type { TaskletEvent, TaskletInspection, TaskletInspectionQuery } from "../types/tasklet"
import type { DiracStorageMessage } from "@shared/messages/content"

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

async function collect(source: TaskletInspectionSource, query: TaskletInspectionQuery) {
	const items: unknown[] = []
	let json = ""
	let cursor: string | undefined
	let pages = 0
	do {
		const page = await inspectTasklet(source, { ...query, cursor })
		assert.ok(++pages < 100, "Pagination must advance")
		assert.ok(bytes(page) <= MAX_TASKLET_INSPECTION_BYTES)
		items.push(...page.items)
		if (page.fragment) {
			assert.equal(page.fragment.offset, json.length)
			json += page.fragment.json
			if (json.length === page.fragment.totalCharacters) {
				assert.equal(Buffer.byteLength(json), page.fragment.totalBytes)
				items.push(JSON.parse(json))
				json = ""
			}
		}
		cursor = page.nextCursor
	} while (cursor)
	assert.equal(json, "", "Final fragments must be complete")
	return items
}

function fixture(): TaskletInspectionSource {
	const conversation: DiracStorageMessage[] = [
		{ role: "user", content: "INHERITED_PARENT_SECRET" },
		{ role: "assistant", content: [{ type: "tool_use", id: "parent-call", name: "execute_command", input: {} }] },
		{ role: "user", content: "CHILD_ASSIGNMENT" },
		{
			role: "assistant",
			ts: 4,
			content: [
				{ type: "tool_use", id: "call-a", name: "read_file", input: { paths: ["source.ts"] } },
				{ type: "tool_use", id: "call-b", name: "search_files", input: { regex: "target" } },
				{ type: "tool_use", id: "call-c", name: "list_files", input: { paths: ["src"] } },
			],
		},
		{
			role: "user",
			ts: 5,
			content: [
				{ type: "tool_result", tool_use_id: "call-a", content: "EXACT_RESULT_A" },
				{ type: "tool_result", tool_use_id: "call-b", content: "EXACT_RESULT_B", is_error: true },
			],
		},
	]
	return {
		inspection: {
			id: "child",
			title: "Review",
			prompt: "Assignment",
			createdAt: 1,
			rootTaskId: "root",
			conversationUlid: "conversation",
			responses: [],
			interactions: [],
			outcomePersisted: false,
			backgroundCommandRunning: false,
		} satisfies TaskletInspection,
		events: [],
		inheritedMessageCount: 2,
		readConversation: async () => conversation,
	}
}

describe("bounded passive tasklet inspection", () => {
	it("bounds the aggregate inventory and preserves every item across cursors", () => {
		const items = Array.from({ length: 120 }, (_, id) => ({ id, title: "界😀".repeat(200) }))
		const recovered: unknown[] = []
		let cursor: string | undefined
		do {
			const page = pageInspectionItems(items, { limit: 50, cursor })
			assert.ok(bytes(page) <= MAX_TASKLET_INSPECTION_BYTES)
			assert.equal(page.totalItems, items.length)
			recovered.push(...page.items)
			cursor = page.nextCursor
		} while (cursor)
		assert.deepEqual(recovered, items)
	})

	it("reassembles exact oversized Unicode arguments, results, transcript and committed outcomes", async () => {
		const source = fixture()
		const evidence = '界😀\\\"\n'.repeat(20_000)
		const conversation = await source.readConversation()
		const assistant = conversation[3].content as any[]
		assistant[0].input = { evidence }
		const results = conversation[4].content as any[]
		results[0].content = evidence
		const outcome = { kind: "completed" as const, response: evidence, completedAt: 10 }
		source.inspection.outcome = outcome
		source.inspection.outcomePersisted = true
		source.events.push({ id: "outcome", taskletId: "child", createdAt: 10, communication: { type: "outcome", outcome } })
		assert.deepEqual(await collect(source, { view: "call", callId: "call-a" }), [
			{ callId: "call-a", name: "read_file", ts: 4, arguments: { evidence } },
		])
		assert.deepEqual(await collect(source, { view: "result", callId: "call-a" }), [
			{ callId: "call-a", ts: 5, result: results[0] },
		])
		assert.deepEqual(await collect(source, { view: "transcript" }), conversation.slice(2))
		const assignment = (await collect(source, { view: "assignment" }))[0] as any
		assert.deepEqual(assignment.outcome, outcome)
		assert.equal(assignment.evidence.outcomeEventId, "outcome")
	})

	it("rejects changed partial evidence and cross-child/view/call/filter cursors", () => {
		const query = { view: "result" as const, callId: "a", messageType: "progress" }
		const items = [{ text: "large".repeat(10_000) }]
		const page = pageInspectionItems(items, query, { taskletId: "child-a" })
		assert.ok(page.fragment)
		for (const changed of [
			{ ...query, view: "call" as const },
			{ ...query, callId: "b" },
			{ ...query, messageType: "outcome" },
		]) {
			assert.throws(
				() => pageInspectionItems(items, { ...changed, cursor: page.nextCursor }, { taskletId: "child-a" }),
				/cursor/,
			)
		}
		assert.throws(() => pageInspectionItems(items, { ...query, cursor: page.nextCursor }, { taskletId: "child-b" }), /cursor/)
		items[0].text += "changed"
		assert.throws(
			() => pageInspectionItems(items, { ...query, cursor: page.nextCursor }, { taskletId: "child-a" }),
			/changed/,
		)
	})

	it("excludes inherited calls and result text from trajectory, correlates selected evidence and pending calls", async () => {
		const source = fixture()
		const trajectory = await collect(source, { view: "trajectory", limit: 1 })
		assert.deepEqual(
			trajectory.map((call: any) => [call.callId, call.status]),
			[
				["call-a", "completed"],
				["call-b", "failed"],
				["call-c", "pending"],
			],
		)
		assert.doesNotMatch(JSON.stringify(trajectory), /EXACT_RESULT|INHERITED|parent-call/)
		assert.deepEqual(await collect(source, { view: "result", callId: "call-c" }), [{ callId: "call-c", status: "pending" }])
		await assert.rejects(inspectTasklet(source, { view: "result", callId: "parent-call" }), /Unknown/)
		await assert.rejects(inspectTasklet(source, { view: "call" }), /required/)
	})

	it("reads messages without a transcript read or receipt mutation and distinguishes host facts from replies", async () => {
		const source = fixture()
		const facts: TaskletEvent[] = [
			{ id: "accepted", taskletId: "child", createdAt: 1, communication: { type: "lifecycle", state: "accepted" } },
			{
				id: "question",
				taskletId: "child",
				createdAt: 2,
				communication: { type: "message", message: { taskletId: "child", type: "question", text: "Why?" } },
			},
			{
				id: "reply",
				taskletId: "child",
				createdAt: 3,
				communication: {
					type: "response",
					response: { operation: ResponseOperation.PROGRESS, text: "Because", reply_to: "question" },
				},
			},
		]
		source.events = facts
		source.readConversation = async () => {
			throw new Error("Messages must not load conversation or presentation")
		}
		const before = structuredClone(source.inspection)
		const messages = await collect(source, { view: "messages", limit: 1 })
		assert.deepEqual(
			messages.map((message: any) => [message.type, message.direction]),
			[
				["accepted", "host_to_parent"],
				["question", "parent_to_child"],
				["reply", "child_to_parent"],
			],
		)
		assert.equal((await collect(source, { view: "messages", messageType: "reply" })).length, 1)
		assert.deepEqual(source.events, facts)
		assert.ok(facts.every((event) => event.deliveredAt === undefined))
		assert.deepEqual(source.inspection, before)
	})

	it("keeps status compact and omits uncommitted terminal results", async () => {
		const source = fixture()
		source.inspection.prompt = "PRIVATE_ASSIGNMENT".repeat(10_000)
		source.inspection.responses = [{ operation: ResponseOperation.PROGRESS, text: "progress".repeat(10_000) }]
		source.inspection.outcome = { kind: "completed", response: "UNCOMMITTED", completedAt: 1 }
		const page = await inspectTasklet(source)
		assert.ok(bytes(page) < 2000)
		assert.doesNotMatch(JSON.stringify(page), /PRIVATE_ASSIGNMENT|UNCOMMITTED|interactions|responses/)
	})
})
