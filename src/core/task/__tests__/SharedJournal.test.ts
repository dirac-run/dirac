import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ulid } from "ulid"
import { AgentCommunication, type AgentRosterEntry } from "../AgentCommunication"
import { SharedJournal } from "../SharedJournal"
import type { JournalNotice, JournalRecipient, JournalRecord, SharedJournalCallbacks } from "../SharedJournalTypes"

const counts = { enqueued: 1, skipped_inactive: 1, rejected_capacity: 2 }

describe("SharedJournal root-owned storage", () => {
	let root: string
	beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-journal-")) })
	afterEach(async () => { sinon.restore(); await fs.rm(root, { recursive: true, force: true }) })

	function fixture(overrides: Partial<SharedJournalCallbacks> = {}) {
		const notices: JournalNotice[] = []
		const callbacks: SharedJournalCallbacks = {
			assertActive: (author) => { if (author !== "Feynman" && author !== "Dirac") throw new Error("Inactive author") },
			recipients: () => ["Dirac", "Planck", "Bohr", "Curie"].map((id) => ({ id, generation: 0 })),
			notify: (_recipients, notice) => { notices.push(notice); return counts },
			...overrides,
		}
		const journal = new SharedJournal(root, callbacks)
		return { journal, agent: journal.forAgent("Feynman"), callbacks, notices }
	}

	it("commits one complete record before compact fanout and returns explicit partial counts", async () => {
		const { journal, agent, callbacks, notices } = fixture()
		let committed: JournalRecord | undefined
		const originalNotify = callbacks.notify
		callbacks.notify = (recipients, notice) => {
			assert.deepEqual(recipients, ["Dirac", "Planck", "Bohr", "Curie"].map((id) => ({ id, generation: 0 })))
			// A notification must never advertise a record before its complete file exists.
			committed = JSON.parse(readFileSync(path.join(root, "journal", `${notice.message_id}.json`), "utf8"))
			return originalNotify(recipients, notice)
		}
		const receipt = await agent.publish({ headline: " A finding ", content: " Full body\n " })
		const record = await agent.read({ message_id: receipt.message_id })
		assert.deepEqual(receipt.notifications, counts)
		assert.equal(receipt.published, true)
		assert.deepEqual(Object.keys(record).sort(), ["author", "content", "created_at", "headline", "id", "version"])
		assert.equal(record.author, "Feynman")
		assert.equal(record.version, 1)
		assert.equal(record.headline, " A finding ")
		assert.equal(record.content, " Full body\n ")
		assert.ok(Number.isSafeInteger(record.created_at))
		assert.deepEqual(notices, [{ author: "Feynman", message_id: record.id, headline: record.headline }])
		await journal.close()
		assert.deepEqual(committed, record)
		assert.deepEqual(await fs.readdir(path.join(root, "journal")), [`${record.id}.json`])
	})

	it("surfaces an admitted write failure to both publisher and concurrent shutdown", async () => {
		const failure = new Error("Disk write failed")
		sinon.stub(fs, "mkdir").rejects(failure)
		const { journal, agent, notices } = fixture()
		const publication = agent.publish({ headline: "x", content: "x" })
		const closing = journal.close()
		await assert.rejects(publication, (error) => error === failure)
		await assert.rejects(closing, (error: unknown) => error instanceof AggregateError && error.errors.includes(failure))
		assert.deepEqual(notices, [])
	})

	it("snapshots membership at admission and stores separate immutable files for concurrent publishes", async () => {
		const members: JournalRecipient[] = [{ id: "Dirac", generation: 0 }]
		const targets: (readonly JournalRecipient[])[] = []
		const { agent } = fixture({ recipients: () => members, notify: (recipients) => { targets.push(recipients); return counts } })
		const first = agent.publish({ headline: "First", content: "One" })
		members.push({ id: "Planck", generation: 0 })
		const second = agent.publish({ headline: "Second", content: "Two" })
		const receipts = await Promise.all([first, second])
		assert.notEqual(receipts[0].message_id, receipts[1].message_id)
		assert.deepEqual(targets.map((target) => target.length).sort(), [1, 2])
		assert.equal((await agent.read({ message_id: receipts[0].message_id })).content, "One")
		assert.equal((await fs.readdir(path.join(root, "journal"))).length, 2)
	})

	for (const retired of ["Planck", "Dirac"]) {
		it(`skips a previous ${retired} execution that completes and resumes during storage without delaying completion`, async () => {
			const entries: AgentRosterEntry[] = ["Dirac", "Feynman", "Planck", "Bohr"]
				.map((id) => ({ id, title_preview: id, status: "running", accepts_messages: true }))
			const group = new AgentCommunication(() => entries, () => { })
			const journal = new SharedJournal(root, {
				assertActive: (author) => { group.snapshotRecipients(author) },
				recipients: (author) => group.snapshotRecipients(author),
				notify: (recipients, notice) => group.enqueueJournalNotice(recipients, notice),
			})
			const agent = journal.forAgent("Feynman")
			const bohr = group.snapshotRecipients("Feynman").filter(({ id }) => id === "Bohr")
			for (let i = 0; i < 64; i++) {
				group.enqueueJournalNotice(bohr, { author: "Feynman", message_id: `existing-${i}`, headline: "Existing" })
			}
			let release!: () => void
			let writing!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			const entered = new Promise<void>((resolve) => { writing = resolve })
			const originalRename = fs.rename.bind(fs)
			const rename = sinon.stub(fs, "rename").callsFake(async (...args: Parameters<typeof fs.rename>) => {
				writing()
				await gate
				return originalRename(...args)
			})
			const publication = agent.publish({ headline: "Old execution only", content: "Stored once" })
			await entered
			try {
				// Retirement is synchronous and does not join this publication's blocked write.
				const recipient = entries.find(({ id }) => id === retired)!
				recipient.accepts_messages = false
				group.discard(retired)
				group.discard(retired)
				recipient.accepts_messages = true
				entries.push({ id: "Curie", title_preview: "Late arrival", status: "running", accepts_messages: true })
				assert.equal(group.firstPendingJournalNotice(retired), undefined)
			} finally {
				release()
			}
			const receipt = await publication
			rename.restore()
			assert.deepEqual(receipt.notifications, { enqueued: 1, skipped_inactive: 1, rejected_capacity: 1 })
			assert.equal(group.firstPendingJournalNotice(retired), undefined)
			assert.equal(group.firstPendingJournalNotice("Curie"), undefined, "No backfill to later agents")
			assert.equal(group.firstPendingJournalNotice(retired === "Dirac" ? "Planck" : "Dirac")?.message_id, receipt.message_id)
			assert.equal(group.hasPending(retired), false, "Notices do not become completion-blocking mail")
			assert.equal((await agent.read({ message_id: receipt.message_id })).content, "Stored once")
			const fresh = await agent.publish({ headline: "New execution", content: "Fresh publication" })
			assert.equal(group.firstPendingJournalNotice(retired)?.message_id, fresh.message_id)
			assert.equal(group.firstPendingJournalNotice("Curie")?.message_id, fresh.message_id)
			await journal.close()
		})
	}

	it("rejects blank/oversized UTF-8 fields and escaped oversized records before writing or fanout", async () => {
		const { agent, notices } = fixture()
		for (const input of [
			{ headline: " ", content: "x" }, { headline: "x", content: "\n" },
			{ headline: "é".repeat(129), content: "x" }, { headline: "x", content: "é".repeat(8193) },
			{ headline: "x", content: "x" + "\u0000".repeat(8192) },
		]) await assert.rejects(agent.publish(input))
		assert.deepEqual(notices, [])
		assert.deepEqual(await fs.readdir(root), [])
		const receipt = await agent.publish({ headline: "é".repeat(128), content: "é".repeat(8192) })
		assert.equal((await agent.read({ message_id: receipt.message_id })).content.length, 8192)
	})

	it("rejects invalid IDs, missing/cross-root records, unknown authors and closed admission", async () => {
		const { journal, agent, callbacks } = fixture()
		for (const message_id of ["../escape", "bad", "z".repeat(26), "8".repeat(26)]) await assert.rejects(agent.read({ message_id }), /Invalid journal/)
		await assert.rejects(agent.read({ message_id: ulid() }), /ENOENT/)
		await assert.rejects(journal.forAgent("outsider").publish({ headline: "x", content: "x" }), /Inactive author/)
		const receipt = await agent.publish({ headline: "x", content: "x" })
		const other = new SharedJournal(path.join(root, "other-root"), callbacks)
		await assert.rejects(other.forAgent("Feynman").read({ message_id: receipt.message_id }), /ENOENT/)
		await journal.close()
		await assert.rejects(agent.publish({ headline: "x", content: "x" }), /closed/)
		await assert.rejects(agent.read({ message_id: receipt.message_id }), /closed/)
	})

	it("retains publications on reopen without notification replay", async () => {
		const { journal, agent, callbacks, notices } = fixture()
		const receipt = await agent.publish({ headline: "History", content: "Retained" })
		await journal.close()
		const reopened = new SharedJournal(root, callbacks)
		assert.equal((await reopened.forAgent("Dirac").read({ message_id: receipt.message_id })).content, "Retained")
		assert.equal(notices.length, 1)
		await reopened.close()
	})

	it("does not notify when storage fails", async () => {
		await fs.writeFile(path.join(root, "journal"), "Not a directory")
		const { agent, notices } = fixture()
		await assert.rejects(agent.publish({ headline: "x", content: "x" }))
		assert.deepEqual(notices, [])
	})

	it("keeps a saved entry readable when notification throws, without retrying fanout", async () => {
		let savedId = ""
		const { agent } = fixture({ notify: (_recipients, notice) => { savedId = notice.message_id; throw new Error("Fanout failed") } })
		await assert.rejects(agent.publish({ headline: "x", content: "Stored" }), /Fanout failed/)
		assert.equal((await agent.read({ message_id: savedId })).content, "Stored")
	})

	it("joins an admitted write and blocks new calls while closing", async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const original = fs.mkdir.bind(fs)
		const mkdir = sinon.stub(fs, "mkdir").callsFake(async (...args: Parameters<typeof fs.mkdir>) => { await gate; return original(...args) })
		const { journal, agent } = fixture()
		const publication = agent.publish({ headline: "x", content: "x" })
		const closing = journal.close()
		let settled = false
		void closing.then(() => { settled = true })
		await Promise.resolve()
		assert.equal(settled, false)
		await assert.rejects(agent.publish({ headline: "late", content: "x" }), /closed/)
		release()
		await Promise.all([publication, closing])
		assert.equal(settled, true)
		assert.equal(journal.close(), closing)
		mkdir.restore()
	})

	it("validates persisted version, schema, identity, timestamp and record size", async () => {
		const { agent } = fixture()
		const receipt = await agent.publish({ headline: "x", content: "x" })
		const valid = await agent.read({ message_id: receipt.message_id })
		const file = path.join(root, "journal", `${receipt.message_id}.json`)
		for (const invalid of [null, [], { ...valid, version: 2 }, { ...valid, id: ulid() }, { ...valid, created_at: -1 }, { ...valid, author: " " }, { ...valid, extra: "x" }, { ...valid, content: "" }]) {
			await fs.writeFile(file, JSON.stringify(invalid))
			await assert.rejects(agent.read({ message_id: receipt.message_id }))
		}
		await fs.writeFile(file, "x".repeat(32769))
		await assert.rejects(agent.read({ message_id: receipt.message_id }), /32 KiB/)
		await fs.writeFile(file, "{broken")
		await assert.rejects(agent.read({ message_id: receipt.message_id }), SyntaxError)
	})
})
