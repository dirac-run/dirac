import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "../../modular-ui/components/ThinkingRow"

describe("ThinkingRow", () => {
	it("renders streaming title styling and expanded reasoning content", () => {
		render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={true}
				isVisible={true}
				reasoningContent="Inspecting files..."
				showTitle={true}
				title="Thinking..."
			/>,
		)

		const title = screen.getByText("Thinking...")
		expect(title).toBeInTheDocument()
		expect(title).toHaveClass("animate-shimmer")

		// Lightbulb should reflect streaming state
		const bulb = title.closest('[role="button"]')?.querySelector('svg')
		expect(bulb).toBeTruthy()
		expect(bulb!.parentElement).toHaveClass("text-amber-300/80", "animate-bulb-glow")
		expect(screen.getByText("Inspecting files...")).toBeInTheDocument()
	})

	it("calls onToggle when header is clicked", () => {
		const onToggle = vi.fn()

		render(
			<ThinkingRow
				isExpanded={false}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Thinking/i }))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})
})
