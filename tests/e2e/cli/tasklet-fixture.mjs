import assert from "node:assert/strict"
import { appendFile } from "node:fs/promises"
import path from "node:path"

export const TASKLET_TRACE = "tasklet-fixture.jsonl"
export const TASKLET_READY = "Tasklet fixture: both children waiting."
export const TASKLET_MIXED = "Tasklet fixture: Alpha completed; Beta still waiting."
export const TASKLET_DONE = "Tasklet fixture completed with retained sibling results."
export const ALPHA_RESULT = "ALPHA_RESULT_PRIVATE"
export const ALPHA_REOPENED = "ALPHA_REOPENED_PRIVATE"
export const BETA_RESULT = "BETA_RESULT_PRIVATE"

const respond = (operation, text) => ({ name: "respond", args: { operation, text } })
const control = (operation, args = {}) => ({ name: "tasklets", args: { operation, ...args } })
const pendingQuestion = (record) => record.interactions.find((interaction) => interaction.status === "pending")

function parseResult(completion) {
	const message = completion.messages.findLast((message) => message.role === "tool")
	if (!message) return undefined
	const text = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n")
	return /^[[{]/u.test(text.trimStart()) ? JSON.parse(text) : text
}

/** Inspect after communication wakes; never treat acceptance or a wake as completion. */
function* inspectUntil(id, predicate) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const record = yield control("inspect", { tasklet_id: id })
		assert.equal(record.id, id)
		if (predicate(record)) return record
		const wake = yield control("sleep", { tasklet_ids: [id], timeout_ms: 10000 })
		// A response event may precede asynchronous settlement persistence; the following
		// deadline wake also requires a fresh inspection, never an inferred result.
		assert.ok(["event", "timeout"].includes(wake.reason), JSON.stringify(wake))
	}
	throw new Error(`Tasklet ${id} never reached the expected state`)
}

function* parentScenario() {
	const spawned = yield {
		name: "use_subagents",
		args: {
			subagents: ["ALPHA", "BETA"].map((name) => ({
				task_title: `Fixture ${name}`,
				prompt: `TASKLET_FIXTURE_${name}: report privately and ask the parent before completing.`,
				timeout: 240,
				include_history: false,
			})),
		},
	}
	assert.equal(spawned.subagents.length, 2)
	for (const child of spawned.subagents) {
		assert.equal(child.accepted, true, child.error)
		assert.equal(typeof child.id, "string")
		assert.equal(child.outcome, undefined, "Spawn must return before either waiting child completes")
	}
	const [alpha, beta] = spawned.subagents.map((child) => child.id)
	assert.notEqual(alpha, beta)
	const listed = yield control("list")
	assert.deepEqual(new Set(listed.map((record) => record.id)), new Set([alpha, beta]))
	const alphaWaiting = yield* inspectUntil(alpha, pendingQuestion)
	const betaWaiting = yield* inspectUntil(beta, pendingQuestion)
	yield respond("progress", TASKLET_READY)
	const firstWake = yield control("sleep", { tasklet_ids: [], timeout_ms: 120000 })
	assert.equal(firstWake.reason, "user_message", "Only explicit PTY user input releases this parent sleep")
	yield control("resolve", {
		tasklet_id: alpha,
		request_id: pendingQuestion(alphaWaiting).id,
		resolution: "answer",
		answer: "ALPHA_PARENT_ANSWER",
	})
	const firstResult = yield* inspectUntil(alpha, (record) => record.outcomePersisted)
	assert.equal(firstResult.outcome.kind, "completed")
	assert.ok(JSON.stringify(firstResult).includes(ALPHA_RESULT))
	const stillWaiting = yield control("inspect", { tasklet_id: beta })
	assert.equal(stillWaiting.outcome, undefined, "Completing Alpha must not join or cancel its sibling")
	assert.equal(pendingQuestion(stillWaiting).id, pendingQuestion(betaWaiting).id)
	const transcript = yield control("transcript", { tasklet_id: alpha })
	assert.ok(JSON.stringify(transcript).includes(ALPHA_RESULT))
	yield respond("progress", TASKLET_MIXED)
	const secondWake = yield control("sleep", { tasklet_ids: [], timeout_ms: 120000 })
	assert.equal(secondWake.reason, "user_message")
	const reopened = yield control("resume", { tasklet_id: alpha, message: "TASKLET_REOPEN_ALPHA" })
	assert.equal(reopened.id, alpha, "Resume retains the stable tasklet handle")
	const reopenedResult = yield* inspectUntil(alpha, (record) => record.outcomePersisted)
	assert.equal(reopenedResult.outcome.kind, "completed")
	assert.ok(JSON.stringify(reopenedResult).includes(ALPHA_REOPENED))
	yield control("resolve", {
		tasklet_id: beta,
		request_id: pendingQuestion(betaWaiting).id,
		resolution: "answer",
		answer: "BETA_PARENT_ANSWER",
	})
	const betaResult = yield* inspectUntil(beta, (record) => record.outcomePersisted)
	assert.equal(betaResult.outcome.kind, "completed")
	assert.ok(JSON.stringify(betaResult).includes(BETA_RESULT))
	const retained = yield control("inspect", { tasklet_id: alpha })
	assert.equal(retained.id, alpha)
	assert.ok(JSON.stringify(retained).includes(ALPHA_REOPENED))
	const betaTranscript = yield control("transcript", { tasklet_id: beta })
	assert.ok(JSON.stringify(betaTranscript).includes(BETA_RESULT))
	yield respond("complete", TASKLET_DONE)
	throw new Error("The tasklet fixture must not request another root completion")
}

/** Isolated scenario: root/children are classified by public tool availability and assignment markers, not request order. */
export function createTaskletFixture(workspace) {
	const parent = parentScenario()
	const requestCounts = new Map()
	let failure
	return async (completion) => {
		if (failure) throw failure
		const names = completion.tools?.map((tool) => tool.function.name) ?? []
		const root = names.includes("use_subagents")
		const messages = JSON.stringify(completion.messages)
		let actor = "parent"
		let call
		const result = parseResult(completion)
		try {
			if (root) {
				assert.ok(names.includes("tasklets"))
				const count = (requestCounts.get(actor) ?? 0) + 1
				requestCounts.set(actor, count)
				assert.ok(count <= 100, "Root fixture exceeded its bounded tool-control sequence")
				call = parent.next(result).value
			} else {
				assert.ok(!names.includes("tasklets"), "Contained children cannot supervise siblings")
				assert.ok(messages.includes("# CONTAINED TASKLET"))
				actor = messages.includes("TASKLET_FIXTURE_ALPHA") ? "alpha" : "beta"
				assert.ok(messages.includes(`TASKLET_FIXTURE_${actor.toUpperCase()}`))
				const count = (requestCounts.get(actor) ?? 0) + 1
				requestCounts.set(actor, count)
				assert.ok(count <= 5, `${actor} exceeded its bounded response sequence`)
				const calls = completion.messages.flatMap((message) => message.tool_calls ?? [])
				const operations = calls
					.filter((call) => call.function.name === "respond")
					.map((call) => JSON.parse(call.function.arguments).operation)
				if (messages.includes("TASKLET_REOPEN_ALPHA")) call = respond("complete", ALPHA_REOPENED)
				else if (!operations.includes("progress")) call = respond("progress", `${actor.toUpperCase()}_PROGRESS_PRIVATE`)
				else if (!operations.includes("question"))
					call = respond("question", `${actor.toUpperCase()}_QUESTION_PRIVATE: may I complete?`)
				else {
					assert.ok(messages.includes(`${actor.toUpperCase()}_PARENT_ANSWER`), "Child must receive its parent's answer")
					call = respond("complete", actor === "alpha" ? ALPHA_RESULT : BETA_RESULT)
				}
			}
			assert.ok(names.includes(call.name), `Fixture requires native ${call.name}`)
			await appendFile(path.join(workspace, TASKLET_TRACE), `${JSON.stringify({ actor, call, result })}\n`)
			return call
		} catch (error) {
			failure = error
			await appendFile(path.join(workspace, TASKLET_TRACE), `${JSON.stringify({ actor, error: error.stack, result })}\n`)
			throw error
		}
	}
}
