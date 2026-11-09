import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { TaskletCommandApprovals, isCommandGrantSnapshot } from "../TaskletCommandApprovals"
import type { CommandApprovalRequest, CommandGrantSnapshot } from "../tools/interfaces/CommandApprovals"

const command = (text = "npm run check:arch", cwd = "/workspace"): CommandApprovalRequest => ({
	identity: { kind: "command", command: text, cwd }, effectiveCommand: text,
})
function fixture(initial?: CommandGrantSnapshot) {
	let saved = initial
	let restrictions: string[] = []
	let active = true
	let writes = 0
	const approvals = new TaskletCommandApprovals(initial, async (snapshot) => {
		saved = structuredClone(snapshot)
		writes++
	}, () => restrictions, () => { if (!active) throw new Error("inactive") })
	return { approvals, get saved() { return saved }, get writes() { return writes },
		setRestrictions: (next: string[]) => { restrictions = next }, stop: () => { active = false } }
}

describe("TaskletCommandApprovals", () => {
	it("remembers every successful approval without depending on Utility, command success, or file contents", async () => {
		const h = fixture()
		let asks = 0
		const approve = async () => { asks++; return true }
		assert.equal(await h.approvals.authorize([command()], approve), true)
		assert.equal(await h.approvals.authorize([command()], approve), true)
		assert.equal(asks, 1)
		assert.equal(h.writes, 1)
		h.approvals.assertCurrent([command()])
		const resumed = fixture(h.saved)
		assert.equal(await resumed.approvals.authorize([command()], async () => { throw new Error("must not ask") }), true)
	})

	it("does not share with another child and distinguishes exact arguments and cwd", async () => {
		const h = fixture()
		await h.approvals.authorize([command()], async () => true)
		for (const request of [command("npm run check:arch --fix"), command(undefined, "/other")]) {
			assert.equal(await h.approvals.authorize([request], async () => false), false)
		}
		assert.equal(await fixture().approvals.authorize([command()], async () => false), false)
	})

	it("grants each batch item without widening shell compounds into fragments", async () => {
		const h = fixture()
		await h.approvals.authorize([command("cd src && npm test"), command("npm run lint")], async () => true)
		await h.approvals.authorize([command("npm run lint"), command("npm test")], async (missing) => {
			assert.deepEqual(missing, [1])
			return false
		})
		assert.throws(() => h.approvals.assertCurrent([command("npm test")]), /no longer covers/)
	})

	it("keys scripts by exact source and interpreter, not random wrapper delimiters", async () => {
		const h = fixture()
		const request: CommandApprovalRequest = {
			identity: { kind: "script", script: "print(1)", interpreter: "python3", cwd: "/workspace" },
			effectiveCommand: "python3 << 'RANDOM_A'\nprint(1)\nRANDOM_A",
		}
		await h.approvals.authorize([request], async () => true)
		assert.equal(await h.approvals.authorize([{ ...request, effectiveCommand: request.effectiveCommand.replaceAll("RANDOM_A", "RANDOM_B") }], async () => false), true)
		assert.equal(await h.approvals.authorize([{ ...request, identity: { ...request.identity, kind: "script", script: "print(2)", interpreter: "python3" } }], async () => false), false)
	})

	it("reuses explicit exceptions under unchanged or removed restrictions, but not new ones", async () => {
		const h = fixture()
		h.setRestrictions(["deny:test"])
		await h.approvals.authorize([command()], async () => true)
		assert.equal(await h.approvals.authorize([command()], async () => false), true)
		h.setRestrictions([])
		assert.equal(await h.approvals.authorize([command()], async () => false), true)
		h.setRestrictions(["deny:new"])
		assert.throws(() => h.approvals.assertCurrent([command()]), /no longer covers/)
		assert.equal(await h.approvals.authorize([command()], async () => false), false)
	})

	it("does not grant rejected, cancelled, or failed approvals", async () => {
		const h = fixture()
		assert.equal(await h.approvals.authorize([command()], async () => false), false)
		await assert.rejects(h.approvals.authorize([command()], async () => { throw new Error("cancelled") }), /cancelled/)
		assert.equal(h.saved, undefined)
		assert.equal(h.writes, 0)
		h.stop()
		await assert.rejects(h.approvals.authorize([command()], async () => true), /inactive/)
	})

	it("deduplicates concurrent requests and commits before either authorization returns", async () => {
		let commit!: () => void
		const barrier = new Promise<void>((resolve) => { commit = resolve })
		let writes = 0
		let asks = 0
		let returned = false
		const approvals = new TaskletCommandApprovals(undefined, async () => { writes++; await barrier }, () => [], () => {})
		const first = approvals.authorize([command()], async () => { asks++; return true }).then(() => { returned = true })
		const second = approvals.authorize([command()], async () => { asks++; return true })
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(writes, 1)
		assert.equal(asks, 1)
		assert.equal(returned, false)
		assert.throws(() => approvals.assertCurrent([command()]), /no longer covers/)
		commit()
		await Promise.all([first, second])
		assert.equal(asks, 1)
	})

	it("does not expose an in-memory grant when persistence fails", async () => {
		const approvals = new TaskletCommandApprovals(undefined, async () => { throw new Error("disk failure") }, () => [], () => {})
		await assert.rejects(approvals.authorize([command()], async () => true), /disk failure/)
		assert.throws(() => approvals.assertCurrent([command()]), /no longer covers/)
		assert.equal(await approvals.authorize([command()], async () => false), false)
	})

	it("rechecks restrictions after approval and after commit", async () => {
		const h = fixture()
		await assert.rejects(h.approvals.authorize([command()], async () => { h.setRestrictions(["new"]); return true }), /changed during approval/)
		assert.equal(h.saved, undefined)
		let restrictions: string[] = []
		const approvals = new TaskletCommandApprovals(undefined, async () => { restrictions = ["new"] }, () => restrictions, () => {})
		await assert.rejects(approvals.authorize([command()], async () => true), /no longer covers/)
	})

	it("fails closed when the restriction authority cannot be read", async () => {
		const approvals = new TaskletCommandApprovals(undefined, async () => {}, () => { throw new Error("invalid config") }, () => {})
		await assert.rejects(approvals.authorize([command()], async () => true), /invalid config/)
	})

	it("validates durable authority rather than silently ignoring malformed entries", () => {
		assert.equal(isCommandGrantSnapshot({ version: 1, grants: [] }), true)
		for (const value of [null, {}, { version: 2, grants: [] }, { version: 1, grants: [{}] },
			{ version: 1, grants: [{ identity: command().identity, restrictions: [3] }] },
			{ version: 1, grants: [{ identity: { ...command().identity, cwd: "relative" }, restrictions: [] }] }]) {
			assert.equal(isCommandGrantSnapshot(value), false)
		}
	})
})
