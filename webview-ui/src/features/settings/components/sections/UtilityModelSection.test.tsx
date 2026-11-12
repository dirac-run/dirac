import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import UtilityModelSection from "./UtilityModelSection"

vi.mock("../MainModelSelection", () => ({ MainModelSelection: () => <div>Main selection</div> }))
vi.mock("../UtilityModelSelection", () => ({ default: () => <div>Utility selection</div> }))
vi.mock("../SubagentRolesSection", () => ({ SubagentRolesSection: () => <div>Role selections</div> }))
vi.mock("../utils/useApiConfigurationHandlers", () => ({ useApiConfigurationHandlers: () => ({ handleFieldsChange: vi.fn() }) }))

describe("Model configurations errors", () => {
	beforeEach(() => useSettingsStore.setState({ apiConfigurationError: undefined, apiConfiguration: {}, planActSeparateModelsSetting: false }))

	it("explains the shared Plan and Act model", () => {
		render(<UtilityModelSection />)
		expect(screen.getByText(SETTINGS_HELP.planAndActModel)).toBeVisible()
		expect(screen.queryByText(SETTINGS_HELP.planModel)).not.toBeInTheDocument()
	})

	it("explains Plan and Act separately when configured independently", () => {
		useSettingsStore.setState({ planActSeparateModelsSetting: true })
		render(<UtilityModelSection />)
		expect(screen.getByText(SETTINGS_HELP.planModel)).toBeVisible()
		expect(screen.getByText(SETTINGS_HELP.actModel)).toBeVisible()
		expect(screen.queryByText(SETTINGS_HELP.planAndActModel)).not.toBeInTheDocument()
	})

	it("shows main-model persistence errors on the page owning model selection", () => {
		useSettingsStore.setState({ apiConfigurationError: "save failed" })
		render(<UtilityModelSection />)
		expect(screen.getByRole("alert")).toHaveTextContent("Could not save model configuration: save failed")
	})
})
