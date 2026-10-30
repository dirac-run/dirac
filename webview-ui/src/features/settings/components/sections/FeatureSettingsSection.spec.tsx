import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mockUpdateSetting = vi.fn()

vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: vi.fn(() => ({
		enableCheckpointsSetting: true,
		hooksEnabled: false,
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		useAutoCondense: false,
		subagentsEnabled: false,
		diracWebToolsEnabled: { user: true, featureFlag: true },
		worktreesEnabled: { user: true, featureFlag: true },
		focusChainSettings: { enabled: false, remindDiracInterval: 6 },
		remoteConfigSettings: {},
		enableParallelToolCalling: false,
		backgroundEditEnabled: false,
		lowVerbosityEnabled: true,
	})),
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("FeatureSettingsSection", () => {
	it("renders Hooks feature toggle", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Hooks")).toBeTruthy()

		const advancedSection = container.querySelector("#advanced-features")
		const agentSection = container.querySelector("#agent-features")

		expect(advancedSection).toBeTruthy()
		expect(agentSection).toBeTruthy()
		expect(within(advancedSection as HTMLElement).getByRole("switch", { name: "Hooks" })).toBeInTheDocument()
		expect(within(agentSection as HTMLElement).queryByRole("switch", { name: "Hooks" })).not.toBeInTheDocument()
	})

	it("calls updateSetting with hooksEnabled when toggled", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Hooks" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("hooksEnabled", true)
	})

	it("calls updateSetting with lowVerbosityEnabled when toggled", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Low-verbosity responses" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("lowVerbosityEnabled", false)
	})

	it("does not render the removed completion double-check toggle", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByRole("switch", { name: /double-check completion/i })).not.toBeInTheDocument()
		expect(container.querySelector("#double-check-completion")).not.toBeInTheDocument()
	})

	it("does not render the Utility Model toggle", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByRole("switch", { name: "Utility Model" })).not.toBeInTheDocument()
	})

})
