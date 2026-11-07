import { describe, expect, it } from "vitest"
import { getAgentListRowLimit } from "./AgentPanelContent"
import { formatAgentSnapshot } from "../utils/local-observation"
import type { TaskletInventoryPage } from "@shared/taskletObservation"

const page: TaskletInventoryPage = {
	rootTaskId: "root",
	sourceId: "live",
	availability: "live",
	observedAt: 1,
	filter: "active",
	totalItems: 0,
	items: [],
}

describe("passive agent inventory display", () => {
	it("reserves panel chrome and keeps sixteen agent rows compact", () => {
		expect(getAgentListRowLimit(6)).toBe(1)
		expect(getAgentListRowLimit(24)).toBe(17)
	})
	it("formats sixteen active agents including parent waits without implying completion", () => {
		const snapshot = formatAgentSnapshot({
			...page,
			totalItems: 16,
			items: Array.from({ length: 16 }, (_, index) => ({
				taskletId: `agent-${index}`,
				title: `Task ${index}`,
				state: index % 2 ? "waiting_for_parent" : "running",
			})),
		})
		expect(snapshot).toContain("16 active")
		expect(snapshot).toContain("Waiting for parent")
		expect(snapshot).toContain("Task 15")
		expect(snapshot).toContain("Frozen local snapshot")
	})
	it("distinguishes no active agents from unavailable live activity in saved history", () => {
		expect(formatAgentSnapshot(page)).toContain("No active agents")
		expect(formatAgentSnapshot({ ...page, availability: "saved" })).toContain("live activity is unavailable")
	})
})
