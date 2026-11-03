import { Card, CardStatus, SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { createSubagentCardInput, createSubagentCardOutput } from "@shared/subagents"
import { createTaskletPresentationCard, type TaskletPresentationStatus } from "@shared/taskletPresentation"
import { act, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { getCardFilePath, getSubagentCardElapsedTime, ModularCardHeader } from "./ModularCardHeader"

function createSubagentCard(overrides: Partial<Card> = {}): Card {
	return {
		id: "subagent-card",
		header: "Pauli: Investigating API handler",
		status: CardStatus.RUNNING,
		renderType: "markdown",
		startTime: 0,
		rawInput: createSubagentCardInput({ id: 2, name: "Pauli" }, "Investigate the API handler", "Investigating API handler"),
		rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, []),
		...overrides,
	}
}

function createTaskletCard(status: TaskletPresentationStatus, overrides: Partial<Card> = {}): Card {
	return {
		...createTaskletPresentationCard({
			taskletId: "tl-stable",
			title: "Review implementation",
			prompt: "Inspect the interface",
			createdAt: 1_000,
			status,
			communications: [],
			activity: [],
		}),
		...overrides,
	}
}

describe("getCardFilePath", () => {
	it("prefers an exact machine-readable card location over header inference", () => {
		const card: Card = {
			id: "ast-card",
			header: "Inspecting implementation from misleading.ts",
			toolName: "inspect_ast",
			status: CardStatus.SUCCESS,
			renderType: "markdown",
			locations: [{ path: "src/exact.ts", line: 9 }],
		}

		expect(getCardFilePath(card)).toBe("src/exact.ts")
	})

	it("never infers a file link from tasklet text or stale card locations", () => {
		expect(getCardFilePath(createTaskletCard("running", { locations: [{ path: "src/stale.ts" }] }))).toBeUndefined()
		expect(getCardFilePath(createTaskletCard("running", { header: "Inspect src/stale.ts" }))).toBeUndefined()
	})
})

describe("getSubagentCardElapsedTime", () => {
	it("formats a running subagent duration as MM:SS", () => {
		expect(getSubagentCardElapsedTime(createSubagentCard(), 62_000)).toBe("01:02")
	})

	it("freezes a terminal subagent duration at its end time", () => {
		const card = createSubagentCard({
			status: CardStatus.SUCCESS,
			endTime: 95_000,
			rawOutput: createSubagentCardOutput(SubagentExecutionStatus.COMPLETED, []),
		})

		expect(getSubagentCardElapsedTime(card, 120_000)).toBe("01:35")
	})

	it("does not expose a timer for generic or timestamp-less subagent cards", () => {
		const genericCard: Card = {
			id: "generic-card",
			header: "Read file",
			status: CardStatus.RUNNING,
			renderType: "text",
			startTime: 0,
		}

		expect(getSubagentCardElapsedTime(genericCard, 62_000)).toBeUndefined()
		expect(getSubagentCardElapsedTime(createSubagentCard({ startTime: undefined }), 62_000)).toBeUndefined()
	})

	it.each([
		"running",
		"waiting",
	] as const)("updates elapsed time for a %s tasklet despite stale terminal card fields", (status) => {
		const card = createTaskletCard(status, { status: CardStatus.SUCCESS, endTime: 2_000 })
		expect(getSubagentCardElapsedTime(card, 63_000)).toBe("01:02")
		expect(getSubagentCardElapsedTime(card, 64_000)).toBe("01:03")
	})

	it.each([
		"completed",
		"failed",
		"interrupted",
	] as const)("omits elapsed time for a %s tasklet without an end time", (status) => {
		const card = createTaskletCard(status, { status: CardStatus.RUNNING })
		expect(getSubagentCardElapsedTime(card, 63_000)).toBeUndefined()
		expect(getSubagentCardElapsedTime(card, 93_000)).toBeUndefined()
	})

	it.each([
		"completed",
		"failed",
		"interrupted",
	] as const)("freezes a %s tasklet's elapsed time at its recorded end", (status) => {
		const card = createTaskletCard(status, { status: CardStatus.RUNNING, endTime: 96_000 })
		expect(getSubagentCardElapsedTime(card, 120_000)).toBe("01:35")
		expect(getSubagentCardElapsedTime(card, 180_000)).toBe("01:35")
	})

	it("omits a terminal legacy timer without a recorded end", () => {
		expect(getSubagentCardElapsedTime(createSubagentCard({ status: CardStatus.SUCCESS }), 120_000)).toBeUndefined()
	})

	it("does not use legacy fields for a malformed tasklet marker", () => {
		const card = createSubagentCard()
		card.rawInput = { ...card.rawInput, isTasklet: true }
		expect(getSubagentCardElapsedTime(card, 63_000)).toBeUndefined()
	})
})

describe("tasklet header rendering", () => {
	it("uses a neutral icon rather than forged completion state for a tasklet marker without its payload", () => {
		const card = createSubagentCard({
			status: CardStatus.SUCCESS,
			icon: "check",
			rawInput: { isTasklet: true, isTaskCompletion: true, isSubagent: true },
			rawOutput: undefined,
		})
		const { container } = render(
			createElement(ModularCardHeader, {
				card,
				contentId: "tasklet-body",
				isCollapsed: true,
				onToggleCollapse: vi.fn(),
			}),
		)
		expect(container.querySelector(".lucide-circle")).toBeInTheDocument()
		expect(container.querySelector(".text-success")).not.toBeInTheDocument()
		expect(container.querySelector(".modular-card-header")).toHaveAttribute("data-terminal", "false")
		expect(screen.queryByRole("timer")).not.toBeInTheDocument()
	})

	it("ticks only while ongoing and removes the timer when terminal data has no end time", () => {
		vi.useFakeTimers()
		vi.setSystemTime(63_000)
		const props = { contentId: "tasklet-body", isCollapsed: true, onToggleCollapse: vi.fn() }
		const view = render(createElement(ModularCardHeader, { ...props, card: createTaskletCard("running") }))
		try {
			expect(screen.getByRole("timer")).toHaveTextContent("01:02")
			act(() => vi.advanceTimersByTime(1_000))
			expect(screen.getByRole("timer")).toHaveTextContent("01:03")
			expect(vi.getTimerCount()).toBe(1)

			view.rerender(createElement(ModularCardHeader, { ...props, card: createTaskletCard("completed") }))
			expect(screen.queryByRole("timer")).not.toBeInTheDocument()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			view.unmount()
			vi.useRealTimers()
		}
	})
})
