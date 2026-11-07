import type { TaskletActivitySummary } from "@shared/taskletObservation"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"
import { TaskletActivityIndicator } from "./TaskletActivityIndicator"

const activity: TaskletActivitySummary = {
	rootTaskId: "root",
	sourceId: "host-1",
	availability: "live",
	activeCount: 3,
}

const tooltip = "Run /agents to see the list of currently running subagents."

afterEach(() => {
	cleanup()
	useChatStore.setState({ taskletActivity: undefined })
})

describe("TaskletActivityIndicator", () => {
	it.each([1, 3])("shows a muted live count of %i with the /agents hover hint", (activeCount) => {
		useChatStore.setState({ taskletActivity: { ...activity, activeCount } })
		render(<TaskletActivityIndicator />)

		const indicator = screen.getByTitle(tooltip)
		expect(indicator).toHaveTextContent(activeCount === 1 ? "1 agent" : "3 agents")
		expect(indicator).toHaveClass("text-xs", "text-(--vscode-descriptionForeground)")
	})

	it.each<[string, TaskletActivitySummary | undefined]>([
		["no activity summary", undefined],
		["zero active agents", { ...activity, activeCount: 0 }],
		["an unknown live count", { ...activity, activeCount: null }],
		["saved history", { ...activity, availability: "saved", activeCount: null }],
		["a saved count that is not live", { ...activity, availability: "saved" }],
	])("renders nothing for %s", (_description, taskletActivity) => {
		useChatStore.setState({ taskletActivity })
		const { container } = render(<TaskletActivityIndicator />)

		expect(container).toBeEmptyDOMElement()
	})

	it("appears and disappears as live activity starts, finishes, or is cleared", () => {
		const { container } = render(<TaskletActivityIndicator />)
		expect(container).toBeEmptyDOMElement()

		act(() => useChatStore.setState({ taskletActivity: activity }))
		expect(screen.getByTitle(tooltip)).toHaveTextContent("3 agents")

		act(() => useChatStore.setState({ taskletActivity: { ...activity, activeCount: 0 } }))
		expect(container).toBeEmptyDOMElement()

		act(() => useChatStore.setState({ taskletActivity: { ...activity, activeCount: 1 } }))
		expect(screen.getByTitle(tooltip)).toHaveTextContent("1 agent")

		act(() => useChatStore.setState({ taskletActivity: undefined }))
		expect(container).toBeEmptyDOMElement()
	})
})
