import { DiracMessageType } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import TaskHeader from "./TaskHeader"

vi.mock("../TaskletActivityIndicator", () => ({ TaskletActivityIndicator: () => null }))
vi.mock("./ContextWindow", () => ({ default: () => null }))
vi.mock("./buttons/CopyTaskButton", () => ({ default: () => null }))
vi.mock("./buttons/DeleteTaskButton", () => ({ default: () => null }))
vi.mock("./buttons/OpenDiskConversationHistoryButton", () => ({ default: () => null }))
vi.mock("./Highlights", () => ({ highlightText: (text: string) => text }))

beforeEach(() => {
	useSettingsStore.setState({
		mode: "act",
		expandTaskHeader: false,
		checkpointManagerErrorMessage: undefined,
		apiConfiguration: {
			actModeApiProvider: "openai-codex",
			actModeApiModelId: "gpt-5.4",
			planModeApiProvider: "anthropic",
		},
		openAiCodexIsAuthenticated: true,
		openAiCodexUsage: {
			quotaFetchedAt: Date.now(),
			rateLimits: [{ limitId: "codex", secondary: { usedPercent: 22, windowMinutes: 10080 } }],
		},
	})
})

const task = { id: "task", ts: 0, content: { type: DiracMessageType.MARKDOWN as const, content: "Inspect the repository" } }

it("places quota between context and cache without nesting a focus target in the disclosure button", () => {
	render(<TaskHeader task={task} totalCost={0} cacheHitRate={0.92} onClose={vi.fn()} />)
	const quota = screen.getByText("78% left")
	const context = screen.getByText("CTX")
	const cache = screen.getByText("92% cache")
	expect(context.compareDocumentPosition(quota) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	expect(quota.compareDocumentPosition(cache) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	expect(quota.closest("button")).toBeNull()
	fireEvent.click(screen.getByRole("button", { name: "Expand task header" }))
	expect(screen.getByRole("button", { name: "Collapse task header" })).toHaveAttribute("aria-expanded", "true")
})

it("uses the current mode's provider and never hides already accrued costs", () => {
	const { rerender } = render(<TaskHeader task={task} totalCost={0} cacheHitRate={0} onClose={vi.fn()} />)
	act(() => useSettingsStore.setState({ mode: "plan" }))
	expect(screen.queryByText("78% left")).not.toBeInTheDocument()
	expect(screen.getByText("$0.0000")).toBeInTheDocument()
	act(() => useSettingsStore.setState({ mode: "act" }))
	expect(screen.getByText("78% left")).toBeInTheDocument()
	rerender(<TaskHeader task={task} totalCost={0.5} cacheHitRate={0} onClose={vi.fn()} />)
	expect(screen.getByText("$0.5000")).toBeInTheDocument()
	expect(screen.queryByText("78% left")).not.toBeInTheDocument()
})
