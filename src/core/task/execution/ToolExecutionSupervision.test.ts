import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ToolExecutionSupervision } from "./ToolExecutionSupervision"

const root = { rootTaskId: "root", taskId: "root", runId: "root-run" }
const child = { ...root, taskId: "child", runId: "child-run" }
const sibling = { ...root, taskId: "sibling", runId: "sibling-run" }
const grandchild = { ...root, taskId: "grandchild", runId: "grandchild-run" }
function runtime(name: string, events: string[]) {
	return {
		closeAdmission: async () => {
			events.push(`${name}:close`)
		},
		shutdown: async () => {
			events.push(`${name}:shutdown`)
		},
	}
}

describe("ToolExecutionSupervision", () => {
	it("root shutdown closes and joins every descendant run", async () => {
		const events: string[] = []
		const tree = new ToolExecutionSupervision("root")
		tree.register(root, runtime("root", events), null)
		tree.register(child, runtime("child", events), root)
		tree.register(sibling, runtime("sibling", events), root)
		tree.register(grandchild, runtime("grandchild", events), child)
		await tree.shutdown(root)
		assert.deepEqual(events.slice(0, 4).sort(), ["child:close", "grandchild:close", "root:close", "sibling:close"])
		assert.deepEqual(events.slice(4).sort(), ["child:shutdown", "grandchild:shutdown", "root:shutdown", "sibling:shutdown"])
	})

	it("child shutdown never cancels its parent or sibling", async () => {
		const events: string[] = []
		const tree = new ToolExecutionSupervision("root")
		tree.register(root, runtime("root", events), null)
		tree.register(child, runtime("child", events), root)
		tree.register(sibling, runtime("sibling", events), root)
		tree.register(grandchild, runtime("grandchild", events), child)
		await tree.shutdown(child)
		assert.deepEqual(events, ["child:close", "grandchild:close", "child:shutdown", "grandchild:shutdown"])
		assert.doesNotThrow(() => tree.register({ ...child, runId: "new" }, runtime("new", events), sibling))
	})

	it("seals registrations before asynchronous close and retains supervision on failure", async () => {
		const events: string[] = []
		const tree = new ToolExecutionSupervision("root")
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let fail = true
		tree.register(
			root,
			{
				closeAdmission: () => gate,
				shutdown: async () => {
					if (fail) throw new Error("cleanup failed")
				},
			},
			null,
		)
		tree.register(child, runtime("child", events), root)
		const stopped = tree.shutdown(root)
		assert.throws(() => tree.register(sibling, runtime("sibling", events), root), /closing/)
		assert.throws(() => tree.register(grandchild, runtime("grandchild", events), child), /closing/)
		release()
		await assert.rejects(stopped, AggregateError)
		assert.ok(events.includes("child:shutdown"))
		fail = false
		await tree.shutdown(root)
	})

	it("continues sibling shutdown after synchronous adapter failures", async () => {
		const events: string[] = []
		const tree = new ToolExecutionSupervision("root")
		tree.register(
			root,
			{
				closeAdmission: () => {
					throw new Error("close failed")
				},
				shutdown: () => {
					throw new Error("shutdown failed")
				},
			},
			null,
		)
		tree.register(child, runtime("child", events), root)
		await assert.rejects(
			() => tree.shutdown(root),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError)
				assert.equal(error.errors.length, 2)
				return true
			},
		)
		assert.deepEqual(events, ["child:close", "child:shutdown"])
	})

	it("rejects foreign, duplicate, orphan and unknown runs", async () => {
		const events: string[] = []
		const tree = new ToolExecutionSupervision("root")
		assert.throws(() => tree.register({ ...root, rootTaskId: "foreign" }, runtime("x", events), null), /another root/)
		assert.throws(() => tree.register(child, runtime("x", events), null), /Only the root/)
		tree.register(root, runtime("root", events), null)
		assert.throws(() => tree.register(root, runtime("root", events), null), /already/)
		assert.throws(() => tree.register(grandchild, runtime("x", events), child), /not registered/)
		await assert.rejects(() => tree.shutdown(child), /Unknown/)
	})
})
