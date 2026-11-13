import { describe, expect, it } from "vitest"
import {
	calculateChatLayoutRows,
	calculateGoalSummaryRows,
	calculatePermissionModalLayout,
	shouldShowGoalFooter,
} from "./chat-layout"

describe("calculateChatLayoutRows", () => {
	it.each([1, 2, 6, 12, 24])("keeps allocations within a %i-row terminal", (terminalRows) => {
		const layout = calculateChatLayoutRows({
			terminalRows,
			hasConversationContent: true,
			hasComposer: true,
			hasFooter: true,
			hasPanel: false,
		})
		expect(layout.liveViewportRows).toBeGreaterThanOrEqual(1)
		expect(layout.liveViewportRows).toBeLessThanOrEqual(Math.max(1, terminalRows))
		expect(layout.activeContentRows).toBeLessThanOrEqual(layout.liveViewportRows)
	})
})
describe("Goal summary allocation", () => {
	it("reserves compact Goal and footer rows while preserving a short-terminal transcript", () => {
		const goalSummaryRows = calculateGoalSummaryRows(12, false)
		const layout = calculateChatLayoutRows({
			terminalRows: 12,
			hasConversationContent: true,
			hasComposer: true,
			hasFooter: true,
			hasPanel: false,
			footerRows: 2,
			goalSummaryRows,
		})

		expect(goalSummaryRows).toBe(5)
		expect(layout.liveViewportRows).toBe(1)
	})

	it("shrinks the summary and removes its footer reservation in very short terminals", () => {
		expect(calculateGoalSummaryRows(8, false)).toBe(4)
		expect(calculateGoalSummaryRows(6, false)).toBe(2)
		expect(shouldShowGoalFooter(8)).toBe(false)
		expect(shouldShowGoalFooter(10)).toBe(true)
	})

	it("bounds expanded details to leave transcript and composer space", () => {
		expect(calculateGoalSummaryRows(24, true)).toBe(9)
		expect(calculateGoalSummaryRows(40, true)).toBe(9)
	})
})

describe("stable live viewport", () => {
	it("keeps the same allocation while activity content changes", () => {
		const layout = calculateChatLayoutRows({
			terminalRows: 40,
			hasConversationContent: true,
			hasComposer: true,
			hasFooter: true,
			hasPanel: false,
		})

		expect(layout).toEqual({
			liveViewportRows: 17,
			activeContentRows: 13,
			compactHistoryRows: 3,
		})
	})
})

describe("calculatePermissionModalLayout", () => {
	it("reserves one footer row per command choice without changing the modal size", () => {
		const ordinary = calculatePermissionModalLayout(100, 30)
		const command = calculatePermissionModalLayout(100, 30, ["Approve this command", "Allow network", "Allow files", "Reject"])
		expect(command).toEqual({ ...ordinary, bodyLines: ordinary.bodyLines - 3 })
	})

	it("reserves wrapped command-choice rows on narrow terminals", () => {
		const ordinary = calculatePermissionModalLayout(60, 24)
		const command = calculatePermissionModalLayout(60, 24, [
			"Approve this command",
			"Approve + allow remote_resources/mutate for this task",
			"Approve + allow local_files/mutate for this task",
			"Reject",
		])
		expect(command.bodyLines).toBe(ordinary.bodyLines - 5)
	})

	it.each([
		[1, 1],
		[8, 5],
		[40, 12],
		[120, 50],
	])("fits within a %i×%i terminal", (columns, rows) => {
		const layout = calculatePermissionModalLayout(columns, rows)
		expect(layout.width).toBeGreaterThanOrEqual(1)
		expect(layout.height).toBeGreaterThanOrEqual(1)
		expect(layout.width).toBeLessThanOrEqual(columns)
		expect(layout.height).toBeLessThanOrEqual(rows)
		expect(layout.bodyColumns).toBeGreaterThanOrEqual(1)
		expect(layout.bodyLines).toBeGreaterThanOrEqual(1)
	})
})
