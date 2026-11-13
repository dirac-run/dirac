import type { ComponentProps, PropsWithChildren } from "react"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useAppStore } from "@/app/store/appStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { TooltipProvider } from "@/shared/ui/tooltip"
import { updateSetting } from "../utils/settingsHandlers"
import ApprovalsSettingsSection from "./ApprovalsSettingsSection"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: PropsWithChildren<ComponentProps<"input">>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
}))
vi.mock("@/shared/hooks/useAutoApproveActions", () => ({
	useAutoApproveActions: () => ({ isChecked: vi.fn(), updateAction: vi.fn(), updateNotifications: vi.fn() }),
}))
vi.mock("@/shared/hooks/useAutoApproveAll", () => ({
	useAutoApproveAll: () => ({ updateAutoApproveAll: vi.fn() }),
}))
vi.mock("@/features/modular-ui/chat/components/AutoApprove/AutoApproveMenuItem", () => ({ default: () => null }))
vi.mock("./UserApprovedCommandsSection", () => ({ default: () => null }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: vi.fn() }))

const selection = { provider: "anthropic" as const, modelId: "claude-haiku-4-5" }
const policy = "Allow repository edits. Ask before network calls."

const renderApprovals = () => {
	render(
		<TooltipProvider>
			<ApprovalsSettingsSection renderSectionHeader={() => <h2>Approvals</h2>} />
		</TooltipProvider>,
	)
	return within(screen.getByRole("region", { name: "AI-assisted approvals" }))
}

beforeEach(() => {
	vi.clearAllMocks()
	useSettingsStore.setState({
		autoApproveAllToggled: false,
		autoApproveAllUpdateError: undefined,
		pendingAutoApproveAllToggled: undefined,
		remoteConfigSettings: {},
		strictPlanModeEnabled: false,
		utilityModelSelection: selection,
		utilityModelUsePermissionHandling: true,
		utilityModelPermissionPolicy: policy,
		yoloModeToggled: false,
	})
	useAppStore.setState({ showSettings: false, settingsTargetSection: undefined })
})

describe("Utility Model approvals reference", () => {
	it("prominently shows the selected provider, model, policy status, and approval fallback guidance", () => {
		const section = renderApprovals()

		expect(section.getByRole("heading", { name: "AI-assisted approvals" })).toBeVisible()
		expect(section.getByText("Enabled", { exact: true })).toBeVisible()
		expect(section.getByText("Anthropic")).toBeVisible()
		expect(section.getByText(selection.modelId)).toBeVisible()
		expect(section.getByText("Configured", { exact: true })).toBeVisible()
		expect(section.getByText(SETTINGS_HELP.utilityPermissionFallback)).toBeVisible()
		expect(section.queryByText(policy)).not.toBeInTheDocument()
		expect(section.queryByRole("textbox")).not.toBeInTheDocument()
		expect(section.queryByRole("combobox")).not.toBeInTheDocument()
		expect(section.queryByRole("checkbox")).not.toBeInTheDocument()
	})

	it("identifies a selected OpenAI Compatible profile", () => {
		useSettingsStore.setState({
			utilityModelSelection: { provider: "openai", modelId: "custom-utility-model", openAiProfileName: "Team endpoint" },
		})
		const section = renderApprovals()

		expect(section.getByText("OpenAI Compatible (Team endpoint)")).toBeVisible()
		expect(section.getByText("custom-utility-model")).toBeVisible()
	})

	it.each([
		{ model: undefined, policy, expected: "Not ready — missing Utility Model" },
		{ model: { ...selection, modelId: "" }, policy, expected: "Not ready — missing Utility Model" },
		{ model: { ...selection, modelId: " \n\t " }, policy, expected: "Not ready — missing Utility Model" },
		{ model: selection, policy: "", expected: "Not ready — missing permission policy" },
		{ model: selection, policy: " \n\t ", expected: "Not ready — missing permission policy" },
		{ model: undefined, policy: "", expected: "Not ready — missing Utility Model and permission policy" },
	])("shows $expected instead of Enabled", ({ model, policy: permissionPolicy, expected }) => {
		useSettingsStore.setState({ utilityModelSelection: model, utilityModelPermissionPolicy: permissionPolicy })
		const section = renderApprovals()

		expect(section.getByText(expected, { exact: true })).toBeVisible()
		expect(section.queryByText("Enabled", { exact: true })).not.toBeInTheDocument()
		if (!model?.modelId.trim()) expect(section.getAllByText("Not selected").length).toBeGreaterThan(0)
		if (!permissionPolicy.trim()) expect(section.getByText("Not configured", { exact: true })).toBeVisible()
	})

	it.each([true, false])("shows Disabled when permission handling is off, with configuration present=%s", (configured) => {
		useSettingsStore.setState({
			utilityModelUsePermissionHandling: false,
			utilityModelSelection: configured ? selection : undefined,
			utilityModelPermissionPolicy: configured ? policy : "",
		})
		const section = renderApprovals()

		expect(section.getByText("Disabled", { exact: true })).toBeVisible()
		expect(section.getByText(/Enable “Handle permission requests” in Utility Model/)).toBeVisible()
		expect(section.queryByText("Enabled", { exact: true })).not.toBeInTheDocument()
		expect(section.getByRole("button", { name: "Configure Utility Model" })).toBeEnabled()
	})

	it("navigates to the centralized Utility Model editor without changing any approval settings", () => {
		const settingsBefore = useSettingsStore.getState()
		const section = renderApprovals()

		fireEvent.click(section.getByRole("button", { name: "Configure Utility Model" }))

		expect(useAppStore.getState()).toMatchObject({ showSettings: true, settingsTargetSection: "utility-model" })
		expect(useSettingsStore.getState()).toBe(settingsBefore)
		expect(updateSetting).not.toHaveBeenCalled()
	})

	it("preserves the existing Strict Plan Mode and YOLO controls", () => {
		renderApprovals()

		fireEvent.click(screen.getByRole("checkbox", { name: "Strict Plan Mode" }))
		expect(updateSetting).toHaveBeenCalledWith("strictPlanModeEnabled", true)
		fireEvent.click(screen.getByRole("checkbox", { name: "YOLO Mode" }))
		expect(updateSetting).toHaveBeenCalledWith("yoloModeToggled", true)
	})
})
