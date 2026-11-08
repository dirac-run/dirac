import type { GoalStatus, GoalViewState } from "@shared/goal"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import GoalHeader, { plainTextObjective } from "./GoalHeader"

vi.stubGlobal(
	"ResizeObserver",
	class ResizeObserver {
		observe() { }
		unobserve() { }
		disconnect() { }
	},
)

const goalServiceMocks = vi.hoisted(() => ({
	pauseGoal: vi.fn().mockResolvedValue(undefined),
	resumeGoal: vi.fn().mockResolvedValue(undefined),
	stopGoal: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/shared/api/grpc-client", () => ({
	GoalServiceClient: goalServiceMocks,
}))

function createGoal(status: GoalStatus, overrides: Partial<GoalViewState> = {}): GoalViewState {
	return {
		id: "goal-1",
		status,
		followUpActive: false,
		objective: {
			markdown: "## Ship **Goal UI** with [accessible controls](https://example.com)",
			revision: 3,
			updatedAt: 1_700_000_000_000,
		},
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_010_000,
		wallDurationMs: 120_000,
		activeDurationMs: 90_000,
		accounting: { totalTokens: 1_200, cost: 0.125 },
		mode: "act",
		modeSwitchingDisabled: true,
		modeSwitchingExplanation: "Mode switching is disabled while a Goal is active.",
		...overrides,
	}
}

afterEach(() => {
	cleanup()
	goalServiceMocks.pauseGoal.mockClear()
	goalServiceMocks.resumeGoal.mockClear()
	goalServiceMocks.stopGoal.mockClear()
	useSettingsStore.setState({ expandTaskHeader: false })
})

describe("GoalHeader", () => {
	it("offers ownership-checked resume for an active record without a local coordinator", () => {
		render(<GoalHeader goal={{ ...createGoal("working"), hasLocalExecution: false }} />)
		expect(screen.getByRole("button", { name: "Resume Goal" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Pause Goal" })).not.toBeInTheDocument()
	})

	it("renders a plain-text objective preview and keeps Goal disclosure state separate from task expansion", async () => {
		useSettingsStore.setState({ expandTaskHeader: true })
		const user = userEvent.setup()
		render(<GoalHeader goal={createGoal("working")} />)

		const disclosure = screen.getByRole("button", { name: "Expand Goal details" })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByText("Ship Goal UI with accessible controls")).toBeInTheDocument()
		expect(screen.queryByText(/\*\*Goal UI\*\*/)).not.toBeInTheDocument()
		expect(screen.getByRole("status", { name: "Goal status: working" })).toBeInTheDocument()
		expect(screen.queryByText("r3")).not.toBeInTheDocument()

		await user.click(disclosure)
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		const details = screen.getByRole("region", { name: "Goal operational details" })
		expect(details).toHaveClass("max-h-[45vh]", "overflow-y-auto")
		expect(
			within(details)
				.getAllByRole("heading", { level: 3 })
				.map((heading) => heading.textContent),
		).toEqual(["Status", "Objective", "Timing and accounting"])
		expect(within(details).queryByText("Revision 3")).not.toBeInTheDocument()
	})

	it("leaves generic agent observation to the common count and local snapshot surfaces", async () => {
		const user = userEvent.setup()
		render(<GoalHeader goal={createGoal("paused", { hasLocalExecution: false })} />)
		await user.click(screen.getByRole("button", { name: "Expand Goal details" }))
		const details = screen.getByRole("region", { name: "Goal operational details" })
		expect(within(details).getByText("Goal is paused.")).toBeInTheDocument()
		expect(within(details).queryByText("Contained Tasks")).not.toBeInTheDocument()
		expect(within(details).queryByText(/pending tasklet|pending request/)).not.toBeInTheDocument()
		expect(within(details).queryByText(/verification/i)).not.toBeInTheDocument()
	})

	it("shows only the contextual primary lifecycle action", () => {
		const { rerender } = render(<GoalHeader goal={createGoal("working")} />)
		expect(screen.getByRole("button", { name: "Pause Goal" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Resume Goal" })).not.toBeInTheDocument()

		rerender(<GoalHeader goal={createGoal("blocked")} />)
		expect(screen.getByRole("button", { name: "Resume Goal" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Pause Goal" })).not.toBeInTheDocument()

		rerender(<GoalHeader goal={createGoal("stopped")} />)
		expect(screen.queryByRole("button", { name: "Resume Goal" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "More Goal actions" })).not.toBeInTheDocument()

		rerender(<GoalHeader goal={createGoal("achieved")} />)
		expect(screen.queryByRole("button", { name: "Resume Goal" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "More Goal actions" })).not.toBeInTheDocument()
	})

	it("keeps Stop in overflow and confirms permanence and workspace preservation", async () => {
		const user = userEvent.setup()
		render(<GoalHeader goal={createGoal("paused")} />)

		expect(screen.queryByRole("button", { name: "Stop Goal" })).not.toBeInTheDocument()
		const overflowTrigger = screen.getByRole("button", { name: "More Goal actions" })
		await user.click(overflowTrigger)
		await user.click(await screen.findByRole("menuitem", { name: "Stop Goal…" }))

		const dialog = screen.getByRole("alertdialog", { name: "Stop this Goal permanently?" })
		expect(within(dialog).getByText(/This Goal cannot be resumed/)).toHaveTextContent(
			"Changes already made in your workspace remain; stopping does not revert them",
		)
		expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus()

		await user.click(within(dialog).getByRole("button", { name: "Stop Goal permanently" }))
		await waitFor(() => expect(goalServiceMocks.stopGoal).toHaveBeenCalledOnce())
		expect(goalServiceMocks.stopGoal.mock.calls[0][0]).toMatchObject({
			goalId: "goal-1",
			reason: "Stopped from the Goal header",
		})
		await waitFor(() => expect(overflowTrigger).toHaveFocus())
	})

	it("uses the existing Pause and Resume service calls", async () => {
		const user = userEvent.setup()
		const { rerender } = render(<GoalHeader goal={createGoal("waiting")} />)
		await user.click(screen.getByRole("button", { name: "Pause Goal" }))
		await waitFor(() => expect(goalServiceMocks.pauseGoal).toHaveBeenCalledOnce())
		expect(goalServiceMocks.pauseGoal.mock.calls[0][0]).toMatchObject({ goalId: "goal-1" })

		rerender(<GoalHeader goal={createGoal("paused")} />)
		await user.click(screen.getByRole("button", { name: "Resume Goal" }))
		await waitFor(() => expect(goalServiceMocks.resumeGoal).toHaveBeenCalledOnce())
		expect(goalServiceMocks.resumeGoal.mock.calls[0][0]).toMatchObject({ goalId: "goal-1" })
	})
})

describe("plainTextObjective", () => {
	it("removes preview formatting without dropping link or code labels", () => {
		expect(plainTextObjective("# Build **the** [`Goal`](https://example.com) `bar`")).toBe("Build the Goal bar")
	})
})
