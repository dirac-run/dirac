import { render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import UtilityModelSelection from "./UtilityModelSelection"

vi.mock("./ModelSelectionEditor", () => ({ ModelSelectionEditor: () => <div>Utility selection</div> }))
vi.mock("./utils/settingsHandlers", () => ({ persistSetting: vi.fn(), updateSetting: vi.fn() }))

it("explains the Utility model before configuration", () => {
	useSettingsStore.setState({
		utilityModelSelection: undefined,
		utilityModelUseCondense: false,
		utilityModelUseGenerateCommitMessage: false,
		utilityModelUsePermissionHandling: false,
		utilityModelPermissionPolicy: "",
	})
	render(<UtilityModelSelection />)
	expect(screen.getByText(SETTINGS_HELP.utilityModel)).toBeVisible()
	expect(screen.getByText(SETTINGS_HELP.utilityDisclosure)).toBeVisible()
})
