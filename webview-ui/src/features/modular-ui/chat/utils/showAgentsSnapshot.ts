import { TaskletInventoryRequest } from "@shared/proto/dirac/task"
import { TASKLET_STATE_LABELS, type TaskletInventoryPage } from "@shared/taskletObservation"
import { useChatStore } from "@/features/chat/store/chatStore"
import { TaskServiceClient } from "@/shared/api/grpc-client"

/** One bounded local read. It never appends to protocol history or answers an interaction. */
export async function showAgentsSnapshot(): Promise<void> {
	const state = useChatStore.getState()
	const generation = state.observationGeneration
	const rootTaskId = state.presentationSurfaceId
	const append = (text: string) => useChatStore.getState().appendLocalObservation(generation, text)
	if (!rootTaskId) {
		append("No active agents — no conversation is selected.")
		return
	}

	try {
		const sourceId = state.taskletActivity?.sourceId
		const response = await TaskServiceClient.getTaskletInventory(TaskletInventoryRequest.create({
			rootTaskId,
			sourceId,
			filter: "active",
			limit: 50,
		}))
		if (useChatStore.getState().observationGeneration !== generation) return
		const page = JSON.parse(response.value) as TaskletInventoryPage
		if (page.rootTaskId !== rootTaskId || (sourceId !== undefined && page.sourceId !== sourceId) || page.filter !== "active") {
			throw new Error("The selected agent source changed. Run /agents again.")
		}
		append(formatAgentsSnapshot(page))
	} catch (error) {
		append(`Could not read agents: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export function formatAgentsSnapshot(snapshot: TaskletInventoryPage): string {
	const heading = `Agent snapshot · ${new Date(snapshot.observedAt).toLocaleString()}`
	if (snapshot.availability === "saved") {
		return `${heading}\nSaved history — live agent activity is unavailable. No agents were started or resumed.`
	}
	if (snapshot.items.length === 0) return `${heading}\nNo active agents.`
	const rows = snapshot.items.map((item) =>
		`• ${item.title.replace(/\s+/g, " ")} — ${TASKLET_STATE_LABELS[item.state]}\n  ${item.taskletId}`,
	)
	const more = snapshot.nextCursor || snapshot.items.length < snapshot.totalItems
		? `Showing ${snapshot.items.length} of ${snapshot.totalItems} active agents. Ask Dirac about the remaining agents.`
		: `${snapshot.totalItems} active`
	return [heading, more, ...rows, "Frozen snapshot. Ask Dirac about an agent, or run /agents again to refresh."].join("\n")
}
