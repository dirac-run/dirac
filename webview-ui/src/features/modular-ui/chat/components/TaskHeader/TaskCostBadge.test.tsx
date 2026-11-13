import type { ModelInfo } from "@shared/api"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { TaskCostBadge } from "./TaskCostBadge"

const free: ModelInfo = { supportsPromptCache: true, inputPrice: 0, outputPrice: 0 }
const paid: ModelInfo = { supportsPromptCache: true, inputPrice: 3, outputPrice: 15 }
const now = Date.UTC(2026, 5, 1)

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() { }
			unobserve() { }
			disconnect() { }
		},
	)
	vi.useFakeTimers()
	vi.setSystemTime(now)
	useSettingsStore.setState({
		openAiCodexIsAuthenticated: true,
		openAiCodexUsage: {
			quotaFetchedAt: now,
			rateLimits: [{ limitId: "codex", secondary: { usedPercent: 22, windowMinutes: 10080 } }],
		},
	})
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("TaskCostBadge", () => {
	it("replaces Free for ChatGPT login and shows quota details on focus", () => {
		render(<TaskCostBadge provider="openai-codex" modelInfo={free} totalCost={0} />)
		fireEvent.focus(screen.getByText("78% left"))
		expect(screen.getByRole("tooltip")).toHaveTextContent("Weekly: 78% remaining")
		expect(screen.getByRole("tooltip")).toHaveTextContent("ChatGPT account quota (not task cost)")
		expect(screen.queryByText("Free")).not.toBeInTheDocument()
	})

	it("preserves accrued monetary costs and other provider pricing", () => {
		const { rerender } = render(<TaskCostBadge provider="openai-codex" modelInfo={free} totalCost={1.23} />)
		expect(screen.getByText("$1.2300")).toBeInTheDocument()
		rerender(<TaskCostBadge provider="openrouter" modelInfo={free} totalCost={0} />)
		expect(screen.getByText("Free")).toBeInTheDocument()
		rerender(<TaskCostBadge provider="anthropic" modelInfo={paid} totalCost={0} />)
		expect(screen.getByText("$0.0000")).toBeInTheDocument()
		rerender(<TaskCostBadge provider="openai" totalCost={0} />)
		expect(screen.getByText("n/a")).toBeInTheDocument()
	})

	it("uses Subscription when data is missing or the user signs out", () => {
		const { rerender } = render(<TaskCostBadge provider="openai-codex" modelInfo={free} totalCost={0} />)
		act(() => useSettingsStore.setState({ openAiCodexIsAuthenticated: false }))
		expect(screen.getByText("Subscription")).toBeInTheDocument()
		act(() => useSettingsStore.setState({ openAiCodexIsAuthenticated: true, openAiCodexUsage: undefined }))
		expect(screen.getByText("Subscription")).toBeInTheDocument()
		rerender(<TaskCostBadge provider="openrouter" modelInfo={free} totalCost={0} />)
		expect(screen.queryByText("Subscription")).not.toBeInTheDocument()
	})

	it("reacts to live quota updates and marks data stale while idle without fetching", () => {
		const refresh = vi.fn()
		useSettingsStore.setState({ refreshOpenAiCodexUsage: refresh })
		const { unmount } = render(<TaskCostBadge provider="openai-codex" modelInfo={free} totalCost={0} />)
		act(() =>
			useSettingsStore.setState({
				openAiCodexUsage: {
					quotaFetchedAt: now,
					rateLimits: [{ limitId: "codex", secondary: { usedPercent: 50, windowMinutes: 10080 } }],
				},
			}),
		)
		expect(screen.getByText("50% left")).toBeInTheDocument()
		act(() => vi.advanceTimersByTime(16 * 60_000))
		expect(screen.getByText("50% left · stale")).toBeInTheDocument()
		expect(refresh).not.toHaveBeenCalled()
		unmount()
		expect(vi.getTimerCount()).toBe(0)
	})
})
