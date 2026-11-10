import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { ToolExecutionIdentity, ToolExecutionWorkOutcome } from "@shared/toolExecution"
import { createToolExecution } from "./ToolExecution"
import { ToolExecutionOwner, type ToolExecutionOperation, type ToolExecutionOperationContext } from "./ToolExecutionOwner"
import type { ToolExecutionStore, ToolExecutionStoreSnapshot } from "./ToolExecutionStore"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}

const owner = { rootTaskId: "root", taskId: "task", runId: "run" }
const success: ToolExecutionWorkOutcome = { kind: "success", content: "done" }
function identity(id = "one"): ToolExecutionIdentity {
	return {
		executionId: id, owner, requestId: "request", nativeToolCallId: `call-${id}`, toolName: "fake",
		toolSnapshot: { requestId: "request", inventoryVersion: 1 },
	}
}

class MemoryStore implements ToolExecutionStore {
	snapshot: ToolExecutionStoreSnapshot = {
		schemaVersion: 1, revision: 0, owner, admissionClosed: false, records: [], acknowledgedEventIds: [],
	}
	fail?: (next: ToolExecutionStoreSnapshot) => boolean
	beforeCommit?: (next: ToolExecutionStoreSnapshot) => Promise<void>
	async load() { return structuredClone(this.snapshot) }
	async commit(expectedRevision: number, next: ToolExecutionStoreSnapshot) {
		assert.equal(expectedRevision, this.snapshot.revision)
		if (this.fail?.(next)) throw new Error("disk unavailable")
		await this.beforeCommit?.(next)
		this.snapshot = structuredClone(next)
	}
}

function fake() {
	const result = deferred<ToolExecutionWorkOutcome>()
	const started = deferred<ToolExecutionOperationContext>()
	const cleaning = deferred<void>()
	let runs = 0
	let cleanups = 0
	let cleanup: () => Promise<void> = async () => { }
	const operation: ToolExecutionOperation = {
		async run(context) { runs++; started.resolve(context); return result.promise },
		async cleanup() { cleanups++; cleaning.resolve(); await cleanup() },
	}
	return { operation, result, started, cleaning, runs: () => runs, cleanups: () => cleanups, setCleanup: (fn: () => Promise<void>) => { cleanup = fn } }
}

async function setup(capacity = { maxOwnedWork: 8, maxRunningWork: 2, maxWaitingObservers: 2 }) {
	const store = new MemoryStore()
	const runtime = await ToolExecutionOwner.open({ owner, store, capacity, now: () => 42 })
	return { store, runtime }
}

function admit(runtime: ToolExecutionOwner, work: ReturnType<typeof fake>, id = "one") {
	return runtime.admit({ identity: identity(id), arguments: { value: id }, operation: work.operation })
}

const waitRequest = (ids = ["one"], mode: "any" | "all" = "all", timeout_ms?: number) => ({
	operation: "wait" as const, execution_ids: ids, mode, timeout_ms,
})
const waitOptions = { observerExecutionId: "observer" }

async function complete(runtime: ToolExecutionOwner, work: ReturnType<typeof fake>, id = "one") {
	work.result.resolve(success)
	return runtime.join(id)
}

describe("ToolExecutionOwner admission and ownership", () => {
	it("reattributes outstanding waits without exposing a running state between them", async () => {
		const { store, runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		const context = await work.started.promise
		await context.waiting({ kind: "waiting_permission", permissionRequestId: "permission" })
		const persistedStates: string[] = []
		store.beforeCommit = async (next) => { persistedStates.push(next.records[0].state.kind) }
		await context.waiting({ kind: "waiting_input", inputRequestId: "input" })
		assert.deepEqual((await runtime.inspectRaw("one")).state, { kind: "waiting_input", inputRequestId: "input" })
		assert.deepEqual(persistedStates, ["waiting_input"])
		await context.resume()
		assert.equal((await runtime.inspectRaw("one")).state.kind, "running")
		await complete(runtime, work)
	})

	it("persists queued admission and running state before any operation effect", async () => {
		const { store, runtime } = await setup()
		const gate = deferred<void>()
		const queued = deferred<void>()
		store.beforeCommit = async (next) => {
			if (next.records[0]?.state.kind === "queued") { queued.resolve(); await gate.promise }
		}
		const work = fake()
		const admission = admit(runtime, work)
		await queued.promise
		assert.equal(work.runs(), 0)
		gate.resolve()
		await admission
		await work.started.promise
		assert.equal(store.snapshot.records[0].state.kind, "running")
		await complete(runtime, work)
	})

	it("launches no effect on failed admission and allows an explicit fresh retry", async () => {
		const { store, runtime } = await setup()
		store.fail = () => true
		const work = fake()
		await assert.rejects(admit(runtime, work), /disk unavailable/)
		assert.equal(work.runs(), 0)
		assert.equal(store.snapshot.records.length, 0)
		store.fail = undefined
		await admit(runtime, work)
		await complete(runtime, work)
		assert.equal(work.runs(), 1)
	})

	it("retains a durably queued execution if running persistence fails; duplicate never launches it", async () => {
		const { store, runtime } = await setup()
		store.fail = (next) => next.records.some((record) => record.state.kind === "running")
		const work = fake()
		assert.deepEqual(await admit(runtime, work), { kind: "admitted", executionId: "one", replayed: false })
		assert.equal((await runtime.ownershipFailures()).length, 1)
		assert.equal((await runtime.inspectRaw("one")).state.kind, "queued")
		assert.equal(work.runs(), 0)
		store.fail = undefined
		assert.equal((await admit(runtime, work)).kind, "admitted")
		assert.equal(work.runs(), 0)
		await runtime.retryPending()
		await complete(runtime, work)
		assert.equal(work.runs(), 1)
	})

	it("replays identical identity, rejects changed arguments/native identity, and rejects foreign admission", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		assert.deepEqual(await admit(runtime, fake()), { kind: "admitted", executionId: "one", replayed: true })
		await assert.rejects(runtime.admit({ identity: identity(), arguments: { value: "different" }, operation: work.operation }), /Conflicting duplicate/)
		await assert.rejects(runtime.admit({ identity: { ...identity(), executionId: "other-id" }, arguments: { value: "one" }, operation: work.operation }), /Conflicting duplicate/)
		await assert.rejects(runtime.admit({ identity: { ...identity("foreign"), owner: { ...owner, runId: "other" } }, arguments: {}, operation: work.operation }), /foreign/)
		await complete(runtime, work)
		await admit(runtime, work)
		assert.equal(work.runs(), 1)
	})

	it("captures admission data synchronously and protects raw inspection from caller mutation", async () => {
		const { runtime } = await setup()
		const work = fake()
		const id = { ...identity(), owner: { ...owner } }
		const args = { values: ["original"] }
		const admission = runtime.admit({ identity: id, arguments: args, operation: work.operation })
		args.values.push("changed")
		id.owner.runId = "changed"
		await admission
		const raw = await runtime.inspectRaw("one")
		assert.deepEqual(raw.arguments, { values: ["original"] })
		assert.equal(raw.identity.owner.runId, "run")
			; (raw.arguments as { values: string[] }).values.push("external")
		assert.deepEqual((await runtime.inspectRaw("one")).arguments, { values: ["original"] })
		await complete(runtime, work)
	})

	it("joins underlying run then actual cleanup despite cancellation and preserves real outcome", async () => {
		const { runtime } = await setup()
		const work = fake()
		const cleanup = deferred<void>()
		work.setCleanup(() => cleanup.promise)
		await admit(runtime, work)
		const context = await work.started.promise
		await runtime.cancel("one", "stop")
		assert.equal(context.signal.aborted, true)
		assert.equal((await runtime.inspectRaw("one")).state.kind, "running")
		let joined = false
		const join = runtime.join("one").then((record) => { joined = true; return record })
		work.result.resolve(success)
		await work.cleaning.promise
		assert.equal((await runtime.inspectRaw("one")).state.kind, "settling")
		assert.equal(joined, false)
		cleanup.resolve()
		const terminal = await join
		assert.deepEqual(terminal.state, { kind: "terminal", outcome: success })
		assert.equal(terminal.cancellation?.requestedAt, 42)
	})

	it("persists cancellation before signaling and does not signal on failed commit", async () => {
		const { store, runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		const context = await work.started.promise
		store.fail = (next) => next.records[0].cancellation !== null
		await assert.rejects(runtime.cancel("one"), /disk unavailable/)
		assert.equal(context.signal.aborted, false)
		store.fail = undefined
		await complete(runtime, work)
	})

	it("records rejected operations as typed failures and still cleans up", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		work.result.reject(new Error("boom"))
		const record = await runtime.join("one")
		assert.deepEqual(record.state, { kind: "terminal", outcome: { kind: "failure", error: { code: "OPERATION_REJECTED", message: "boom" } } })
		assert.equal(work.cleanups(), 1)
	})

	it("retains cleanup failure as settling, exposes join error, and retries without rerunning", async () => {
		const { runtime } = await setup()
		const work = fake()
		work.setCleanup(async () => { throw new Error("resource alive") })
		await admit(runtime, work)
		work.result.resolve(success)
		await assert.rejects(runtime.join("one"), /resource alive/)
		const record = await runtime.inspectRaw("one")
		assert.deepEqual(record.state, { kind: "settling", operationOutcome: success, settlementError: { code: "CLEANUP_FAILED", message: "resource alive" } })
		assert.equal((await runtime.ownershipFailures()).length, 1)
		assert.equal((await runtime.pendingEvents()).length, 0)
		work.setCleanup(async () => { })
		await Promise.all([runtime.retrySettlement("one"), runtime.retrySettlement("one")])
		assert.equal((await runtime.join("one")).state.kind, "terminal")
		assert.equal(work.runs(), 1)
		assert.equal(work.cleanups(), 2)
	})

	for (const failedState of ["settling", "terminal"] as const) {
		it(`retains actual outcome after ${failedState} persistence failure, with cleanup and explicit retry`, async () => {
			const { store, runtime } = await setup()
			const work = fake()
			await admit(runtime, work)
			await runtime.chooseResponse("one", "accepted")
			await runtime.markResponseCommitted("one")
			store.fail = (next) => next.records[0].state.kind === failedState
			work.result.resolve(success)
			await assert.rejects(runtime.join("one"), /persistence failed|disk unavailable/)
			assert.equal(work.cleanups(), 1)
			assert.notEqual((await runtime.inspectRaw("one")).state.kind, "terminal")
			assert.equal((await runtime.pendingEvents()).length, 0)
			assert.equal((await runtime.ownershipFailures()).length, 1)
			store.fail = undefined
			await runtime.retrySettlement("one")
			assert.deepEqual((await runtime.join("one")).state, { kind: "terminal", outcome: success })
			assert.equal(work.runs(), 1)
			assert.equal(work.cleanups(), 1)
			assert.equal((await runtime.pendingEvents()).length, 1)
		})
	}
})

describe("ToolExecutionOwner response and outbox", () => {
	it("chooses one response, requires durable inclusion before completion event, and acknowledges nonconsumingly", async () => {
		const { store, runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		const response = await runtime.chooseResponse("one", "first acceptance")
		assert.equal(response.kind, "accepted")
		await complete(runtime, work)
		assert.deepEqual(await runtime.chooseResponse("one", "different"), response)
		assert.deepEqual(await runtime.pendingEvents(), [])
		await runtime.markResponseCommitted("one")
		const events = await runtime.pendingEvents()
		assert.equal(events.length, 1)
		assert.deepEqual(await runtime.pendingEvents(), events)
		const ready = await runtime.wait(waitRequest(), waitOptions)
		assert.equal("status" in ready && ready.status, "ready")
		assert.deepEqual(await runtime.pendingEvents(), events)
		store.fail = () => true
		await assert.rejects(runtime.acknowledgeEvents([events[0].eventId]), /disk unavailable/)
		assert.deepEqual(await runtime.pendingEvents(), events)
		store.fail = undefined
		await runtime.acknowledgeEvents([events[0].eventId])
		await runtime.acknowledgeEvents([events[0].eventId])
		assert.deepEqual(await runtime.pendingEvents(), [])
		const reopened = await ToolExecutionOwner.open({ owner, store })
		assert.deepEqual(await reopened.pendingEvents(), [])
		await assert.rejects(reopened.acknowledgeEvents(["unknown"]), /Unknown completion event/)
	})

	it("returns settled original response without creating an event and projects large outcomes by reference", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		work.result.resolve({ kind: "success", content: "x".repeat(20_000) })
		await runtime.join("one")
		assert.equal((await runtime.chooseResponse("one", "unused")).kind, "settled")
		await runtime.markResponseCommitted("one")
		assert.deepEqual(await runtime.pendingEvents(), [])
		assert.equal((await runtime.inspect("one")).result?.kind, "reference")
		assert.equal((await runtime.inspectRaw("one")).state.kind, "terminal")
	})

	it("does not expose an original-response choice or completion event from a failed commit", async () => {
		const { store, runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		store.fail = (next) => next.records[0].originalResponse !== null
		await assert.rejects(runtime.chooseResponse("one", "accept"), /disk unavailable/)
		assert.equal((await runtime.inspectRaw("one")).originalResponse, null)
		store.fail = undefined
		await runtime.chooseResponse("one", "accept")
		await complete(runtime, work)
		store.fail = (next) => next.records[0].completionEvent !== null
		await assert.rejects(runtime.markResponseCommitted("one"), /disk unavailable/)
		assert.deepEqual(await runtime.pendingEvents(), [])
		store.fail = undefined
		await runtime.markResponseCommitted("one")
		assert.equal((await runtime.pendingEvents()).length, 1)
	})
})

describe("ToolExecutionOwner event-driven waits and capacities", () => {
	for (const ready of [false, true]) {
		it(`isolates immediate ${ready ? "ready" : "timeout"} observations from persisted state`, async () => {
			const { store, runtime } = await setup()
			const work = fake()
			await admit(runtime, work)
			if (ready) {
				work.result.resolve({ kind: "success", content: [{ type: "text", text: "original" }] })
				await runtime.join("one")
			}
			const before = await runtime.inspectRaw("one")
			const observation = await runtime.wait(waitRequest(["one"], "all", 0), waitOptions)
			if (!("executions" in observation)) assert.fail("Expected observation")
			assert.equal(observation.status, ready ? "ready" : "timeout")
			const inspected = observation.executions[0]
			Object.assign(inspected.identity.owner, { runId: "mutated" })
			Object.assign(inspected.identity, { executionId: "mutated" })
			if (inspected.result?.kind === "inline") {
				Object.assign(inspected.result.outcome, { content: "mutated" })
			}
			assert.deepEqual(await runtime.inspectRaw("one"), before)
			assert.deepEqual(store.snapshot.records[0], before)
			if (!ready) await complete(runtime, work)
		})
	}

	it("does not wake on unpersisted outcomes; durable terminal beats simultaneous wait cancellation", async () => {
		const { store, runtime } = await setup()
		const work = fake(), terminalCommit = deferred<void>(), releaseCommit = deferred<void>()
		await admit(runtime, work)
		const signal = new AbortController()
		let woken = false
		const wait = runtime.wait(waitRequest(), { ...waitOptions, signal: signal.signal }).then((result) => { woken = true; return result })
		await runtime.inspectRaw("one")
		store.beforeCommit = async (next) => {
			if (next.records[0].state.kind === "terminal") { terminalCommit.resolve(); await releaseCommit.promise }
		}
		work.result.resolve(success)
		await terminalCommit.promise
		assert.equal(woken, false)
		signal.abort()
		releaseCommit.resolve()
		const observation = await wait
		assert.equal("status" in observation && observation.status, "ready")
		await runtime.join("one")
	})

	it("pins wait options before registration and keeps cancellation limited to the observer", async () => {
		const { runtime } = await setup()
		const work = fake(), signal = new AbortController(), other = new AbortController()
		await admit(runtime, work)
		const options = { observerExecutionId: "observer", signal: signal.signal }
		const wait = runtime.wait(waitRequest(), options)
		options.observerExecutionId = "one"
		options.signal = other.signal
		await runtime.inspectRaw("one")
		signal.abort()
		const observation = await wait
		assert.equal("status" in observation && observation.status, "cancelled")
		await complete(runtime, work)
	})

	it("checks and registers without lost wakeups, preserves requested order, supports any and all", async () => {
		const { runtime } = await setup()
		const first = fake(), second = fake()
		await admit(runtime, first)
		await admit(runtime, second, "two")
		const any = runtime.wait(waitRequest(["two", "one"], "any"), waitOptions)
		const all = runtime.wait(waitRequest(["two", "one"], "all"), waitOptions)
		await complete(runtime, first)
		const observed = await any
		assert.equal("status" in observed && observed.status, "ready")
		if (!("executions" in observed)) assert.fail("Expected observation")
		assert.deepEqual(observed.executions.map((record) => record.identity.executionId), ["two", "one"])
		assert.deepEqual(observed.executions.map((record) => record.state), ["running", "terminal"])
		await complete(runtime, second, "two")
		assert.equal("status" in await all && (await all as { status: string }).status, "ready")
		assert.equal("status" in await runtime.wait(waitRequest(["one"]), waitOptions), true)
	})

	it("timeout, input, and cancellation end only the wait, with already-terminal targets winning", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		const signal = new AbortController(), userInput = new AbortController()
		const wait = runtime.wait(waitRequest(), { ...waitOptions, signal: signal.signal })
		await runtime.inspectRaw("one")
		signal.abort()
		assert.equal("status" in await wait && (await wait as { status: string }).status, "cancelled")
		const inputWait = runtime.wait(waitRequest(), { ...waitOptions, userInput: userInput.signal })
		await runtime.inspectRaw("one")
		userInput.abort()
		assert.equal("status" in await inputWait && (await inputWait as { status: string }).status, "user_input")
		const timeout = await runtime.wait(waitRequest(["one"], "all", 0), waitOptions)
		assert.equal("status" in timeout && timeout.status, "timeout")
		assert.equal((await work.started.promise).signal.aborted, false)
		await complete(runtime, work)
		const ready = await runtime.wait(waitRequest(["one"], "all", 0), { ...waitOptions, signal: signal.signal })
		assert.equal("status" in ready && ready.status, "ready")
	})

	it("removes deadline listeners and supports a finite event-driven timeout", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		const observation = await runtime.wait(waitRequest(["one"], "all", 1), waitOptions)
		assert.equal("status" in observation && observation.status, "timeout")
		await complete(runtime, work)
	})

	it("rejects self, unknown/foreign IDs and invalid wait sets before registration", async () => {
		const { runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		await assert.rejects(runtime.wait(waitRequest(), { observerExecutionId: "one" }), /itself/)
		await assert.rejects(runtime.wait(waitRequest(["foreign"]), waitOptions), /Unknown tool execution/)
		await assert.rejects(runtime.wait(waitRequest([]), waitOptions), /nonempty/)
		await assert.rejects(runtime.wait(waitRequest(["one", "one"]), waitOptions), /distinct/)
		await assert.rejects(runtime.wait(waitRequest(["one"], "any", -1), waitOptions), /Invalid/)
		await complete(runtime, work)
	})

	it("saturated work/wait budgets cannot block inspect, cancel, output-independent settlement, or queued joins", async () => {
		const { runtime } = await setup({ maxOwnedWork: 2, maxRunningWork: 1, maxWaitingObservers: 1 })
		const first = fake(), second = fake(), excess = fake()
		await admit(runtime, first)
		await admit(runtime, second, "two")
		assert.deepEqual(await admit(runtime, excess, "three"), { kind: "rejected", reason: "work_capacity" })
		assert.equal(second.runs(), 0)
		const all = runtime.wait(waitRequest(["one", "two"]), waitOptions)
		await runtime.inspectRaw("one")
		assert.deepEqual(await runtime.wait(waitRequest(), waitOptions), { kind: "rejected", reason: "wait_capacity" })
		assert.equal((await runtime.inspect("two")).state, "queued")
		const queuedJoin = runtime.join("two")
		await runtime.cancel("two", "queued cancellation")
		assert.deepEqual((await queuedJoin).state, { kind: "terminal", outcome: { kind: "cancelled", reason: "queued cancellation" } })
		assert.equal(second.runs(), 0)
		assert.equal(second.cleanups(), 0)
		await complete(runtime, first)
		assert.equal("status" in await all, true)
	})

	it("starts queued work only after actual predecessor cleanup relinquishes its slot", async () => {
		const { runtime } = await setup({ maxOwnedWork: 2, maxRunningWork: 1, maxWaitingObservers: 1 })
		const first = fake(), second = fake(), cleanup = deferred<void>()
		first.setCleanup(() => cleanup.promise)
		await admit(runtime, first)
		await admit(runtime, second, "two")
		const join = runtime.join("two")
		first.result.resolve(success)
		await first.cleaning.promise
		assert.equal(second.runs(), 0)
		cleanup.resolve()
		await second.started.promise
		second.result.resolve(success)
		await join
	})
})

describe("ToolExecutionOwner closure and recovery", () => {
	it("blocks on chosen uncommitted responses even for non-native calls", async () => {
		const { runtime } = await setup()
		const work = fake()
		await runtime.admit({ identity: { ...identity(), nativeToolCallId: null }, arguments: {}, operation: work.operation })
		await runtime.chooseResponse("one", "accepted")
		await complete(runtime, work)
		assert.equal((await runtime.prepareCompletion()).length, 1)
		await runtime.markResponseCommitted("one")
		assert.equal((await runtime.prepareCompletion()).length, 1)
		await runtime.acknowledgeEvents((await runtime.pendingEvents()).map((event) => event.eventId))
		assert.deepEqual(await runtime.prepareCompletion(), [])
		assert.equal((await runtime.inspect("one")).state, "terminal")
	})

	it("atomically gates completion on work, native response and event delivery, excluding itself", async () => {
		const { runtime } = await setup()
		const work = fake(), self = fake()
		await admit(runtime, work)
		await admit(runtime, self, "self")
		assert.deepEqual((await runtime.prepareCompletion("self")).map((record) => record.identity.executionId), ["one"])
		await runtime.chooseResponse("one", "accepted")
		await complete(runtime, work)
		assert.equal((await runtime.prepareCompletion("self")).length, 1)
		await runtime.markResponseCommitted("one")
		assert.equal((await runtime.prepareCompletion("self")).length, 1)
		await runtime.acknowledgeEvents((await runtime.pendingEvents()).map((event) => event.eventId))
		assert.deepEqual(await runtime.prepareCompletion("self"), [])
		assert.deepEqual(await admit(runtime, fake(), "late"), { kind: "rejected", reason: "owner_closed" })
		await complete(runtime, self, "self")
	})

	it("failed close persistence leaves admission open", async () => {
		const { store, runtime } = await setup()
		store.fail = (next) => next.admissionClosed
		await assert.rejects(runtime.prepareCompletion(), /disk unavailable/)
		store.fail = undefined
		const work = fake()
		await admit(runtime, work)
		await complete(runtime, work)
	})

	it("shutdown closes admission, wakes waits, cancels queued work and joins running resources", async () => {
		const { runtime } = await setup({ maxOwnedWork: 2, maxRunningWork: 1, maxWaitingObservers: 1 })
		const work = fake(), queued = fake(), cleanup = deferred<void>()
		work.setCleanup(() => cleanup.promise)
		await admit(runtime, work)
		await admit(runtime, queued, "two")
		const wait = runtime.wait(waitRequest(), waitOptions)
		await runtime.inspectRaw("one")
		let closed = false
		const shutdown = runtime.shutdown().then(() => { closed = true })
		const observation = await wait
		assert.equal("status" in observation && observation.status, "cancelled")
		await runtime.inspectRaw("one")
		assert.equal((await work.started.promise).signal.aborted, true)
		assert.deepEqual(await admit(runtime, fake(), "late"), { kind: "rejected", reason: "owner_closed" })
		work.result.resolve({ kind: "cancelled", reason: "acknowledged" })
		await work.cleaning.promise
		assert.equal(closed, false)
		cleanup.resolve()
		await shutdown
		assert.equal(queued.runs(), 0)
		assert.equal((await runtime.inspectRaw("two")).state.kind, "terminal")
		await assert.rejects(runtime.cancel("one"), /closed/)
		assert.deepEqual(await runtime.wait(waitRequest(), waitOptions), { kind: "rejected", reason: "owner_closed" })
	})

	it("shutdown aggregates cleanup errors without falsely reporting resources settled", async () => {
		const { runtime } = await setup()
		const work = fake()
		work.setCleanup(async () => { throw new Error("still alive") })
		await admit(runtime, work)
		work.result.resolve(success)
		await assert.rejects(runtime.shutdown(), AggregateError)
		assert.equal((await runtime.inspectRaw("one")).state.kind, "settling")
		work.setCleanup(async () => { })
		await runtime.shutdown()
		assert.equal((await runtime.inspectRaw("one")).state.kind, "terminal")
	})

	for (const failClosure of [true, false]) {
		it(`shutdown still aborts and cleans all resources when ${failClosure ? "closure and all" : "cancellation"} commits fail`, async () => {
			const { store, runtime } = await setup({ maxOwnedWork: 2, maxRunningWork: 1, maxWaitingObservers: 1 })
			const work = fake(), queued = fake()
			await admit(runtime, work)
			await admit(runtime, queued, "two")
			const context = await work.started.promise
			store.fail = failClosure ? () => true : (next) => next.records.some((record) => record.cancellation !== null)
			const shutdown = runtime.shutdown()
			const rejected = assert.rejects(shutdown, AggregateError)
			await runtime.inspectRaw("one")
			assert.equal(context.signal.aborted, true)
			assert.deepEqual(await admit(runtime, fake(), "late"), { kind: "rejected", reason: "owner_closed" })
			work.result.resolve(success)
			await rejected
			assert.equal(work.cleanups(), 1)
			assert.equal(queued.runs(), 0)
			if (failClosure) {
				assert.equal(store.snapshot.admissionClosed, false)
				assert.notEqual((await runtime.inspectRaw("one")).state.kind, "terminal")
				assert.equal((await runtime.ownershipFailures()).length, 2)
			}
			store.fail = undefined
			await runtime.shutdown()
			assert.equal((await runtime.inspectRaw("two")).state.kind, "terminal")
			assert.equal(work.cleanups(), 1)
		})
	}

	it("reserves recovered resource slots until durable reconciliation and then starts queued work", async () => {
		const store = new MemoryStore()
		const recovered = { ...createToolExecution(identity("old"), {}), hasStarted: true, state: { kind: "running" as const } }
		store.snapshot = { ...store.snapshot, records: [recovered] }
		const runtime = await ToolExecutionOwner.open({
			owner, store, capacity: { maxOwnedWork: 2, maxRunningWork: 1, maxWaitingObservers: 1 },
		})
		const work = fake()
		await admit(runtime, work)
		await runtime.retryPending()
		assert.equal(work.runs(), 0)
		assert.equal((await runtime.inspectRaw("one")).state.kind, "queued")
		store.fail = (next) => next.records.some((record) => record.identity.executionId === "old" && record.state.kind === "terminal")
		await assert.rejects(runtime.reconcileInterrupted("old", { resourcesSettled: true }), /disk unavailable/)
		assert.equal(work.runs(), 0)
		store.fail = undefined
		await runtime.reconcileInterrupted("old", { resourcesSettled: true })
		await work.started.promise
		assert.equal(work.runs(), 1)
		await complete(runtime, work)
	})

	it("recovers queued work as interrupted and running work as unresolved without silently rerunning", async () => {
		const store = new MemoryStore()
		const queued = createToolExecution(identity("queued"), {})
		const running = { ...createToolExecution(identity(), {}), hasStarted: true, state: { kind: "running" as const } }
		store.snapshot = { ...store.snapshot, records: [queued, running] }
		const runtime = await ToolExecutionOwner.open({ owner, store })
		assert.deepEqual((await runtime.inspectRaw("queued")).state, {
			kind: "terminal", outcome: { kind: "interrupted", reason: "Owner runtime restarted; operation is not replayed" },
		})
		const record = await runtime.inspectRaw("one")
		assert.equal(record.state.kind, "settling")
		if (record.state.kind !== "settling") assert.fail("Expected unresolved resources")
		assert.equal(record.state.settlementError?.code, "RESOURCE_RECONCILIATION_REQUIRED")
		await assert.rejects(runtime.join("one"), /reconciliation/)
		const work = fake()
		assert.deepEqual(await runtime.admit({ identity: identity(), arguments: {}, operation: work.operation }), { kind: "admitted", executionId: "one", replayed: true })
		assert.equal(work.runs(), 0)
		await runtime.reconcileInterrupted("one", { resourcesSettled: true })
		assert.equal((await runtime.join("one")).state.kind, "terminal")
	})

	it("preserves recoverable completion events, closed admission, and rejects a mismatched owner", async () => {
		const { store, runtime } = await setup()
		const work = fake()
		await admit(runtime, work)
		await runtime.chooseResponse("one", "accepted")
		await runtime.markResponseCommitted("one")
		await complete(runtime, work)
		const events = await runtime.pendingEvents()
		await runtime.closeAdmission()
		const reopened = await ToolExecutionOwner.open({ owner, store })
		assert.deepEqual(await reopened.pendingEvents(), events)
		assert.deepEqual(await admit(reopened, fake(), "late"), { kind: "rejected", reason: "owner_closed" })
		await assert.rejects(ToolExecutionOwner.open({ owner: { ...owner, runId: "other" }, store }), /another owner/)
	})
})
