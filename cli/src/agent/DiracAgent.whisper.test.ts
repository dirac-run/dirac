import { describe, expect, it, vi } from "vitest";
import { DiracAgent } from "./DiracAgent.js";
import { AcpSessionStatus } from "./public-types.js";

function processingAgent(sessionId = "session-1") {
	const agent = new DiracAgent({})
		; (agent as any).sessionStates.set(sessionId, {
			sessionId,
			status: AcpSessionStatus.Processing,
			pendingToolCalls: new Map(),
		})
	return { agent, sessionId }
}

describe("DiracAgent ACP whisper ownership", () => {
	it("buffers pre-task whispers and drains them in order when the prompt task binds", async () => {
		const { agent, sessionId } = processingAgent()
		const enqueueSteeringMessage = vi.fn(async (_text: string) => "steering-id")
		const task = { canAcceptSteeringMessage: () => true, enqueueSteeringMessage }

		await agent.queueWhisper({ sessionId, text: "first" })
		await agent.queueWhisper({ sessionId, text: "second" })
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["first", "second"])

		await (agent as any).steering.bindPromptTask(sessionId, task)

		expect(enqueueSteeringMessage.mock.calls.map((call) => call[0])).toEqual(["first", "second"])
		expect((agent as any).steering.pendingWhispers.has(sessionId)).toBe(false)
		expect((agent as any).steering.promptTasks.get(sessionId)).toBe(task)
	})

	it("does not remove a buffered whisper until Task accepts it", async () => {
		const { agent, sessionId } = processingAgent()
		await agent.queueWhisper({ sessionId, text: "keep me" })
		const enqueueSteeringMessage = vi.fn().mockRejectedValueOnce(new Error("not ready"))
		const task = { canAcceptSteeringMessage: () => true, enqueueSteeringMessage }

		await expect((agent as any).steering.bindPromptTask(sessionId, task)).rejects.toThrow("not ready")
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["keep me"])
	})

	it("keeps pre-task guidance buffered when a stale task binds and drains it after replacement binding", async () => {
		const { agent, sessionId } = processingAgent()
		await agent.queueWhisper({ sessionId, text: "for replacement" })

		const staleTask = {
			canAcceptSteeringMessage: () => false,
			enqueueSteeringMessage: vi.fn(),
		}
		await (agent as any).steering.bindPromptTask(sessionId, staleTask)
		expect(staleTask.enqueueSteeringMessage).not.toHaveBeenCalled()
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["for replacement"])

		const replacementTask = {
			canAcceptSteeringMessage: () => true,
			enqueueSteeringMessage: vi.fn(async () => "steering-id"),
		}
		await (agent as any).steering.bindPromptTask(sessionId, replacementTask)

		expect(replacementTask.enqueueSteeringMessage).toHaveBeenCalledWith("for replacement")
		expect((agent as any).steering.promptTasks.get(sessionId)).toBe(replacementTask)
	})

	it("buffers guidance while the bound task is temporarily waiting for input", async () => {
		const { agent, sessionId } = processingAgent()
		const task = {
			taskState: { abort: false, pendingTaskReplacement: undefined },
			canAcceptSteeringMessage: () => false,
			enqueueSteeringMessage: vi.fn(),
		}
		;(agent as any).steering.promptTasks.set(sessionId, task)

		await agent.queueWhisper({ sessionId, text: "answer after the card" })

		expect(task.enqueueSteeringMessage).not.toHaveBeenCalled()
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["answer after the card"])
	})

	it("emits a queued steering acknowledgement after the task accepts guidance", async () => {
		const { agent, sessionId } = processingAgent()
		const updates: Array<Record<string, unknown>> = []
		agent.emitterForSession(sessionId).on("steering_status", (payload) => updates.push(payload))
		;(agent as any).steering.promptTasks.set(sessionId, {
			canAcceptSteeringMessage: () => true,
			enqueueSteeringMessage: vi.fn().mockResolvedValue("transcript-1"),
		})

		await agent.queueWhisper({ sessionId, text: "keep going" })

		expect(updates).toEqual([{ steeringMessageId: "transcript-1", status: "queued" }])
	})

	it("retains guidance when a bound task begins replacement during enqueue", async () => {
		const { agent, sessionId } = processingAgent()
		const task = {
			taskState: { abort: true, pendingTaskReplacement: { context: "replacement" } },
			canAcceptSteeringMessage: () => false,
			enqueueSteeringMessage: vi.fn().mockRejectedValue(new Error("Task cannot accept steering")),
		}
			; (agent as any).steering.promptTasks.set(sessionId, task)

		await agent.queueWhisper({ sessionId, text: "preserve me" })

		expect((agent as any).steering.promptTasks.has(sessionId)).toBe(false)
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["preserve me"])
	})


	it("preserves pre-task guidance across prompt unbinding and clears it on session release", async () => {
		const { agent, sessionId } = processingAgent()
		await agent.queueWhisper({ sessionId, text: "temporary" })
			; (agent as any).steering.promptTasks.set(sessionId, {})

			; (agent as any).steering.unbindPromptTask(sessionId)
		expect((agent as any).steering.pendingWhispers.get(sessionId)).toEqual(["temporary"])
		expect((agent as any).steering.promptTasks.has(sessionId)).toBe(false)

			; (agent as any).steering.releasePromptSteeringOwnership(sessionId)
		expect((agent as any).steering.pendingWhispers.has(sessionId)).toBe(false)
	})
})
