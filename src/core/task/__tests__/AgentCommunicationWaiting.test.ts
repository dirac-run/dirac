import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { AgentCommunication, type AgentRosterEntry } from "../AgentCommunication"
import type { JournalNotice } from "../SharedJournalTypes"

function fixture(onWaitStarted: (id: string) => void = () => {}, count = 2) {
	const entries: AgentRosterEntry[] = ["Dirac", ...Array.from({ length: count }, (_, i) => `child-${i}`)]
		.map((id) => ({ id, title_preview: id, status: "running", accepts_messages: true }))
	const group = new AgentCommunication(() => entries, () => {}, onWaitStarted)
	const cancellation = new AbortController()
	let structured = false
	let guidance = false
	const waiter = group.forWaiter("child-0", {
		signal: cancellation.signal,
		hasPendingInteraction: () => structured,
		hasPendingGuidance: () => guidance,
	})
	const enqueueNotice = (id: string, notice: JournalNotice) => group.enqueueJournalNotice(
		group.snapshotRecipients(notice.author).filter((recipient) => recipient.id === id), notice,
	)
	return {
		group, entries, cancellation, waiter, enqueueNotice,
		setStructured: (value: boolean) => { structured = value },
		setGuidance: (value: boolean) => { guidance = value },
	}
}

const notice = (id: number) => ({ author: "Dirac", message_id: `publication-${id}`, headline: "A compact finding" })

describe("Agent communication waits and journal notices", () => {
	afterEach(() => sinon.restore())

	it("registers before the start-wait notification and wakes without consuming mail", async () => {
		let f: ReturnType<typeof fixture>
		f = fixture((id) => {
			assert.equal(f.group.isWaiting(id), true)
			void f.group.forAgent("Dirac").send({ to: id, text: "arrived during registration" })
		})
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
		assert.equal(f.group.isWaiting("child-0"), false)
		assert.equal(f.group.hasPending("child-0"), true)
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
	})

	it("returns for unconsumed guidance accepted before wait registration without retaining a stale wake", async () => {
		const clock = sinon.useFakeTimers()
		let starts = 0
		const f = fixture(() => { starts++ })
		// Guidance may arrive during a provider response or asynchronous wait-card creation.
		f.setGuidance(true)
		f.group.notifyControl("child-0")
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
		assert.equal(starts, 0)
		assert.equal(f.group.isWaiting("child-0"), false)
		// The pending check is authoritative and does not consume the queued guidance.
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
		f.setGuidance(false)
		const next = f.waiter.wait({ timeout_ms: 1000 })
		assert.equal(starts, 1)
		assert.equal(f.group.isWaiting("child-0"), true)
		await clock.tickAsync(1000)
		assert.deepEqual(await next, { reason: "timeout" })
		await assert.rejects(f.waiter.wait(), /fresh inbound/)
	})

	it("checks/registers synchronously and wakes on guidance accepted at registration", async () => {
		let f: ReturnType<typeof fixture>
		f = fixture((id) => {
			assert.equal(f.group.isWaiting(id), true)
			f.setGuidance(true)
			f.group.notifyControl(id)
		})
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
		assert.equal(f.group.isWaiting("child-0"), false)
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
	})

	it("does not use consumed guidance as a queued wake token", async () => {
		const clock = sinon.useFakeTimers()
		const f = fixture()
		f.setGuidance(true)
		f.group.notifyControl("child-0")
		f.setGuidance(false)
		const wait = f.waiter.wait({ timeout_ms: 1000 })
		assert.equal(f.group.isWaiting("child-0"), true)
		await clock.tickAsync(1000)
		assert.deepEqual(await wait, { reason: "timeout" })
	})

	it("uses the default deadline and prevents another timeout-only wait until fresh input", async () => {
		const clock = sinon.useFakeTimers()
		const f = fixture()
		const wait = f.waiter.wait()
		await clock.tickAsync(29_999)
		assert.equal(f.group.isWaiting("child-0"), true)
		await clock.tickAsync(1)
		assert.deepEqual(await wait, { reason: "timeout" })
		await assert.rejects(f.waiter.wait(), /fresh inbound/)
		// Merely observing old queued state must not reset the timeout guard.
		f.setGuidance(true)
		await assert.rejects(f.waiter.wait(), /fresh inbound/)
		f.group.notifyControl("child-0")
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
		f.setGuidance(false)
		const next = f.waiter.wait({ timeout_ms: 1000 })
		await clock.tickAsync(1000)
		assert.deepEqual(await next, { reason: "timeout" })
		f.enqueueNotice("child-0", notice(1))
		assert.deepEqual(await f.waiter.wait(), { reason: "message" })
	})

	it("validates bounds and rejects roots, inactive agents, duplicate waits, and structured input", async () => {
		const f = fixture()
		for (const timeout_ms of [0, 999, 1000.5, 300001, NaN]) {
			await assert.rejects(f.waiter.wait({ timeout_ms }), /timeout_ms/)
		}
		await assert.rejects(f.group.forWaiter("Dirac", {
			signal: f.cancellation.signal, hasPendingInteraction: () => false, hasPendingGuidance: () => false,
		}).wait(), /Only child/)
		f.entries[1].accepts_messages = false
		await assert.rejects(f.waiter.wait(), /Only active/)
		f.entries[1].accepts_messages = true
		f.setStructured(true)
		f.setGuidance(true)
		f.group.notifyControl("child-0")
		await f.group.forAgent("Dirac").send({ to: "child-0", text: "not an answer" })
		f.enqueueNotice("child-0", notice(1))
		await assert.rejects(f.waiter.wait(), /structured interaction/)
		f.setStructured(false)
		f.setGuidance(false)
		await f.group.prepareDelivery("child-0")!.acknowledge()
		await f.group.prepareJournalDelivery("child-0")!.acknowledge()
		const pending = f.waiter.wait()
		await assert.rejects(f.waiter.wait(), /already waiting/)
		f.cancellation.abort()
		assert.deepEqual(await pending, { reason: "cancelled" })
		assert.deepEqual(await f.waiter.wait(), { reason: "cancelled" })
	})

	it("cancels waiters on discard and shutdown and starts fresh after explicit admission", async () => {
		const f = fixture()
		const first = f.waiter.wait()
		f.group.discard("child-0")
		assert.deepEqual(await first, { reason: "cancelled" })
		const next = f.waiter.wait()
		f.group.close()
		assert.deepEqual(await next, { reason: "cancelled" })
		assert.equal(f.group.isWaiting("child-0"), false)
		assert.deepEqual(await f.waiter.wait(), { reason: "cancelled" })
	})

	it("snapshots only other active agents and distinguishes post-write inactive/capacity outcomes", () => {
		const f = fixture()
		assert.deepEqual(f.group.snapshotRecipients("Dirac"), [{ id: "child-0", generation: 0 }, { id: "child-1", generation: 0 }])
		const recipients = f.group.snapshotRecipients("child-0")
		f.entries[2].accepts_messages = false
		assert.deepEqual(f.group.enqueueJournalNotice(recipients, notice(1)), { enqueued: 1, skipped_inactive: 1, rejected_capacity: 0 })
		assert.equal(f.group.firstPendingJournalNotice("Dirac")?.headline, notice(1).headline)
		assert.equal(f.group.firstPendingJournalNotice("Dirac", new Set()), undefined)
		assert.equal(f.group.hasPending("Dirac"), false, "Headlines do not block normal completion")
		f.group.close()
		assert.deepEqual(f.group.enqueueJournalNotice(recipients, notice(2)), { enqueued: 0, skipped_inactive: 2, rejected_capacity: 0 })
	})

	it("invalidates snapshots across completion and explicit resume without changing addresses", () => {
		const f = fixture()
		const old = f.group.snapshotRecipients("Dirac")
		f.group.discard("child-0")
		f.group.discard("child-0") // Completion and settlement may both retire the same execution.
		assert.equal(f.entries[1].accepts_messages, true, "The resumed execution is active at enqueue")
		assert.deepEqual(f.group.enqueueJournalNotice(old, notice(1)), { enqueued: 1, skipped_inactive: 1, rejected_capacity: 0 })
		assert.equal(f.group.firstPendingJournalNotice("child-0"), undefined)
		assert.equal(f.group.firstPendingJournalNotice("child-1")?.message_id, "publication-1")
		assert.deepEqual(f.enqueueNotice("child-0", notice(2)), { enqueued: 1, skipped_inactive: 0, rejected_capacity: 0 })
		assert.equal(f.group.firstPendingJournalNotice("child-0")?.message_id, "publication-2")
	})

	it("invalidates root snapshots at standalone completion before follow-up and never adds later agents", () => {
		const f = fixture()
		const old = f.group.snapshotRecipients("child-0")
		f.group.discard("Dirac")
		f.entries.push({ id: "later", title_preview: "later", status: "running", accepts_messages: true })
		assert.deepEqual(f.group.enqueueJournalNotice(old, notice(1)), { enqueued: 1, skipped_inactive: 1, rejected_capacity: 0 })
		assert.equal(f.group.firstPendingJournalNotice("Dirac"), undefined)
		assert.equal(f.group.firstPendingJournalNotice("later"), undefined)
		const fresh = f.group.snapshotRecipients("child-0")
		assert.deepEqual(f.group.enqueueJournalNotice(fresh, notice(2)), { enqueued: 3, skipped_inactive: 0, rejected_capacity: 0 })
		assert.equal(f.group.firstPendingJournalNotice("Dirac")?.message_id, "publication-2")
	})

	it("wakes children for headlines and parent controls without consuming their queues", async () => {
		const f = fixture()
		const first = f.waiter.wait()
		f.enqueueNotice("child-0", notice(1))
		assert.deepEqual(await first, { reason: "message" })
		assert.ok(f.group.firstPendingJournalNotice("child-0"))
		await f.group.prepareJournalDelivery("child-0")!.acknowledge()
		const second = f.waiter.wait()
		f.group.notifyControl("child-0")
		assert.deepEqual(await second, { reason: "message" })
	})

	it("enforces count, per-recipient bytes, and aggregate notice capacity without eviction", () => {
		const f = fixture(undefined, 20)
		for (let i = 0; i < 64; i++) assert.equal(f.enqueueNotice("child-0", notice(i)).enqueued, 1)
		assert.equal(f.enqueueNotice("child-0", notice(65)).rejected_capacity, 1)
		assert.equal(f.group.firstPendingJournalNotice("child-0")?.message_id, "publication-0")
		const large = { ...notice(100), headline: "\u0001".repeat(256) }
		let rejected = false
		for (let i = 0; i < 64; i++) {
			if (f.enqueueNotice("child-1", { ...large, message_id: String(i) }).rejected_capacity) {
				rejected = true
				break
			}
		}
		assert.equal(rejected, true)
		let rootRejected = false
		for (let i = 2; i < 20 && !rootRejected; i++) {
			const initial = f.enqueueNotice(`child-${i}`, large)
			if (initial.rejected_capacity) rootRejected = true
			for (let j = 1; j < 20 && !rootRejected; j++) f.enqueueNotice(`child-${i}`, { ...large, message_id: `${i}-${j}` })
		}
		assert.equal(rootRejected, true)
		f.group.discard("child-1")
		assert.equal(f.enqueueNotice("child-1", notice(200)).enqueued, 1)
	})

	it("shares the delivery budget direct-first, bounds notice FIFO, and acknowledges only a snapshot", async () => {
		const f = fixture()
		for (let i = 0; i < 2; i++) await f.group.forAgent("Dirac").send({ to: "child-0", text: "x".repeat(8000) })
		for (let i = 0; i < 10; i++) f.enqueueNotice("child-0", { ...notice(i), headline: "h".repeat(256) })
		const direct = f.group.prepareDelivery("child-0")!
		assert.equal(direct.content.length, 2)
		assert.equal(f.group.prepareJournalDelivery("child-0", direct.remainingBytes), undefined)
		await direct.acknowledge()
		const notices = f.group.prepareJournalDelivery("child-0")!
		assert.equal(notices.content.length, 8)
		assert.deepEqual(notices.content.map((block) => block.journalNotificationIds), Array.from({ length: 8 }, (_, i) => [`publication-${i}`]))
		assert.equal(notices.content[0].isUserInput, undefined)
		f.enqueueNotice("child-0", notice(10))
		await notices.acknowledge()
		await notices.acknowledge()
		assert.equal(f.group.prepareJournalDelivery("child-0")!.content.length, 3)
		f.group.discard("child-0")
		assert.equal(f.group.prepareJournalDelivery("child-0"), undefined)
	})
})
