import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import UtilityModelSection from "./UtilityModelSection"

vi.mock("../MainModelSelection", () => ({ MainModelSelection: () => <div>Main selection</div> }))
vi.mock("../UtilityModelSelection", () => ({ default: () => <div>Utility selection</div> }))
vi.mock("../SubagentRolesSection", () => ({ SubagentRolesSection: () => <div>Role selections</div> }))
vi.mock("../utils/useApiConfigurationHandlers", () => ({ useApiConfigurationHandlers: () => ({ handleFieldsChange: vi.fn() }) }))

describe("Model configurations errors", () => {
	beforeEach(() => useSettingsStore.setState({ apiConfigurationError: undefined, apiConfiguration: {}, planActSeparateModelsSetting: false }))

	it("shows main-model persistence errors on the page owning model selection", () => {
		useSettingsStore.setState({ apiConfigurationError: "save failed" })
		render(<UtilityModelSection />)
		expect(screen.getByRole("alert")).toHaveTextContent("Could not save model configuration: save failed")
	})
})
