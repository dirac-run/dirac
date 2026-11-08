import type { GoalViewState } from "@shared/goal"
import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it } from "vitest"
import { GoalSummary } from "./GoalSummary"

function goal(): GoalViewState {
	return {
		id: "goal-1",
		status: "working",
		followUpActive: false,
		objective: { markdown: "## Inspect **every** [change](https://example.com)", revision: 1, updatedAt: 1 },
		createdAt: 1,
		updatedAt: 1,
		wallDurationMs: 1_000,
		activeDurationMs: 1_000,
		accounting: {},
		mode: "act",
		modeSwitchingDisabled: true,
		modeSwitchingExplanation: "Mode switching is disabled while a Goal is active.",
	}
}
function renderSummary(value: GoalViewState, detailsExpanded = false, pendingStop = false) {
	return render(
		React.createElement(GoalSummary, {
			goal: value,
			detailsExpanded,
			height: detailsExpanded ? 12 : 5,
			isProcessing: false,
			isStopConfirmationPending: pendingStop,
		}),
	)
}

describe("GoalSummary", () => {
	it("keeps the compact objective/lifecycle summary without a second agent inventory", () => {
		const view = renderSummary(goal())
		const frame = view.lastFrame() ?? ""
		expect(frame).toContain("WORKING")
		expect(frame).toContain("Ctrl+P Pause · Ctrl+X Stop permanently · Ctrl+G Details")
		expect(frame).toContain("Inspect every change")
		expect(frame).not.toContain("children")
		expect(frame).not.toContain("**")
		view.unmount()
	})
	it("retains accounting without a dedicated verification summary", () => {
		const value = goal()
		value.accounting = { totalTokens: 200, cost: 0.5 }
		const view = renderSummary(value, true)
		expect(view.lastFrame()).not.toContain("Verification")
		expect(view.lastFrame()).toContain("Accounting")
		expect(view.lastFrame()).toContain("200 tokens")
		expect(view.lastFrame()).not.toContain("Children")
		view.unmount()
	})
	it("offers ownership-checked resume for an active record with no local execution", () => {
		const view = renderSummary({ ...goal(), hasLocalExecution: false })
		expect(view.lastFrame()).toContain("Ctrl+R Resume here")
		expect(view.lastFrame()).not.toContain("Ctrl+P Pause")
		view.unmount()
	})
	it("keeps turn cancellation separate from durable Goal status", () => {
		const view = renderSummary({ ...goal(), status: "achieved", followUpActive: true })
		expect(view.lastFrame()).toContain("Esc cancels this turn")
		expect(view.lastFrame()).not.toContain("Ctrl+X")
		view.unmount()
	})
	it("makes stopped Goals follow-up-only without Resume", () => {
		const view = renderSummary({ ...goal(), status: "stopped" })
		expect(view.lastFrame()).toContain("Follow-up chat available")
		expect(view.lastFrame()).not.toContain("Ctrl+R")
		view.unmount()
	})
	it("shows permanent time-bounded Stop confirmation", () => {
		const view = renderSummary(goal(), false, true)
		expect(view.lastFrame()).toContain("Ctrl+X again within 5s to permanently Stop this Goal (cannot resume) · Esc cancel")
		view.unmount()
	})
})
