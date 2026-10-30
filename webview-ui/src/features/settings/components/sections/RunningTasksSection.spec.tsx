import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import RunningTasksSection from "./RunningTasksSection"

const mockUpdateSetting = vi.fn()

vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: vi.fn(() => ({
		backgroundEditEnabled: false,
		enableCheckpointsSetting: true,
		enableParallelToolCalling: false,
		subagentsEnabled: false,
		worktreesEnabled: { user: true, featureFlag: true },
	})),
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("RunningTasksSection", () => {
	it("does not expose completion double-checking", () => {
		const { container } = render(<RunningTasksSection renderSectionHeader={() => null} />)

		expect(screen.queryByRole("switch", { name: /double-check completion/i })).not.toBeInTheDocument()
		expect(container.querySelector("#double-check-completion")).not.toBeInTheDocument()
	})

	it("preserves the ordinary subagent setting", () => {
		render(<RunningTasksSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Subagents" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("subagentsEnabled", true)
	})
})
