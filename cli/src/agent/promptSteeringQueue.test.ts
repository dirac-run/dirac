import { describe, expect, it, vi } from "vitest"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { PromptSteeringQueue } from "./promptSteeringQueue.js"
import { AcpSessionStatus } from "./public-types.js"
import type { AcpSessionState } from "./types.js"

function makeQueue(status: AcpSessionStatus = AcpSessionStatus.Processing) {
	const sessionStates = new Map<string, AcpSessionState>([["s1", { sessionId: "s1", status, pendingToolCalls: new Map() }]])
	const emitter = new DiracSessionEmitter()
	const queue = new PromptSteeringQueue({ sessionStates, emitterForSession: () => emitter })
	return { queue, sessionStates, emitter }
}

function steeringTask(overrides: Partial<{ canAccept: boolean; abort: boolean; pendingReplacement: boolean }> = {}) {
	return {
		canAcceptSteeringMessage: () => overrides.canAccept ?? true,
		enqueueSteeringMessage: vi.fn(async (text: string) => `id-${text}`),
		taskState: { abort: overrides.abort ?? false, pendingTaskReplacement: overrides.pendingReplacement ?? false },
	}
}

describe("PromptSteeringQueue", () => {
	it("ignores malformed whisper payloads", async () => {
		const { queue } = makeQueue()
		await queue.queueWhisper({ sessionId: 1, text: "x" })
		await queue.queueWhisper({ sessionId: "s1", text: "   " })
		expect((queue as any).pendingWhispers.size).toBe(0)
	})

	it("ignores whispers outside an active turn", async () => {
		const { queue } = makeQueue(AcpSessionStatus.Idle)
		await queue.queueWhisper({ sessionId: "s1", text: "hi" })
		expect((queue as any).pendingWhispers.size).toBe(0)
	})

	it("buffers until a task binds, then drains in order", async () => {
		const { queue, emitter } = makeQueue()
		const statuses: unknown[] = []
		emitter.on("steering_status", (p) => statuses.push(p))

		await queue.queueWhisper({ sessionId: "s1", text: "first" })
		await queue.queueWhisper({ sessionId: "s1", text: "second" })

		const task = steeringTask()
		await queue.bindPromptTask("s1", task as any)

		expect(task.enqueueSteeringMessage.mock.calls.map((c) => c[0])).toEqual(["first", "second"])
		expect(statuses).toEqual([
			{ steeringMessageId: "id-first", status: "queued" },
			{ steeringMessageId: "id-second", status: "queued" },
		])
		expect((queue as any).pendingWhispers.has("s1")).toBe(false)
	})

	it("rebinds a buffered whisper after a stale task is unbound", async () => {
		const { queue } = makeQueue()
		await queue.queueWhisper({ sessionId: "s1", text: "keep" })

		const stale = steeringTask({ canAccept: false, pendingReplacement: true })
		await queue.bindPromptTask("s1", stale as any)
		expect(stale.enqueueSteeringMessage).not.toHaveBeenCalled()

		await queue.queueWhisper({ sessionId: "s1", text: "new" })
		expect((queue as any).pendingWhispers.get("s1")).toEqual(["keep", "new"])

		const replacement = steeringTask()
		await queue.bindPromptTask("s1", replacement as any)
		expect(replacement.enqueueSteeringMessage.mock.calls.map((c) => c[0])).toEqual(["keep", "new"])
	})

	it("rebuffers when enqueue fails on a task that stopped accepting steering", async () => {
		const { queue } = makeQueue()
		let accepting = true
		const task = {
			canAcceptSteeringMessage: () => accepting,
			enqueueSteeringMessage: vi.fn(async () => {
				accepting = false
				throw new Error("task replaced")
			}),
			taskState: { abort: false, pendingTaskReplacement: true },
		}
		await queue.bindPromptTask("s1", task as any)
		await queue.queueWhisper({ sessionId: "s1", text: "lost-in-flight" })
		expect((queue as any).pendingWhispers.get("s1")).toEqual(["lost-in-flight"])
		expect((queue as any).promptTasks.has("s1")).toBe(false)
	})

	it("releasePromptSteeringOwnership clears both buffers", async () => {
		const { queue } = makeQueue()
		await queue.queueWhisper({ sessionId: "s1", text: "x" })
		;(queue as any).promptTasks.set("s1", steeringTask())
		queue.releasePromptSteeringOwnership("s1")
		expect((queue as any).pendingWhispers.has("s1")).toBe(false)
		expect((queue as any).promptTasks.has("s1")).toBe(false)
	})
})
