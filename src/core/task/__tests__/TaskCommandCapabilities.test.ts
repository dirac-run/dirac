import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { TaskCommandCapabilities, isTaskCommandCapabilitySnapshot, type TaskCommandCapabilitySnapshot } from "../TaskCommandCapabilities"
import { DEFAULT_COMMAND_CAPABILITIES } from "../tools/utils/CommandSafetyChecker"

function fixture(initial?: TaskCommandCapabilitySnapshot) {
	let saved = initial
	let writes = 0
	const authority = new TaskCommandCapabilities(async () => initial, async (snapshot) => { saved = structuredClone(snapshot); writes++ })
	return { authority, get saved() { return saved }, get writes() { return writes } }
}

const level = (packed: number, index: number) => (packed >>> (index * 3)) & 7

describe("TaskCommandCapabilities", () => {
	it("starts with the agreed defaults and restores only the same task's committed authority", async () => {
		const root = fixture()
		await root.authority.ready()
		assert.equal(root.authority.current(), DEFAULT_COMMAND_CAPABILITIES)
		const rootOffer = await root.authority.offerApproval(7)
		assert.equal(await rootOffer.approve("allow-filesystem-7"), true)
		const resumed = fixture(root.saved)
		await resumed.authority.ready()
		assert.equal(level(resumed.authority.current(), 0), 7)
		await fixture().authority.ready()
		assert.equal(level(fixture().authority.current(), 0), 3)
	})

	it("shares live authority with existing and future child bindings, not independent roots", async () => {
		const root = fixture()
		const existingChild = root.authority
		await (await existingChild.offerApproval(7)).approve("allow-filesystem-7")
		assert.equal(root.authority.current(), existingChild.current())
		const futureChild = root.authority
		assert.deepEqual((await futureChild.offerApproval(7)).choices.map(({ id }) => id), ["approve", "reject"])
		assert.equal(level(fixture().authority.current(), 0), 3)
	})

	it("orders at most two deficits by mutate/read/use then category, and saves only the selection", async () => {
		const h = fixture()
		const required = 7 | (3 << 3) | (7 << 6) | (1 << 12)
		const offer = await h.authority.offerApproval(required)
		assert.deepEqual(offer.choices.map(({ id }) => id), ["approve", "allow-filesystem-7", "allow-processes-7", "reject"])
		assert.equal(offer.choices[1].label, "Approve + allow filesystem/mutate for this task")
		assert.deepEqual(offer.choices.map(({ category, access }) => ({ category, access })), [
			{ category: undefined, access: undefined },
			{ category: "filesystem", access: "mutate" },
			{ category: "processes", access: "mutate" },
			{ category: undefined, access: undefined },
		])
		await offer.approve("allow-processes-7")
		assert.equal(level(h.authority.current(), 2), 7)
		assert.equal(level(h.authority.current(), 0), 3)
		assert.equal(level(h.authority.current(), 1), 0)
		assert.equal(level(h.authority.current(), 4), 0)
		assert.equal(h.writes, 1)
	})

	it("presents reusable read/use grants without attaching metadata to one-shot choices", async () => {
		const offer = await fixture().authority.offerApproval((1 << 3) | (3 << 12))
		assert.deepEqual(offer.choices, [
			{ id: "approve", label: "Approve this command" },
			{ id: "allow-credentials-3", label: "Approve + allow credentials/read for this task", category: "credentials", access: "read" },
			{ id: "allow-network-1", label: "Approve + allow network/use for this task", category: "network", access: "use" },
			{ id: "reject", label: "Reject" },
		])
		assert.deepEqual((await fixture().authority.offerApproval(-1)).choices, [
			{ id: "approve", label: "Approve this command" },
			{ id: "reject", label: "Reject" },
		])
	})

	it("plain approval and rejection, including unknown, never persist authority", async () => {
		const h = fixture()
		for (const required of [7, -1]) {
			assert.equal(await (await h.authority.offerApproval(required)).approve("approve"), true)
			assert.equal(await (await h.authority.offerApproval(required)).approve("reject"), false)
		}
		assert.deepEqual((await h.authority.offerApproval(-1)).choices.map(({ id }) => id), ["approve", "reject"])
		assert.equal(h.writes, 0)
		assert.equal(h.authority.current(), DEFAULT_COMMAND_CAPABILITIES)
	})

	it("rejects forged choices, omitted third deficits, and repeated resolution", async () => {
		const h = fixture()
		const offer = await h.authority.offerApproval(7 | (3 << 3) | (7 << 6))
		for (const id of ["allow-network-3", "allow-credentials-7", "1073741823", "Approve + allow everything"]) {
			await assert.rejects(offer.approve(id), /not offered/)
		}
		await offer.approve("approve")
		await assert.rejects(offer.approve("allow-filesystem-7"), /already resolved/)
		assert.equal(h.writes, 0)
	})

	it("does not hold a lock across prompts and merges concurrent category commits monotonically", async () => {
		const h = fixture()
		const first = await h.authority.offerApproval(7)
		const second = await h.authority.offerApproval(3 << 3)
		await Promise.all([first.approve("allow-filesystem-7"), second.approve("allow-network-3")])
		assert.equal(level(h.authority.current(), 0), 7)
		assert.equal(level(h.authority.current(), 1), 3)
		assert.equal(h.writes, 2)
	})

	it("does not expose a grant until persistence succeeds and propagates failures", async () => {
		let release!: () => void
		const barrier = new Promise<void>((resolve) => { release = resolve })
		const authority = new TaskCommandCapabilities(async () => undefined, async () => barrier)
		const saving = (await authority.offerApproval(7)).approve("allow-filesystem-7")
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(authority.current(), DEFAULT_COMMAND_CAPABILITIES)
		release()
		await saving
		assert.equal(level(authority.current(), 0), 7)
		const failed = new TaskCommandCapabilities(async () => undefined, async () => { throw new Error("disk failure") })
		await assert.rejects((await failed.offerApproval(7)).approve("allow-filesystem-7"), /disk failure/)
		assert.equal(failed.current(), DEFAULT_COMMAND_CAPABILITIES)
	})

	it("closes grant admission on retirement while draining all accepted commits", async () => {
		let release!: () => void
		const barrier = new Promise<void>((resolve) => { release = resolve })
		const saved: TaskCommandCapabilitySnapshot[] = []
		const authority = new TaskCommandCapabilities(async () => undefined, async (snapshot) => {
			await barrier
			saved.push(snapshot)
		})
		const first = await authority.offerApproval(7)
		const second = await authority.offerApproval(1 << 3)
		const late = await authority.offerApproval(7 << 6)
		const commits = [first.approve("allow-filesystem-7"), second.approve("allow-network-1")]
		const retirement = authority.retirePersistence()
		assert.strictEqual(authority.retirePersistence(), retirement)
		await assert.rejects(authority.offerApproval(7), /retired/)
		await assert.rejects(late.approve("allow-processes-7"), /retired/)
		assert.equal(saved.length, 0)
		release()
		await Promise.all([...commits, retirement])
		assert.equal(saved.length, 2)
		assert.equal(level(authority.current(), 0), 7)
		assert.equal(level(authority.current(), 1), 1)
		assert.equal(level(authority.current(), 2), 3)
	})

	it("fails closed on malformed persisted capability fields", async () => {
		for (const value of [null, {}, { version: 1, capabilities: -1 }, { version: 1, capabilities: 2 }, { version: 1, capabilities: 2 ** 30 }, { version: 2, capabilities: 0 }]) {
			assert.equal(isTaskCommandCapabilitySnapshot(value), false)
			await assert.rejects(new TaskCommandCapabilities(async () => value, async () => { }).ready(), /Invalid/)
		}
	})
})
