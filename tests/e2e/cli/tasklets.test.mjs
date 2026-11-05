import assert from "node:assert/strict"
import { readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { REPO_ROOT, requestSession, startSession } from "./client.mjs"
import {
	ALPHA_REOPENED,
	ALPHA_RESULT,
	BETA_RESULT,
	TASKLET_DONE,
	TASKLET_MIXED,
	TASKLET_READY,
	TASKLET_TRACE,
} from "./tasklet-fixture.mjs"

async function trace(workspace) {
	try {
		return (await readFile(path.join(workspace, TASKLET_TRACE), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
	} catch (error) {
		if (error.code === "ENOENT") return []
		throw error
	}
}

async function waitTrace(workspace, predicate) {
	for (let attempt = 0; attempt < 600; attempt++) {
		const entries = await trace(workspace)
		assert.ok(!entries.some((entry) => entry.error), JSON.stringify(entries, null, 2))
		if (predicate(entries)) return entries
		await delay(50)
	}
	assert.fail(`Fixture did not reach the expected phase:\n${JSON.stringify(await trace(workspace), null, 2)}`)
}

async function waitOwnerExit(session) {
	const { pid } = JSON.parse(await readFile(path.join(session, "session.json"), "utf8"))
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0)
		} catch (error) {
			if (error.code !== "ESRCH") throw error
			return
		}
		await delay(30)
	}
	throw new Error("Harness owner did not exit")
}

async function submit(session, text) {
	await requestSession(session, { operation: "write", text })
	return requestSession(session, { operation: "key", key: "Enter" })
}

async function openAgents(session) {
	await submit(session, "/agent")
	return requestSession(session, { operation: "wait", text: "3 total", timeoutMs: 30000 })
}

function assertAgents(snapshot, ids, statuses) {
	assert.match(snapshot.screen, /3 visible · 3 total/, snapshot.screen)
	for (let index = 0; index < ids.length; index++) {
		assert.ok(
			snapshot.lines.some(
				(line) =>
					line.includes(ids[index]) &&
					line.includes(`Fixture ${index ? "BETA" : "ALPHA"}`) &&
					line.includes(`· ${statuses[index]}`),
			),
			snapshot.screen,
		)
		assert.equal(
			snapshot.lines.filter((line) => line.includes(`Tasklet ${ids[index]}: Fixture`)).length,
			1,
			"Each stable handle appears once in the list",
		)
	}
}

async function inspectTasklet(session, id, expected) {
	const snapshot = await requestSession(session, { operation: "screen" })
	const taskletRows = snapshot.lines.filter((line) => line.includes("Tasklet ") && line.includes(": Fixture "))
	const index = taskletRows.findIndex((line) => line.includes(`Tasklet ${id}: Fixture`))
	assert.notEqual(index, -1, snapshot.screen)
	// Concurrent startup does not promise list order. Select the stable ID, not the first child.
	await requestSession(session, { operation: "key", key: "Up", count: 2 })
	await requestSession(session, { operation: "key", key: "Down", count: index + 1 })
	await requestSession(session, { operation: "key", key: "Enter" })
	const inspected = await requestSession(session, { operation: "wait", text: expected })
	assert.match(inspected.screen, new RegExp(`Tasklet ${id}: Fixture`))
	await requestSession(session, { operation: "key", key: "Escape" })
	return inspected
}

for (const rootKind of ["standalone", "goal"]) {
	test(
		`tasklets (${rootKind}): real CLI asynchronous siblings, parent sleep/resolve, same-ID resume and retained Agents previews`,
		{ timeout: 300000 },
		async (context) => {
			const metadata = await startSession({ fixture: "tasklets", cols: 180, rows: 46 })
			const { session, cwd } = metadata
			const sessions = [{ session, stopped: false }]
			let passed = false
			context.after(async () => {
				for (const owner of [...sessions].reverse()) {
					if (!owner.stopped) await requestSession(owner.session, { operation: "stop" })
					await waitOwnerExit(owner.session)
				}
				if (passed) {
					for (const owner of sessions) await rm(owner.session, { recursive: true })
					return
				}
				console.error(`Retained tasklet PTY artifacts: ${sessions.map((owner) => owner.session).join(", ")}`)
				console.error(
					JSON.stringify(
						(await trace(cwd)).filter((entry) => entry.error),
						null,
						2,
					),
				)
			})
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			await submit(session, `${rootKind === "goal" ? "/goal " : ""}Run the deterministic tasklet sibling scenario.`)
			await requestSession(session, { operation: "wait", text: TASKLET_READY, timeoutMs: 30000 })
			let entries = await waitTrace(
				cwd,
				(entries) =>
					entries.at(-1)?.call?.args.operation === "sleep" && entries.at(-1).call.args.tasklet_ids?.length === 0,
			)
			const accepted = entries.find((entry) => entry.actor === "parent" && entry.result?.subagents)?.result.subagents
			assert.equal(accepted.length, 2)
			const ids = accepted.map((child) => child.id)
			const rootId = entries.find((entry) => entry.result?.rootTaskId).result.rootTaskId
			const dataDirectory = path.join(session, "home", "data")
			const tasksDirectory = path.join(dataDirectory, "tasks")
			const goalFile = path.join(tasksDirectory, rootId, "goal.json")
			if (rootKind === "goal") {
				const goal = JSON.parse(await readFile(goalFile, "utf8"))
				assert.equal(goal.version, 2)
				assert.equal(goal.status, "working", "Private child questions do not mean the Goal awaits the user")
			}
			for (const child of accepted) {
				assert.equal(child.accepted, true)
				assert.equal(child.outcome, undefined, "Public spawn is asynchronous acceptance, not a join")
			}
			const waiting = await openAgents(session)
			assertAgents(waiting, ids, ["waiting", "waiting"])
			const preview = await inspectTasklet(session, ids[0], "Waiting for the parent")
			assert.match(preview.screen, /ALPHA_QUESTION_PRIVATE/)
			await requestSession(session, { operation: "key", key: "Escape" })
			const reopenedWaiting = await openAgents(session)
			assertAgents(reopenedWaiting, ids, ["waiting", "waiting"])
			assert.equal(
				(await trace(cwd)).length,
				entries.length,
				"Opening/closing previews must not send model requests or resolve questions",
			)
			await requestSession(session, { operation: "key", key: "Escape" })
			await submit(session, "Continue Alpha only.")
			await requestSession(session, { operation: "wait", text: TASKLET_MIXED, timeoutMs: 30000 })
			entries = await waitTrace(
				cwd,
				(entries) =>
					entries.some((entry) => entry.call?.args.text === TASKLET_MIXED) &&
					entries.at(-1)?.call?.args.operation === "sleep" &&
					entries.at(-1).call.args.tasklet_ids?.length === 0,
			)
			assert.ok(entries.some((entry) => entry.result?.reason === "user_message"))
			assertAgents(await openAgents(session), ids, ["completed", "waiting"])
			await inspectTasklet(session, ids[0], ALPHA_RESULT)
			await requestSession(session, { operation: "key", key: "Escape" })
			await submit(session, "Reopen Alpha, then finish Beta.")
			await requestSession(session, { operation: "wait", text: TASKLET_DONE, timeoutMs: 30000 })
			entries = await trace(cwd)
			assert.ok(!entries.some((entry) => entry.error), JSON.stringify(entries, null, 2))
			const resumed = entries.find((entry) => entry.call?.args.operation === "resume")
			assert.equal(resumed.call.args.tasklet_id, ids[0])
			assert.ok(
				entries.some(
					(entry) =>
						entry.result?.id === ids[0] &&
						entry.result.outcomePersisted &&
						JSON.stringify(entry.result).includes(ALPHA_REOPENED),
				),
			)
			assert.ok(
				entries.some(
					(entry) =>
						entry.result?.id === ids[1] &&
						entry.result.outcomePersisted &&
						JSON.stringify(entry.result).includes(BETA_RESULT),
				),
			)
			assertAgents(await openAgents(session), ids, ["completed", "completed"])
			await inspectTasklet(session, ids[0], ALPHA_REOPENED)
			await requestSession(session, { operation: "key", key: "Escape" })
			assertAgents(await openAgents(session), ids, ["completed", "completed"])
			await requestSession(session, { operation: "stop" })
			sessions[0].stopped = true
			await waitOwnerExit(session)
			assert.deepEqual(await readdir(tasksDirectory), [rootId], "Children never become top-level runs")
			const historyFile = path.join(dataDirectory, "state", "taskHistory.json")
			const history = JSON.parse(await readFile(historyFile, "utf8"))
			assert.deepEqual(
				history.map((item) => item.id),
				[rootId],
			)
			if (rootKind === "goal") {
				assert.equal(history[0].runKind, "goal")
				assert.equal(JSON.parse(await readFile(goalFile, "utf8")).status, "achieved")
			}
			const retainedFiles = ids.flatMap((id) =>
				["tasklet.json", "tasklet_events.json", "api_conversation_history.jsonl", "ui_messages.jsonl"].map((name) =>
					path.join(tasksDirectory, rootId, "tasklets", id, name),
				),
			)
			if (rootKind === "goal") retainedFiles.push(goalFile)
			const retainedBytes = await Promise.all(retainedFiles.map((file) => readFile(file, "utf8")))

			// Reopen the persisted root with the same isolated home/workspace, with no provider running.
			// Merely browsing retained previews must neither restart children nor make API calls.
			const { session: restored } = await startSession({
				command: process.execPath,
				args: [
					path.join(REPO_ROOT, "cli/dist/cli.mjs"),
					"--no-index",
					"--config",
					path.join(session, "home"),
					"--act",
					"--taskId",
					rootId,
				],
				cwd,
				cols: 180,
				rows: 46,
			})
			sessions.push({ session: restored, stopped: false })
			await requestSession(restored, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			const restoredList = await openAgents(restored)
			assertAgents(restoredList, ids, ["completed", "completed"])
			assert.equal(restoredList.fixtureRequests, null)
			await inspectTasklet(restored, ids[0], ALPHA_REOPENED)
			assert.deepEqual(
				await Promise.all(retainedFiles.map((file) => readFile(file, "utf8"))),
				retainedBytes,
				"Reopening and browsing neither restart children nor rewrite settled Goal/tasklet data",
			)
			assert.deepEqual(
				JSON.parse(await readFile(historyFile, "utf8")).map((item) => item.id),
				[rootId],
			)
			passed = true
		},
	)
}
