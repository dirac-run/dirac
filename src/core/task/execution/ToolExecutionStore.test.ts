import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as atomicWrite from "@core/storage/atomicWrite"
import type { ToolExecutionIdentity, ToolExecutionRecord } from "@shared/toolExecution"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import {
	chooseToolExecutionResponse,
	claimToolExecutionCompletion,
	createToolExecution,
	transitionToolExecution,
} from "./ToolExecution"
import { ToolExecutionOwner } from "./ToolExecutionOwner"
import { DiskToolExecutionStore, type ToolExecutionStoreSnapshot } from "./ToolExecutionStore"

const identity: ToolExecutionIdentity = {
	executionId: "execution-1",
	owner: { rootTaskId: "root-1", taskId: "task-1", runId: "run-1" },
	requestId: "request-1",
	nativeToolCallId: "call-1",
	toolName: "read_file",
	toolSnapshot: { requestId: "request-1", inventoryVersion: 2, configurationRevision: 3 },
}

function queued(): ToolExecutionRecord {
	return createToolExecution(identity, { paths: ["file.ts"], options: { recursive: true } })
}

function completed(): ToolExecutionRecord {
	let record = chooseToolExecutionResponse(queued(), [{ type: "text", text: "Accepted" }]).record
	record = transitionToolExecution(record, { kind: "mark_response_committed" })
	record = transitionToolExecution(record, {
		kind: "begin_settling",
		outcome: {
			kind: "success",
			content: [
				{ type: "text", text: "Complete 😀" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
			],
		},
	})
	record = transitionToolExecution(record, { kind: "finish_settling", resourcesSettled: true })
	return claimToolExecutionCompletion(record).record
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("DiskToolExecutionStore", () => {
	let directory: string
	let filePath: string
	let store: DiskToolExecutionStore
	const sandbox = sinon.createSandbox()

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-execution-store-"))
		filePath = path.join(directory, "nested", "owner.json")
		store = new DiskToolExecutionStore(filePath, identity.owner)
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("initializes a missing nested file atomically and reopens its exact owner snapshot", async () => {
		const initial = await store.load()
		assert.deepEqual(initial, {
			schemaVersion: 1,
			revision: 0,
			owner: identity.owner,
			admissionClosed: false,
			records: [],
			acknowledgedEventIds: [],
		})
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), initial)
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), initial)
		assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["owner.json"])
	})

	it("does not create a missing snapshot when committing before the initial load", async () => {
		const next: ToolExecutionStoreSnapshot = {
			schemaVersion: 1,
			revision: 1,
			owner: identity.owner,
			admissionClosed: false,
			records: [queued()],
			acknowledgedEventIds: [],
		}
		await assert.rejects(store.commit(0, next), /snapshot is missing/)
		await assert.rejects(fs.stat(filePath), { code: "ENOENT" })
		assert.equal((await store.load()).revision, 0)
	})

	for (const commitFirst of [false, true]) {
		it(`does not reset a snapshot deleted after ${commitFirst ? "commit" : "load"}`, async () => {
			let current = await store.load()
			if (commitFirst) {
				current = { ...current, revision: 1, records: [queued()] }
				await store.commit(0, current)
			}
			await fs.unlink(filePath)
			await assert.rejects(store.load(), /snapshot was lost after initialization/)
			await assert.rejects(
				store.commit(current.revision, { ...current, revision: current.revision + 1 }),
				/snapshot was lost after initialization/,
			)
			await assert.rejects(fs.stat(filePath), { code: "ENOENT" })
		})
	}

	it("allows repeated null native calls and distinct request/native call pairs", async () => {
		const initial = await store.load()
		const identities = [
			{ ...identity, executionId: "first", nativeToolCallId: null },
			{ ...identity, executionId: "second", nativeToolCallId: null },
			{ ...identity, executionId: "third" },
			{
				...identity,
				executionId: "fourth",
				requestId: "request-2",
				toolSnapshot: { ...identity.toolSnapshot, requestId: "request-2" },
			},
			{ ...identity, executionId: "fifth", nativeToolCallId: "call-2" },
		]
		const next = { ...initial, revision: 1, records: identities.map((id) => createToolExecution(id, {})) }
		await store.commit(0, next)
		assert.deepEqual(await store.load(), next)
	})

	it("persists full multimodal results and stable completion outbox acknowledgements together", async () => {
		const initial = await store.load()
		const record = completed()
		const eventId = record.completionEvent!.eventId
		const pending = { ...initial, revision: 1, records: [record] }
		await store.commit(0, pending)
		const reopened = new DiskToolExecutionStore(filePath, identity.owner)
		assert.deepEqual(await reopened.load(), pending)
		const acknowledged = { ...pending, revision: 2, admissionClosed: true, acknowledgedEventIds: [eventId] }
		await reopened.commit(1, acknowledged)
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), acknowledged)
	})

	it("does not share constructor, commit, queued commit, or load objects with callers", async () => {
		const owner = { ...identity.owner }
		store = new DiskToolExecutionStore(filePath, owner)
		owner.runId = "mutated"
		const initial = await store.load()
		const next = {
			...initial,
			revision: 1,
			owner: { ...identity.owner },
			records: [queued()],
			acknowledgedEventIds: [] as string[],
		}
		const committing = store.commit(0, next)
		next.owner.runId = "changed-after-commit-call"
		next.records.length = 0
		next.acknowledgedEventIds.push("changed")
		await committing
		const loaded = await store.load()
		assert.equal(loaded.owner.runId, identity.owner.runId)
		assert.equal(loaded.records.length, 1)
		assert.deepEqual(loaded.acknowledgedEventIds, [])
		assert.notEqual(loaded.records[0].arguments, (await store.load()).records[0].arguments)
		const mutableCopy = loaded as Mutable<ToolExecutionStoreSnapshot>
		mutableCopy.owner.runId = "mutated-load"
		mutableCopy.records.length = 0
		mutableCopy.acknowledgedEventIds.push("mutated-load")
		assert.equal((await store.load()).records.length, 1)
		assert.equal((await store.load()).owner.runId, identity.owner.runId)
		assert.deepEqual((await store.load()).acknowledgedEventIds, [])
	})

	it("allows exactly one competing CAS and keeps the queue usable after rejection", async () => {
		const initial = await store.load()
		const results = await Promise.allSettled([
			store.commit(0, { ...initial, revision: 1, records: [queued()] }),
			store.commit(0, { ...initial, revision: 1, admissionClosed: true }),
		])
		assert.equal(results[0].status, "fulfilled")
		assert.equal(results[1].status, "rejected")
		if (results[1].status === "rejected") assert.match(String(results[1].reason), /revision conflict/)
		const current = await store.load()
		assert.equal(current.admissionClosed, false)
		assert.equal(current.records.length, 1)
		await store.commit(1, { ...current, revision: 2, admissionClosed: true })
		assert.equal((await store.load()).revision, 2)
	})

	it("serializes loads behind atomic commits rather than exposing uncommitted snapshots", async () => {
		const initial = await store.load()
		const entered = deferred()
		const release = deferred()
		const original = atomicWrite.atomicWriteFile
		sandbox.stub(atomicWrite, "atomicWriteFile").callsFake(async (...args) => {
			entered.resolve()
			await release.promise
			await original(...args)
		})
		const committing = store.commit(0, { ...initial, revision: 1, admissionClosed: true })
		await entered.promise
		assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).revision, 0)
		let loaded = false
		const loading = store.load().then((snapshot) => {
			loaded = true
			return snapshot
		})
		await Promise.resolve()
		assert.equal(loaded, false)
		release.resolve()
		await committing
		assert.equal((await loading).revision, 1)
	})

	it("rejects invalid expected or next revisions without modifying the file", async () => {
		const initial = await store.load()
		for (const [expected, next] of [
			[-1, 0],
			[0.5, 1],
			[Number.NaN, 1],
			[0, 0],
			[0, 2],
			[0, 1.5],
			[0, Number.MAX_SAFE_INTEGER + 1],
		]) {
			await assert.rejects(store.commit(expected, { ...initial, revision: next }))
		}
		assert.deepEqual(await store.load(), initial)
	})

	it("propagates initialization write failures and can retry without an in-memory phantom snapshot", async () => {
		const write = sandbox.stub(atomicWrite, "atomicWriteFile").rejects(new Error("initial write failed"))
		await assert.rejects(store.load(), /initial write failed/)
		await assert.rejects(fs.stat(filePath), { code: "ENOENT" })
		write.restore()
		assert.equal((await store.load()).revision, 0)
	})

	it("propagates atomic commit failures and leaves the previous revision retryable", async () => {
		const initial = await store.load()
		const next = { ...initial, revision: 1, records: [queued()] }
		const write = sandbox.stub(atomicWrite, "atomicWriteFile").rejects(new Error("commit write failed"))
		await assert.rejects(store.commit(0, next), /commit write failed/)
		assert.deepEqual(await store.load(), initial)
		write.restore()
		await store.commit(0, next)
		assert.deepEqual(await store.load(), next)
	})

	it("propagates filesystem read failures instead of treating them as absent snapshots", async () => {
		await fs.mkdir(filePath, { recursive: true })
		await assert.rejects(store.load(), { code: "EISDIR" })
		assert.equal((await fs.stat(filePath)).isDirectory(), true)
	})

	it("rejects an existing owner mismatch for each root/task/run identity component", async () => {
		await store.load()
		for (const key of ["rootTaskId", "taskId", "runId"] as const) {
			await assert.rejects(
				new DiskToolExecutionStore(filePath, { ...identity.owner, [key]: "other" }).load(),
				/owner mismatch/,
			)
		}
		assert.throws(() => new DiskToolExecutionStore(filePath, { ...identity.owner, runId: "" }))
	})

	it("does not overwrite corrupt JSON or an unsupported schema with an empty snapshot", async () => {
		await store.load()
		for (const contents of ["{broken", "null", JSON.stringify({ ...(await store.load()), schemaVersion: 2 })]) {
			await fs.writeFile(filePath, contents)
			await assert.rejects(store.load())
			assert.equal(await fs.readFile(filePath, "utf8"), contents)
		}
	})

	it("rejects duplicate nonnull request/native call identities on commit and reopen", async () => {
		const initial = await store.load()
		const invalid = {
			...initial,
			revision: 1,
			records: [queued(), createToolExecution({ ...identity, executionId: "second" }, {})],
		}
		await assert.rejects(store.commit(0, invalid), /Duplicate tool execution native call identity/)
		assert.deepEqual(await store.load(), initial)
		await fs.writeFile(filePath, JSON.stringify(invalid))
		await assert.rejects(
			new DiskToolExecutionStore(filePath, identity.owner).load(),
			/Duplicate tool execution native call identity/,
		)
	})

	const corruptions: readonly [string, (snapshot: ReturnType<typeof mutableSnapshot>) => void][] = [
		[
			"snapshot owner",
			(s) => {
				s.owner.runId = "other"
			},
		],
		[
			"record owner",
			(s) => {
				s.records[0].identity.owner.taskId = "other"
			},
		],
		[
			"request snapshot",
			(s) => {
				s.records[0].identity.toolSnapshot.requestId = "other"
			},
		],
		[
			"duplicate execution",
			(s) => {
				s.records.push(structuredClone(s.records[0]))
			},
		],
		[
			"negative record revision",
			(s) => {
				s.records[0].revision = -1
			},
		],
		[
			"invalid state",
			(s) => {
				Object.assign(s.records[0].state, { kind: "unknown" })
			},
		],
		[
			"invalid running history",
			(s) => {
				Object.assign(s.records[0], { state: { kind: "running" }, hasStarted: false })
			},
		],
		[
			"committed absent response",
			(s) => {
				s.records[0].originalResponse = null
			},
		],
		[
			"response identity",
			(s) => {
				s.records[0].originalResponse!.executionId = "other"
			},
		],
		[
			"outbox identity",
			(s) => {
				s.records[0].completionEvent!.identity.executionId = "other"
			},
		],
		[
			"outbox event key",
			(s) => {
				s.records[0].completionEvent!.eventId = "other"
			},
		],
		[
			"outbox terminal outcome",
			(s) => {
				s.records[0].completionEvent!.outcome = { kind: "cancelled", reason: "other" }
			},
		],
		[
			"unknown acknowledgement",
			(s) => {
				s.acknowledgedEventIds = ["unknown"]
			},
		],
		[
			"duplicate acknowledgement",
			(s) => {
				const id = s.records[0].completionEvent!.eventId
				s.acknowledgedEventIds = [id, id]
			},
		],
		[
			"unknown schema field",
			(s) => {
				Object.assign(s, { unexpected: true })
			},
		],
	]
	for (const [name, corrupt] of corruptions) {
		it(`rejects ${name} on load and commit without rewriting corrupted data`, async () => {
			const initial = await store.load()
			const invalid = mutableSnapshot({ ...initial, revision: 1, records: [completed()] })
			corrupt(invalid)
			await assert.rejects(store.commit(0, invalid))
			assert.deepEqual(await store.load(), initial)
			const contents = JSON.stringify(invalid)
			await fs.writeFile(filePath, contents)
			await assert.rejects(store.load())
			await assert.rejects(store.commit(0, { ...initial, revision: 1 }))
			assert.equal(await fs.readFile(filePath, "utf8"), contents)
		})
	}

	it("migrates a nonzero legacy snapshot and preserves subsequent snapshot commits", async () => {
		const initial = await store.load()
		const legacy = { ...initial, revision: 1, records: [completed()] }
		await store.commit(0, legacy)
		const eventId = legacy.records[0].completionEvent!.eventId
		await store.commitUpdate(1, { admissionClosed: true, acknowledgeEventIds: [eventId] })
		const migrated = { ...legacy, revision: 2, admissionClosed: true, acknowledgedEventIds: [eventId] }
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), migrated)
		await store.commit(2, { ...migrated, revision: 3, admissionClosed: false })
		await store.commitUpdate(3, { admissionClosed: true })
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), { ...migrated, revision: 4 })
	})

	it("captures incremental caller data before queuing and isolates loaded results", async () => {
		await store.load()
		const records = [queued()]
		const update = { records, acknowledgeEventIds: [] as string[] }
		const committing = store.commitUpdate(0, update)
		;(records[0].arguments as { paths: string[] }).paths.push("mutated")
		records.length = 0
		update.acknowledgeEventIds.push("invalid")
		await committing
		const loaded = await store.load()
		assert.deepEqual(loaded.records[0].arguments, queued().arguments)
		;(loaded.records[0].arguments as { paths: string[] }).paths.push("mutated load")
		assert.deepEqual((await store.load()).records[0].arguments, queued().arguments)
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), await store.load())
	})

	it("enforces incremental CAS, revision bounds, and load-before-commit", async () => {
		await assert.rejects(store.commitUpdate(0, {}), /snapshot is missing/)
		await store.load()
		for (const expected of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
			await assert.rejects(store.commitUpdate(expected, {}))
		}
		const results = await Promise.allSettled([
			store.commitUpdate(0, { records: [queued()] }),
			store.commitUpdate(0, { admissionClosed: true }),
		])
		assert.equal(results[0].status, "fulfilled")
		assert.equal(results[1].status, "rejected")
		if (results[1].status === "rejected") assert.match(String(results[1].reason), /revision conflict/)
		assert.equal((await store.load()).admissionClosed, false)
		await store.commitUpdate(1, { admissionClosed: true })
		assert.equal((await store.load()).revision, 2)
	})

	for (const failedFile of ["base-0.json", "1.json", "head"] as const) {
		it(`recovers and retries after an incremental ${failedFile} write failure without publishing an orphan`, async () => {
			const initial = await store.load()
			const original = atomicWrite.atomicWriteFile
			const write = sandbox.stub(atomicWrite, "atomicWriteFile").callsFake(async (target, data) => {
				if (target === (failedFile === "head" ? filePath : path.join(`${filePath}.transactions`, failedFile))) {
					throw new Error("incremental write failed")
				}
				await original(target, data)
			})
			await assert.rejects(store.commitUpdate(0, { records: [completed()] }), /incremental write failed/)
			assert.deepEqual(await store.load(), initial)
			assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), initial)
			write.restore()
			// Reuse the uncommitted revision with different data, not the orphan outcome.
			await store.commitUpdate(0, { records: [queued()] })
			const committed = await fs.readFile(path.join(`${filePath}.transactions`, "1.json"), "utf8")
			assert.deepEqual((await new DiskToolExecutionStore(filePath, identity.owner).load()).records, [queued()])
			await assert.rejects(store.commitUpdate(0, { records: [completed()] }), /revision conflict/)
			await store.commitUpdate(1, { admissionClosed: true })
			assert.equal(await fs.readFile(path.join(`${filePath}.transactions`, "1.json"), "utf8"), committed)
		})
	}

	it("atomically commits terminal state and outbox while a failed acknowledgement remains pending", async () => {
		await store.load()
		await store.commitUpdate(0, { records: [completed()] })
		const original = atomicWrite.atomicWriteFile
		const write = sandbox.stub(atomicWrite, "atomicWriteFile").callsFake(async (target, data) => {
			if (target === filePath) throw new Error("head failed")
			await original(target, data)
		})
		const eventId = completed().completionEvent!.eventId
		await assert.rejects(store.commitUpdate(1, { acknowledgeEventIds: [eventId] }), /head failed/)
		const recovered = new DiskToolExecutionStore(filePath, identity.owner)
		const pending = await recovered.load()
		assert.equal(pending.records[0].state.kind, "terminal")
		assert.equal(pending.records[0].completionEvent!.eventId, eventId)
		assert.deepEqual(pending.acknowledgedEventIds, [])
		write.restore()
		await recovered.commitUpdate(1, { acknowledgeEventIds: [eventId] })
		assert.deepEqual((await new DiskToolExecutionStore(filePath, identity.owner).load()).acknowledgedEventIds, [eventId])
	})

	it("rejects missing, corrupt, or mismatched committed journal entries on recovery", async () => {
		await store.load()
		await store.commitUpdate(0, { records: [queued()] })
		const transactionPath = path.join(`${filePath}.transactions`, "1.json")
		const committed = await fs.readFile(transactionPath, "utf8")
		await fs.unlink(transactionPath)
		await assert.rejects(new DiskToolExecutionStore(filePath, identity.owner).load(), { code: "ENOENT" })
		for (const content of [
			"{bad",
			JSON.stringify({ ...JSON.parse(committed), revision: 2 }),
			JSON.stringify({ revision: 1, acknowledgeEventIds: ["unknown"] }),
			JSON.stringify({ ...JSON.parse(committed), admissionClosed: true }),
		]) {
			await fs.writeFile(transactionPath, content)
			await assert.rejects(new DiskToolExecutionStore(filePath, identity.owner).load())
		}
		await fs.writeFile(transactionPath, committed)
		assert.deepEqual((await new DiskToolExecutionStore(filePath, identity.owner).load()).records, [queued()])
	})

	it("detects baseline and intermediate transaction corruption through the committed hash chain", async () => {
		await store.load()
		await store.commitUpdate(0, { records: [queued()] })
		await store.commitUpdate(1, { admissionClosed: true })
		for (const file of ["base-0.json", "1.json"]) {
			const target = path.join(`${filePath}.transactions`, file)
			const original = await fs.readFile(target, "utf8")
			await fs.writeFile(target, JSON.stringify({ ...JSON.parse(original), admissionClosed: true }))
			await assert.rejects(new DiskToolExecutionStore(filePath, identity.owner).load(), /hash mismatch/)
			await fs.writeFile(target, original)
		}
		assert.equal((await new DiskToolExecutionStore(filePath, identity.owner).load()).revision, 2)
	})

	it("publishes no incremental snapshot until the transaction's head commit completes", async () => {
		const initial = await store.load()
		const entered = deferred()
		const release = deferred()
		const original = atomicWrite.atomicWriteFile
		sandbox.stub(atomicWrite, "atomicWriteFile").callsFake(async (target, data) => {
			if (target === filePath) {
				entered.resolve()
				await release.promise
			}
			await original(target, data)
		})
		const committing = store.commitUpdate(0, { records: [completed()] })
		await entered.promise
		assert.deepEqual(await new DiskToolExecutionStore(filePath, identity.owner).load(), initial)
		let loaded = false
		const loading = store.load().then((snapshot) => {
			loaded = true
			return snapshot
		})
		await Promise.resolve()
		assert.equal(loaded, false)
		release.resolve()
		await committing
		assert.deepEqual((await loading).records, [completed()])
	})

	it("recovers committed incremental admissions without replaying queued or started operations", async () => {
		await store.load()
		const queuedIdentity = { ...identity, executionId: "queued", nativeToolCallId: "queued-call" }
		const runningIdentity = { ...identity, executionId: "running", nativeToolCallId: "running-call" }
		await store.commitUpdate(0, {
			records: [
				completed(),
				createToolExecution(queuedIdentity, {}),
				transitionToolExecution(createToolExecution(runningIdentity, {}), { kind: "start" }),
			],
		})
		const runtime = await ToolExecutionOwner.open({
			owner: identity.owner,
			store: new DiskToolExecutionStore(filePath, identity.owner),
		})
		assert.equal((await runtime.inspectRaw("queued")).state.kind, "terminal")
		const running = await runtime.inspectRaw("running")
		assert.equal(running.state.kind, "settling")
		if (running.state.kind === "settling")
			assert.equal(running.state.settlementError?.code, "RESOURCE_RECONCILIATION_REQUIRED")
		let runs = 0
		for (const id of [queuedIdentity, runningIdentity]) {
			const admission = await runtime.admit({
				identity: id,
				arguments: {},
				operation: {
					async run() {
						runs++
						return { kind: "success", content: "unexpected replay" }
					},
					async cleanup() {},
				},
			})
			assert.deepEqual(admission, { kind: "admitted", executionId: id.executionId, replayed: true })
		}
		assert.equal(runs, 0)
		assert.deepEqual(
			(await runtime.pendingEvents()).map((event) => event.eventId),
			[completed().completionEvent!.eventId],
		)
		await runtime.reconcileInterrupted("running", { resourcesSettled: true })
		assert.equal((await runtime.inspectRaw("running")).state.kind, "terminal")
	})

	it("validates changed records against retained identities and acknowledged outbox entries", async () => {
		await store.load()
		await store.commitUpdate(0, { records: [completed()] })
		const eventId = completed().completionEvent!.eventId
		await store.commitUpdate(1, { acknowledgeEventIds: [eventId] })
		await assert.rejects(
			store.commitUpdate(2, { records: [createToolExecution({ ...identity, executionId: "duplicate-native" }, {})] }),
			/Duplicate tool execution native call identity/,
		)
		await assert.rejects(store.commitUpdate(2, { records: [queued()] }), /Acknowledgement has no completion outbox entry/)
		await assert.rejects(store.commitUpdate(2, { records: [queued(), queued()] }), /Duplicate tool execution identity/)
		await assert.rejects(
			store.commitUpdate(2, { acknowledgeEventIds: ["unknown"] }),
			/Acknowledgement has no completion outbox entry/,
		)
		assert.equal((await store.load()).revision, 2)
	})

	it("bounds persisted and read bytes per sequential execution independent of retained output history", async () => {
		let writtenBytes = 0
		let readBytes = 0
		const originalWrite = atomicWrite.atomicWriteFile
		const originalRead = fs.readFile.bind(fs)
		sandbox.stub(atomicWrite, "atomicWriteFile").callsFake(async (target, data) => {
			writtenBytes += Buffer.byteLength(data)
			await originalWrite(target, data)
		})
		sandbox.stub(fs, "readFile").callsFake((async (...args: Parameters<typeof fs.readFile>) => {
			const data = await originalRead(...args)
			readBytes += Buffer.byteLength(data)
			return data
		}) as typeof fs.readFile)
		const runtime = await ToolExecutionOwner.open({
			owner: identity.owner,
			store,
			capacity: { maxOwnedWork: 1, maxRunningWork: 1, maxWaitingObservers: 1 },
		})
		let firstHalfWrites = 0
		let firstHalfReads = 0
		for (let index = 0; index < 80; index++) {
			const done = deferred()
			const id = { ...identity, executionId: `execution-${index}`, nativeToolCallId: `call-${index}` }
			await runtime.admit({
				identity: id,
				arguments: {},
				operation: {
					async run() {
						await done.promise
						return { kind: "success", content: "x".repeat(4096) }
					},
					async cleanup() {},
				},
			})
			await runtime.chooseResponse(id.executionId, "accepted")
			await runtime.markResponseCommitted(id.executionId)
			done.resolve()
			await runtime.join(id.executionId)
			await runtime.acknowledgeEvents((await runtime.pendingEvents()).map((event) => event.eventId))
			if (index === 39) {
				firstHalfWrites = writtenBytes
				firstHalfReads = readBytes
			}
		}
		assert.ok(writtenBytes - firstHalfWrites < firstHalfWrites * 1.1, `${firstHalfWrites} -> ${writtenBytes} write bytes`)
		assert.ok(readBytes - firstHalfReads < firstHalfReads * 1.1, `${firstHalfReads} -> ${readBytes} read bytes`)
		assert.ok(writtenBytes < 80 * 20_000, `${writtenBytes} bytes exceeded bounded per-execution writes`)
		const recovered = await ToolExecutionOwner.open({
			owner: identity.owner,
			store: new DiskToolExecutionStore(filePath, identity.owner),
		})
		assert.equal((await recovered.inspectRaw("execution-79")).state.kind, "terminal")
		assert.deepEqual(await recovered.pendingEvents(), [])
	}).timeout(20_000)

	it("rejects nonfinite argument data instead of silently converting it to null", async () => {
		const initial = await store.load()
		await assert.rejects(
			store.commit(0, { ...initial, revision: 1, records: [{ ...queued(), arguments: { bad: Number.NaN } }] }),
		)
		assert.deepEqual(await store.load(), initial)
	})
})

type Mutable<T, Depth extends 0[] = []> = Depth["length"] extends 8
	? T
	: T extends object
		? { -readonly [K in keyof T]: Mutable<T[K], [...Depth, 0]> }
		: T
function mutableSnapshot(snapshot: ToolExecutionStoreSnapshot): Mutable<ToolExecutionStoreSnapshot> {
	return structuredClone(snapshot) as Mutable<ToolExecutionStoreSnapshot>
}
