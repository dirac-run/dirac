import type { GoalTaskSummary, GoalViewState } from "@shared/goal"
import { render } from "ink-testing-library"
import React, { act } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

type InputHandler = (input: string, key: import("ink").Key) => void
const capturedInput = vi.hoisted(() => ({
	handler: null as InputHandler | null,
	options: null as { isActive?: boolean } | null,
}))

vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useInput: (handler: InputHandler, options?: { isActive?: boolean }) => {
			capturedInput.handler = handler
			capturedInput.options = options ?? null
		},
	}
})

vi.mock("../context/StdinContext", () => ({
	useStdinContext: () => ({ isRawModeSupported: true }),
}))

import { GoalSummary } from "./GoalSummary"

function terminalChild(index: number): GoalTaskSummary {
	return {
		id: `terminal-${index}`,
		title: `Terminal child ${index}`,
		role: index === 1 ? "verification" : "task",
		status: index === 1 ? "failed" : "completed",
		createdAt: index,
		endedAt: index,
		pendingInteractionCount: 0,
		idleDurationMs: 0,
	}
}

function goalWithOlderChildren(): GoalViewState {
	return {
		id: "goal-1",
		status: "working",
		followUpActive: false,
		objective: { markdown: "## Inspect **every** [child](https://example.com)", revision: 1, updatedAt: 1 },
		createdAt: 1,
		updatedAt: 1,
		wallDurationMs: 1_000,
		activeDurationMs: 1_000,
		children: [
			...Array.from({ length: 7 }, (_, index) => terminalChild(index + 1)),
			{
				id: "active",
				title: "Active child",
				role: "task",
				status: "running",
				createdAt: 8,
				pendingInteractionCount: 0,
				idleDurationMs: 0,
			},
		],
		pendingInteractionCount: 0,
		accounting: {},
		mode: "act",
		modeSwitchingDisabled: true,
		modeSwitchingExplanation: "Mode switching is disabled while a Goal is active.",
	}
}

function renderSummary(goal: GoalViewState, detailsExpanded = false, pendingStop = false, onPageNavigation = vi.fn()) {
	return render(
		React.createElement(GoalSummary, {
			goal,
			detailsExpanded,
			height: detailsExpanded ? 16 : 5,
			isProcessing: false,
			isStopConfirmationPending: pendingStop,
			onPageNavigation,
		}),
	)
}

async function pressPageKey(key: "pageUp" | "pageDown") {
	if (!capturedInput.handler) throw new Error("GoalSummary input handler was not registered")
	await act(async () => {
		capturedInput.handler?.("", { [key]: true } as import("ink").Key)
	})
}

describe("GoalSummary", () => {
	beforeEach(() => {
		capturedInput.handler = null
		capturedInput.options = null
	})

	it("defaults to a compact operational summary with an explicit details shortcut", () => {
		const frame = renderSummary(goalWithOlderChildren()).lastFrame() ?? ""
		expect(frame).toContain("Goal")
		expect(frame).toContain("WORKING")
		expect(frame).toContain("Ctrl+P Pause · Ctrl+X Stop permanently · Ctrl+G Details")
		expect(frame).toContain("Inspect every child")
		expect(frame).not.toContain("terminal-1")
		expect(frame).not.toContain("##")
		expect(frame).not.toContain("**")
		expect(frame).not.toContain("Accounting")
		expect(capturedInput.options?.isActive).toBe(false)
	})

	it("offers ownership-checked resume for an active record with no local execution", () => {
		const goal = { ...goalWithOlderChildren(), hasLocalExecution: false }
		const frame = renderSummary(goal).lastFrame() ?? ""
		expect(frame).toContain("WORKING")
		expect(frame).toContain("Ctrl+R Resume here")
		expect(frame).not.toContain("Ctrl+P Pause")
	})

	it("pages expanded children from active and recent work to the oldest child", async () => {
		const onPageNavigation = vi.fn()
		const view = renderSummary(goalWithOlderChildren(), true, false, onPageNavigation)

		expect(capturedInput.options?.isActive).toBe(true)
		expect(view.lastFrame()).not.toContain("Objective r1")
		expect(view.lastFrame()).toContain("page 1/2")
		expect(view.lastFrame()).toContain("(active)")
		expect(view.lastFrame()).not.toContain("(terminal-1)")

		await pressPageKey("pageDown")

		expect(onPageNavigation).toHaveBeenCalledOnce()
		expect(view.lastFrame()).toContain("page 2/2")
		expect(view.lastFrame()).toContain("failed · verification · Terminal child 1 (terminal-1)")

		await pressPageKey("pageUp")
		expect(view.lastFrame()).toContain("page 1/2")
	})

	it("keeps accepted handles before terminal work without inventing activity durations", () => {
		const goal = goalWithOlderChildren()
		goal.children = [
			...goal.children.slice(0, 7),
			{ id: "accepted", title: "Saved handle", role: "task", status: "accepted", createdAt: 0, pendingInteractionCount: 2 },
		]
		goal.pendingInteractionCount = 2
		const frame = renderSummary(goal, true).lastFrame() ?? ""
		expect(frame).toContain("accepted · task · Saved handle (accepted)")
		expect(frame).toContain("2 pending interactions")
		expect(frame).not.toContain("(terminal-1)")
		expect(frame).not.toContain("run unavailable")
		expect(frame).not.toContain("idle unavailable")
	})

	it("keeps per-turn Escape cancellation distinct from durable Goal status", () => {
		const goal = goalWithOlderChildren()
		goal.status = "achieved"
		goal.followUpActive = true
		const frame = renderSummary(goal).lastFrame() ?? ""

		expect(frame).toContain("ACHIEVED")
		expect(frame).toContain("Esc cancels this turn")
		expect(frame).not.toContain("Ctrl+X")
	})

	it("makes stopped Goals follow-up-only without Resume", () => {
		const goal = goalWithOlderChildren()
		goal.status = "stopped"
		const frame = renderSummary(goal).lastFrame() ?? ""

		expect(frame).toContain("Follow-up chat available")
		expect(frame).not.toContain("Ctrl+R")
		expect(frame).not.toContain("Ctrl+X")
	})

	it("shows permanent, time-bounded wording during Stop confirmation", () => {
		const frame = renderSummary(goalWithOlderChildren(), false, true).lastFrame() ?? ""
		expect(frame).toContain("Ctrl+X again within 5s to permanently Stop this Goal (cannot resume) · Esc cancel")
	})
})
