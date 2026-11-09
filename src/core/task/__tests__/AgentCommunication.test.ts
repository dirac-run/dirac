import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { AgentCommunication, type AgentRosterEntry } from "../AgentCommunication"

function fixture(count = 2) {
	const entries: AgentRosterEntry[] = ["Dirac", ...Array.from({ length: count }, (_, index) => index ? `Planck ${index}` : "Feynman")]
		.map((id) => ({ id, title_preview: "x".repeat(100), status: "running", accepts_messages: true }))
	let arrivals = 0
	const group = new AgentCommunication(() => entries, () => arrivals++)
	return { group, entries, arrivals: () => arrivals, root: group.forAgent("Dirac"), child: group.forAgent("Feynman") }
}

function payload(block: { text: string }) {
	return JSON.parse(block.text.slice(block.text.indexOf("\n") + 1))
}

describe("Volatile agent communication", () => {
	it("authenticates symmetric root/child/sibling mail, preserves text and isolates groups", async () => {
		const { group, root, child } = fixture()
		const a = await root.send({ to: "Feynman", text: "  hello\n" })
		await child.send({ to: "Dirac", text: "approved" })
		await child.send({ to: "Planck 1", text: "done" })
		assert.deepEqual(payload(group.prepareDelivery("Feynman")!.content[0]), { id: a.message_id, from: "Dirac", to: "Feynman", text: "  hello\n" })
		assert.match(group.prepareDelivery("Dirac")!.content[0].text, /not user input/)
		assert.equal(group.prepareDelivery("Dirac")!.content[0].isUserInput, undefined)
		assert.equal(payload(group.prepareDelivery("Planck 1")!.content[0]).from, "Feynman")
		assert.equal(fixture().group.prepareDelivery("Feynman"), undefined)
	})

	it("rejects exact-address errors, self-send, inactive recipients/senders and collisions", async () => {
		const { group, entries, root, child } = fixture()
		for (const to of ["feynman", " Feynman", "Feynman ", "parent", "unknown"]) {
			await assert.rejects(root.send({ to, text: "hello" }), /Unknown/)
		}
		await assert.rejects(root.send({ to: "Dirac", text: "hello" }), /Self-send/)
		entries[1].accepts_messages = false
		for (const status of ["idle", "settling", "completed", "interrupted", "reconstructed"]) {
			entries[1].status = status
			await assert.rejects(root.send({ to: "Feynman", text: "hello" }), /cannot accept/)
		}
		await assert.rejects(child.send({ to: "Dirac", text: "hello" }), /Sender/)
		entries.push({ ...entries[0] })
		assert.throws(() => root.list(), /collision/)
		await assert.rejects(root.send({ to: "Feynman", text: "hello" }), /collision/)
		assert.equal(group.hasPending("Feynman"), false)
	})

	it("validates UTF-8 payload and serialized single-envelope limits without truncation", async () => {
		const { root, group } = fixture()
		for (const text of ["", " \n", "x".repeat(8193), "é".repeat(4097)]) {
			await assert.rejects(root.send({ to: "Feynman", text }), /8 KiB/)
		}
		await assert.rejects(root.send({ to: "Feynman", text: "\u0001".repeat(8192) }), /Serialized message envelope/)
		const text = "é".repeat(4096)
		await root.send({ to: "Feynman", text })
		assert.equal(payload(group.prepareDelivery("Feynman")!.content[0]).text, text)
	})

	it("enforces recipient count, serialized byte capacity and root capacity", async () => {
		const small = fixture()
		for (let i = 0; i < 64; i++) await small.root.send({ to: "Feynman", text: String(i) })
		await assert.rejects(small.root.send({ to: "Feynman", text: "overflow" }), /capacity/)
		const large = fixture(20)
		for (let i = 0; i < 15; i++) await large.root.send({ to: "Feynman", text: "x".repeat(8192) })
		await assert.rejects(large.root.send({ to: "Feynman", text: "x".repeat(8192) }), /capacity/)
		let accepted = 15
		let exhausted = false
		for (const agent of large.entries.slice(2)) {
			for (let i = 0; i < 15; i++) {
				try {
					await large.root.send({ to: agent.id, text: "x".repeat(8192) })
					accepted++
				} catch (error) {
					assert.match(String(error), /capacity/)
					exhausted = true
					break
				}
			}
			if (exhausted) break
		}
		assert.equal(exhausted, true)
		assert.ok(accepted < 128)
		large.group.discard("Feynman")
		await large.root.send({ to: "Feynman", text: "capacity freed" })
	})

	it("keeps FIFO batches bounded and acknowledges only the selected snapshot", async () => {
		const { group, root, arrivals } = fixture()
		for (let i = 0; i < 10; i++) await root.send({ to: "Feynman", text: String(i) })
		const first = group.prepareDelivery("Feynman")!
		assert.equal(first.content.length, 8)
		assert.deepEqual(first.content.map((block) => payload(block).text), Array.from({ length: 8 }, (_, i) => String(i)))
		assert.equal(group.hasPending("Feynman"), true)
		await root.send({ to: "Feynman", text: "later" })
		await first.acknowledge()
		await first.acknowledge()
		const second = group.prepareDelivery("Feynman")!
		assert.deepEqual(second.content.map((block) => payload(block).text), ["8", "9", "later"])
		await second.acknowledge()
		assert.equal(group.hasPending("Feynman"), false)
		assert.equal(arrivals(), 11)
		for (let i = 0; i < 3; i++) await root.send({ to: "Feynman", text: "x".repeat(8192) })
		assert.equal(group.prepareDelivery("Feynman")!.content.length, 1)
	})

	it("filters pending mail by sender and discards at cancellation/shutdown without replay", async () => {
		const { group, root, child } = fixture()
		const receipt = await child.send({ to: "Dirac", text: "wake" })
		assert.equal(group.firstPending("Dirac", new Set()), undefined)
		assert.equal(group.firstPending("Dirac", new Set(["Planck 1"])), undefined)
		assert.equal(group.firstPending("Dirac", new Set(["Feynman"]))?.id, receipt.message_id)
		group.discard("Dirac")
		assert.equal(group.hasPending("Dirac"), false)
		await root.send({ to: "Feynman", text: "pending" })
		const delivery = group.prepareDelivery("Feynman")!
		group.close()
		await delivery.acknowledge()
		assert.equal(group.hasPending("Feynman"), false)
		assert.equal(group.prepareDelivery("Feynman"), undefined)
		await assert.rejects(root.send({ to: "Feynman", text: "late" }), /closed/)
		assert.ok(root.list().agents.every((agent) => !agent.accepts_messages))
	})

	it("returns bounded passive roster pages and rejects invalid page arguments", async () => {
		const { root, group } = fixture(65)
		const first = root.list()
		assert.equal(first.agents.length, 10)
		assert.equal(first.next_cursor, "10")
		assert.ok(first.agents.every((agent) => agent.title_preview.length <= 80))
		const second = root.list({ cursor: first.next_cursor, limit: 50 })
		assert.equal(second.agents.length, 50)
		assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 16384)
		const last = root.list({ cursor: second.next_cursor })
		assert.equal(last.agents.length, 6)
		assert.equal(last.next_cursor, undefined)
		for (const limit of [0, 51, 1.5]) assert.throws(() => root.list({ limit }), /limit/)
		for (const cursor of ["-1", "1.1", "01", "bad", "1000"]) assert.throws(() => root.list({ cursor }), /cursor/)
		assert.equal(group.hasPending("Dirac"), false)
	})
})
