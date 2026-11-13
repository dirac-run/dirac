import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { TaskletCommandApprovals, isCommandGrantSnapshot } from "../TaskletCommandApprovals"
import type { CommandApprovalRequest, CommandGrantSnapshot } from "../tools/interfaces/CommandApprovals"

const command = (text = "npm test"): CommandApprovalRequest => ({
	identity: { kind: "command", command: text, cwd: "/workspace" }, effectiveCommand: text,
})
function fixture(initial?: CommandGrantSnapshot) {
	let restrictions: string[] = []
	let active = true
	const approvals = new TaskletCommandApprovals(initial, () => restrictions, () => { if (!active) throw new Error("inactive") })
	return { approvals, setRestrictions: (next: string[]) => { restrictions = next }, stop: () => { active = false } }
}

describe("TaskletCommandApprovals one-shot consent", () => {
	it("prompts for every invocation and never persists plain or Utility approval", async () => {
		const h = fixture()
		let asks = 0
		const request = command()
		const approve = async () => { asks++; return true }
		assert.equal(await h.approvals.authorize([request], approve), true)
		h.approvals.assertCurrent([request])
		assert.equal(await h.approvals.authorize([command()], approve), true)
		assert.equal(await h.approvals.authorize([request], approve), true)
		assert.equal(asks, 3)
		assert.throws(() => h.approvals.assertCurrent([command()]), /no longer covers/)
	})

	it("does not reuse historical exact-command grants after resume", async () => {
		const h = fixture({ version: 1, grants: [{ identity: command().identity, restrictions: [] }] })
		assert.equal(await h.approvals.authorize([command()], async () => false), false)
	})

	it("requires approval for all batch items each time, including compounds", async () => {
		const h = fixture()
		await h.approvals.authorize([command("A && B"), command("C")], async (missing) => { assert.deepEqual(missing, [0, 1]); return true })
		await h.approvals.authorize([command("A && B"), command("C")], async (missing) => { assert.deepEqual(missing, [0, 1]); return false })
	})

	it("does not serialize or hold authority across an approval prompt", async () => {
		const h = fixture()
		let release!: () => void
		const barrier = new Promise<void>((resolve) => { release = resolve })
		let asked = 0
		const first = h.approvals.authorize([command()], async () => { asked++; await barrier; return true })
		assert.equal(await h.approvals.authorize([command()], async () => { asked++; return true }), true)
		assert.equal(asked, 2)
		release()
		await first
	})

	it("revalidates current restrictions and active authority before dispatch", async () => {
		const h = fixture()
		const request = command()
		h.setRestrictions(["manual"])
		await h.approvals.authorize([request], async () => true)
		h.setRestrictions([])
		h.approvals.assertCurrent([request])
		h.setRestrictions(["new restriction"])
		assert.throws(() => h.approvals.assertCurrent([request]), /no longer covers/)
		await assert.rejects(h.approvals.authorize([command()], async () => { h.setRestrictions(["changed during prompt"]); return true }), /changed during approval/)
		h.stop()
		assert.throws(() => h.approvals.assertCurrent([request]), /inactive/)
		await assert.rejects(h.approvals.authorize([command()], async () => true), /inactive/)
	})

	it("binds consent to exact invocation identity and effective command", async () => {
		const h = fixture()
		const request = command()
		await h.approvals.authorize([request], async () => true)
		request.identity.cwd = "/other"
		assert.throws(() => h.approvals.assertCurrent([request]), /no longer covers/)
		const other = command()
		await assert.rejects(h.approvals.authorize([other], async () => { other.effectiveCommand = "different"; return true }), /changed during approval/)
	})

	it("does not grant rejected, cancelled, or unreadable permission requests", async () => {
		const h = fixture()
		const request = command()
		assert.equal(await h.approvals.authorize([request], async () => false), false)
		await assert.rejects(h.approvals.authorize([request], async () => { throw new Error("cancelled") }), /cancelled/)
		assert.throws(() => h.approvals.assertCurrent([request]), /no longer covers/)
		const broken = new TaskletCommandApprovals(undefined, () => { throw new Error("invalid config") }, () => {})
		await assert.rejects(broken.authorize([command()], async () => true), /invalid config/)
	})

	it("validates historical snapshots without reusing them", () => {
		assert.equal(isCommandGrantSnapshot({ version: 1, grants: [] }), true)
		for (const value of [null, {}, { version: 2, grants: [] }, { version: 1, grants: [{}] },
			{ version: 1, grants: [{ identity: command().identity, restrictions: [3] }] },
			{ version: 1, grants: [{ identity: { ...command().identity, cwd: "relative" }, restrictions: [] }] }]) {
			assert.equal(isCommandGrantSnapshot(value), false)
		}
	})
})
