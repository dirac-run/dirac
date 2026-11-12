import assert from "node:assert/strict"
import { access, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { requestSession, startSession } from "./client.mjs"
import { CREATE_FILE_PATH, MODE_DONE, MODE_PLAN, MODE_QUESTION, MODE_REQUESTS, MODE_STREAM } from "./fixture-provider.mjs"

const PROMPT = "/askDirac Run the deterministic mode switch scenario."

async function jsonLines(file) {
	return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
}

async function rootIds(session) {
	return (await readdir(path.join(session, "home", "data", "tasks"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock"))
		.map((entry) => entry.name)
}

// These short, fresh-root scenarios cannot reach the presentation compaction threshold.
// Replay only card-bearing operations to inspect persisted interaction state, not UI glyphs.
async function cards(session, rootId) {
	const messages = new Map()
	for (const operation of await jsonLines(path.join(session, "home", "data", "tasks", rootId, "ui_messages.jsonl"))) {
		if (operation.type === "create") messages.set(operation.message.id, operation.message)
		else if (operation.type === "reset") {
			messages.clear()
			for (const message of operation.messages) messages.set(message.id, message)
		} else if (operation.type === "patch_message") Object.assign(messages.get(operation.id), operation.patch)
		else if (operation.type === "patch_card") Object.assign(messages.get(operation.id).content.card, operation.patch)
		else if (operation.type === "delete") messages.delete(operation.id)
	}
	return [...messages.values()].flatMap((message) => message.content.card ? [message.content.card] : [])
}

function messageText(message) {
	return typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("\n")
}

async function assertContinuation(metadata, beforeIds, pendingCards, targetMode, finalStatus, completionText) {
	const result = await requestSession(metadata.session, { operation: "wait", text: completionText, timeoutMs: 10000 })
	assert.equal(result.fixtureRequests, 2, "Mode switching continues at the next request, without restarting")
	assert.doesNotMatch(result.screen, /Resume \(1\)|operation was aborted/i)
	assert.deepEqual(await rootIds(metadata.session), beforeIds, "Switching mode preserves the root task ID")
	const requests = await jsonLines(path.join(metadata.session, "home", MODE_REQUESTS))
	assert.equal(requests.length, 2)
	const [initial, continued] = requests
	const originalPrompt = initial.messages.find((message) => message.role === "user")
	assert.ok(originalPrompt)
	assert.ok(continued.messages.some((message) => message.role === "user" && messageText(message) === messageText(originalPrompt)), "The original user turn is retained")
	const latestUser = continued.messages.findLast((message) => message.role === "user")
	assert.ok(messageText(latestUser).includes(`# Current Mode\n${targetMode.toUpperCase()} MODE`), "The next model request receives the new mode instructions")
	const toolResult = continued.messages.find((message) => message.role === "tool" && message.tool_call_id === "tui-tool-1")
	assert.ok(toolResult, "The pending tool receives a result in the original conversation")
	if (finalStatus === "success") {
		assert.match(messageText(toolResult), /The user has switched to ACT MODE, so you may now proceed with the task\./)
	} else if (pendingCards.length > 0) {
		assert.ok(messageText(toolResult).includes(`The user switched to ${targetMode.toUpperCase()} MODE. You are now in ${targetMode === "plan" ? "Plan" : "Act"} mode.`), "Skipped interaction results contain the mode-change notice")
	}
	const finalCards = await cards(metadata.session, beforeIds[0])
	for (const pending of pendingCards) {
		assert.equal(finalCards.find((card) => card.id === pending.id)?.status, finalStatus, `Interaction ${pending.header} is ${finalStatus}`)
	}
	const remainingInteractions = finalCards.filter((card) => card.status === "waiting_for_input")
	if (targetMode === "plan") {
		assert.equal(remainingInteractions.length, 1, "Plan mode ends with one new proposed-plan response")
		assert.ok(remainingInteractions[0].body.includes(completionText))
		assert.ok(!pendingCards.some((card) => card.id === remainingInteractions[0].id), "The final plan is new, not a stale pre-switch interaction")
	} else {
		assert.deepEqual(remainingInteractions, [], "No stale pending root interaction remains")
	}
	await assert.rejects(access(path.join(metadata.cwd, CREATE_FILE_PATH)), { code: "ENOENT" })
	assert.deepEqual(await readdir(metadata.cwd), [], "Mode switching does not write any workspace files")
}

async function switchWaiting({ fixture, initialMode = "act", waitingText, accepted = false }, context) {
	const metadata = await startSession({ fixture, cols: 160, rows: 40 })
	const { session } = metadata
	let passed = false
	context.after(async () => {
		await requestSession(session, { operation: "stop" })
		if (!passed) console.error(`Retained mode-switch PTY artifacts: ${session}`)
	})
	await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
	if (initialMode === "plan") await requestSession(session, { operation: "key", key: "Tab" })
	await requestSession(session, { operation: "write", text: PROMPT })
	await requestSession(session, { operation: "key", key: "Enter" })
	await requestSession(session, { operation: "wait", text: waitingText, timeoutMs: 30000 })
	const beforeIds = await rootIds(session)
	assert.equal(beforeIds.length, 1, "The /askDirac prompt creates one standalone root")
	const pendingCards = (await cards(session, beforeIds[0])).filter((card) => card.status === "waiting_for_input")
	assert.ok(pendingCards.length > 0, "The scenario must reach a real pending root interaction before Tab")
	await requestSession(session, { operation: "key", key: "Tab" })
	await assertContinuation(metadata, beforeIds, pendingCards, initialMode === "act" ? "plan" : "act", accepted ? "success" : "skipped", fixture === "create-file" ? "File creation fixture completed." : MODE_DONE)
	passed = true
}

test("switching mode skips a permission request and continues without restarting", { timeout: 60000 }, async (context) => {
	await switchWaiting({ fixture: "create-file", waitingText: "Dirac wants to create" }, context)
})

for (const initialMode of ["act", "plan"]) {
	test(`switching ${initialMode} mode skips a waiting question and continues without restarting`, { timeout: 60000 }, async (context) => {
		await switchWaiting({ fixture: "mode-question", initialMode, waitingText: MODE_QUESTION }, context)
	})
}

test("switching Plan to Act accepts the proposed plan and preserves the conversation", { timeout: 60000 }, async (context) => {
	await switchWaiting({ fixture: "mode-plan", initialMode: "plan", waitingText: MODE_PLAN, accepted: true }, context)
})

for (const initialMode of ["act", "plan"]) {
	test(`switching ${initialMode} mode during active streaming applies at the next request boundary`, { timeout: 60000 }, async (context) => {
		const metadata = await startSession({ fixture: "mode-stream", cols: 160, rows: 40 })
		const { session } = metadata
		let passed = false
		context.after(async () => {
			await requestSession(session, { operation: "stop" })
			if (!passed) console.error(`Retained mode-switch PTY artifacts: ${session}`)
		})
		await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		if (initialMode === "plan") await requestSession(session, { operation: "key", key: "Tab" })
		await requestSession(session, { operation: "write", text: PROMPT })
		await requestSession(session, { operation: "key", key: "Enter" })
		await requestSession(session, { operation: "wait", text: MODE_STREAM, timeoutMs: 30000 })
		const beforeIds = await rootIds(session)
		assert.equal(beforeIds.length, 1)
		assert.equal((await jsonLines(path.join(session, "home", MODE_REQUESTS))).length, 1, "The stream remains open before Tab")
		await requestSession(session, { operation: "key", key: "Tab" })
		assert.equal((await jsonLines(path.join(session, "home", MODE_REQUESTS))).length, 1, "Tab does not abort/restart the active response")
		const config = JSON.parse(await readFile(path.join(session, "home", "data", "globalState.json"), "utf8"))
		const release = await fetch(new URL("/fixture/release-stream", config.openAiBaseUrl), { method: "POST" })
		assert.equal(release.status, 204)
		await assertContinuation(metadata, beforeIds, [], initialMode === "act" ? "plan" : "act", undefined, MODE_DONE)
		passed = true
	})
}
