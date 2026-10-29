import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { createMockContext } from "../../__tests__/helpers/mockTaskConfig"
import { SubagentToolContext } from "../SubagentToolContext"

const CACHE_KEYS = ["fileHashes", "inspectAstImplementationCache"]

describe("SubagentToolContext", () => {
	for (const key of CACHE_KEYS) {
		it(`isolates ${key} from parent, sibling, and nested subagent history`, async () => {
			const parent = createMockContext()
			await parent.task.updateEntries(key, { source: { contentHash: "parent" } })
			const first = new SubagentToolContext(parent)
			const sibling = new SubagentToolContext(parent)

			assert.equal(await first.task.get(key), undefined)
			assert.equal(await first.task.getEntry(key, "source"), undefined)
			assert.deepEqual(await first.task.getEntries(key, ["source"]), {})

			await first.task.updateEntries(key, { source: { contentHash: "subagent" } })
			assert.deepEqual(await first.task.getEntry(key, "source"), { contentHash: "subagent" })
			assert.deepEqual(await parent.task.getEntry(key, "source"), { contentHash: "parent" })
			assert.equal(await sibling.task.getEntry(key, "source"), undefined)
			assert.equal(await new SubagentToolContext(first).task.getEntry(key, "source"), undefined)
		})
	}

	it("updates and deletes entries locally without exposing mutable stored values", async () => {
		const context = new SubagentToolContext(createMockContext())
		const initial = { first: { contentHash: "one" } }
		await context.task.set("cache", initial)
		initial.first.contentHash = "changed outside context"
		await context.task.update<typeof initial>("cache", (current) => ({ ...current!, second: { contentHash: "two" } }))
		await context.task.updateEntries("cache", { third: { contentHash: "three" } }, ["second"])

		assert.deepEqual(await context.task.get("cache"), {
			first: { contentHash: "one" },
			third: { contentHash: "three" },
		})
		const selected = await context.task.getEntries<{ contentHash: string }>("cache", ["first", "missing"])
		assert.deepEqual(selected, { first: { contentHash: "one" } })
		selected.first.contentHash = "changed outside context"
		assert.deepEqual(await context.task.getEntry("cache", "first"), { contentHash: "one" })
	})

	it("retains parallel entry updates", async () => {
		const context = new SubagentToolContext(createMockContext())
		await Promise.all([
			context.task.updateEntries("cache", { first: "one" }),
			context.task.updateEntries("cache", { second: "two" }),
		])
		assert.deepEqual(await context.task.get("cache"), { first: "one", second: "two" })
	})

	it("resets only local history and delegates shared state and anchor persistence", async () => {
		const parent = createMockContext()
		const load = sinon.spy(parent, "load")
		const ensureAnchors = sinon.spy(parent, "ensureAnchorState")
		const markAnchors = sinon.spy(parent, "markAnchorStateDirty")
		const save = sinon.spy(parent, "save")
		const resetParent = sinon.spy(parent, "resetTaskContext")
		const context = new SubagentToolContext(parent)
		await parent.task.set("cache", "parent")
		await context.task.set("cache", "subagent")

		assert.equal(context.workspace, parent.workspace)
		assert.equal(context.global, parent.global)
		await context.load()
		await context.ensureAnchorState()
		context.markAnchorStateDirty("/workspace/source.ts")
		await context.save()
		await context.resetTaskContext()

		sinon.assert.calledOnce(load)
		sinon.assert.calledOnce(ensureAnchors)
		sinon.assert.calledOnceWithExactly(markAnchors, "/workspace/source.ts")
		sinon.assert.calledOnce(save)
		sinon.assert.notCalled(resetParent)
		assert.equal(await context.task.get("cache"), undefined)
		assert.equal(await parent.task.get("cache"), "parent")
	})
})
