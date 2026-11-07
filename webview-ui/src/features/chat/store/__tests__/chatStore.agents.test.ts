import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import { useChatStore } from "../chatStore"

const root: DiracMessage = { id: "root", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: "Root task" } }
const reply: DiracMessage = { id: "reply", ts: 2, content: { type: DiracMessageType.MARKDOWN, content: "Parent reply" } }
const activity = { rootTaskId: "root", sourceId: "host-1", availability: "live" as const, activeCount: 16 }

function hydrate(messages = [root, reply], surfaceId = "root") {
	useChatStore.getState().applyExtensionState({
		diracMessages: messages,
		presentationSurfaceId: surfaceId,
		presentationOffset: -1,
		taskletActivity: { ...activity, rootTaskId: surfaceId },
	})
}

beforeEach(() => useChatStore.setState(useChatStore.getInitialState(), true))

describe("local agent display history", () => {
	it("preserves a frozen snapshot through appends and same-surface hydration without entering model presentation", () => {
		hydrate()
		const generation = useChatStore.getState().observationGeneration
		expect(useChatStore.getState().appendLocalObservation(generation, "16 active · frozen")).toBe(true)
		const [snapshot] = useChatStore.getState().localObservationMessages.values()
		const later: DiracMessage = { ...reply, id: "later", ts: 3 }
		useChatStore.getState().applyPresentationBatch({
			surfaceId: "root", operations: [{ type: "create", offset: 0, message: later }],
		})
		expect(useChatStore.getState().visibleMessageIds).toEqual([reply.id, snapshot.id, later.id])
		hydrate([root, reply, later])
		expect(useChatStore.getState().visibleMessageIds).toEqual([reply.id, snapshot.id, later.id])
		expect(useChatStore.getState().localObservationMessages.get(snapshot.id)).toBe(snapshot)
		expect(useChatStore.getState().diracMessages).toEqual([root, reply, later])
		expect(useChatStore.getState().messageIndexById.has(snapshot.id)).toBe(false)
		expect(useChatStore.getState().lastMessage?.id).toBe(later.id)
	})

	it("preserves snapshots on presentation reset, including a snapshot before any visible reply", () => {
		hydrate([root])
		useChatStore.getState().appendLocalObservation(useChatStore.getState().observationGeneration, "No active agents.")
		const [snapshot] = useChatStore.getState().localObservationMessages.values()
		useChatStore.getState().applyPresentationBatch({
			surfaceId: "root", operations: [{ type: "reset", offset: 0, messages: [root, reply] }],
		})
		expect(useChatStore.getState().visibleMessageIds).toEqual([snapshot.id, reply.id])
		expect(useChatStore.getState().localObservationMessages.get(snapshot.id)?.text).toBe("No active agents.")
	})

	it("clears local history on root switch and rejects late reads even after switching back", () => {
		hydrate()
		const generation = useChatStore.getState().observationGeneration
		useChatStore.getState().appendLocalObservation(generation, "Old source")
		hydrate([{ ...root, id: "other" }], "other")
		expect(useChatStore.getState().localObservationMessages.size).toBe(0)
		hydrate()
		expect(useChatStore.getState().appendLocalObservation(generation, "Stale read")).toBe(false)
		expect(useChatStore.getState().localObservationMessages.size).toBe(0)
	})

	it("invalidates pending reads, but not frozen history, when the host source changes", () => {
		hydrate()
		const generation = useChatStore.getState().observationGeneration
		useChatStore.getState().appendLocalObservation(generation, "Frozen old source")
		useChatStore.getState().applyExtensionState({ taskletActivity: { ...activity, sourceId: "host-2" } })
		expect(useChatStore.getState().appendLocalObservation(generation, "Old host response")).toBe(false)
		expect([...useChatStore.getState().localObservationMessages.values()].map((entry) => entry.text)).toEqual(["Frozen old source"])
	})

	it("does not rederive the chat timeline or metrics for lifecycle count updates", () => {
		hydrate()
		const before = useChatStore.getState()
		useChatStore.getState().applyExtensionState({ taskletActivity: { ...activity, activeCount: 12 } })
		const after = useChatStore.getState()
		expect(after.taskletActivity?.activeCount).toBe(12)
		expect(after.diracMessages).toBe(before.diracMessages)
		expect(after.visibleMessageIds).toBe(before.visibleMessageIds)
		expect(after.apiMetrics).toBe(before.apiMetrics)
		expect(after.presentationRevision).toBe(before.presentationRevision)
		expect(after.observationGeneration).toBe(before.observationGeneration)
		useChatStore.getState().applyExtensionState({ taskletActivity: null })
		expect(useChatStore.getState().taskletActivity).toBeUndefined()
	})
})
