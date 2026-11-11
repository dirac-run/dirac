import { SandboxStatus } from "@shared/proto/dirac/state"
import { DEFAULT_SANDBOX_SETTINGS, SANDBOX_PROFILES, type SandboxSettings } from "@shared/SandboxSettings"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "@shared/settings-presentation"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import SandboxSettingsSection from "./SandboxSettingsSection"

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
beforeAll(() => Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})

let settings = DEFAULT_SANDBOX_SETTINGS
const custom = sandboxProfileFromDraft({ ...sandboxProfileDraft(), name: "Personal offline", network: "deny" }, "offline", 3)
const { getStatus, persist } = vi.hoisted(() => ({ getStatus: vi.fn(), persist: vi.fn() }))
vi.mock("@/shared/api/grpc-client", () => ({ StateServiceClient: { getSandboxStatus: getStatus } }))
vi.mock("../utils/settingsHandlers", () => ({ persistSetting: persist }))
vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: Object.assign(
		(select: (state: { sandboxSettings: SandboxSettings }) => unknown) => select({ sandboxSettings: settings }),
		{ getState: () => ({ sandboxSettings: settings }) },
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: ComponentProps<"input">) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeButton: ({ appearance: _, ...props }: ComponentProps<"button"> & { appearance?: string }) => <button {...props} />,
}))
const mount = () => render(<SandboxSettingsSection renderSectionHeader={() => null} />)
const enabled = (patch: Partial<SandboxSettings> = {}) => {
	settings = { ...DEFAULT_SANDBOX_SETTINGS, enabled: true, ...patch }
}
const manage = () => fireEvent.click(screen.getByRole("button", { name: "Manage" }))
const openNew = () => fireEvent.click(screen.getByRole("button", { name: "New", exact: true }))
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn()
			unobserve = vi.fn()
			disconnect = vi.fn()
		},
	)
	settings = DEFAULT_SANDBOX_SETTINGS
	getStatus.mockResolvedValue(SandboxStatus.create({ hostPlatform: "linux", available: false, effectiveState: "off" }))
	persist.mockResolvedValue({})
})
describe("Sandbox settings", () => {
	it("shows only the checkbox and disabled message while off, including with saved policies and fallback", async () => {
		settings = { ...DEFAULT_SANDBOX_SETTINGS, profiles: [custom], allowUnsandboxedFallback: true }
		getStatus.mockResolvedValue(
			SandboxStatus.create({ effectiveState: "off", hostPlatform: "darwin", limitations: ["Routine host diagnostic"] }),
		)
		mount()
		await waitFor(() => expect(getStatus).toHaveBeenCalledOnce())
		expect(screen.getByRole("checkbox", { name: "Sandbox commands" })).not.toBeChecked()
		expect(screen.getByText("Sandbox is disabled.")).toBeVisible()
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.queryByText(/fallback|Routine host diagnostic|Details and advanced/i)).not.toBeInTheDocument()
	})
	it("enables sandboxing without altering saved assignments or fallback", async () => {
		mount()
		fireEvent.click(screen.getByRole("checkbox", { name: "Sandbox commands" }))
		await waitFor(() =>
			expect(persist).toHaveBeenCalledWith("sandboxSettings", { ...DEFAULT_SANDBOX_SETTINGS, enabled: true }),
		)
	})
	it("shows main and subagent selectors first, explicit unrestricted Default and compact profile controls", async () => {
		enabled()
		mount()
		await screen.findByText(/Host: linux/)
		expect(screen.getAllByRole("combobox").map((select) => select.getAttribute("id"))).toEqual([
			"sandbox-mainAgentProfileId",
			"sandbox-subagentProfileId",
		])
		for (const select of screen.getAllByRole("combobox")) {
			expect(select.tagName).toBe("BUTTON")
			expect(select).toHaveTextContent("Default (unrestricted)")
			fireEvent.keyDown(select, { key: "ArrowDown" })
			expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
				"Default (unrestricted)",
				"Workspace",
				"Offline workspace",
				"Read-only",
			])
			fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
			await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument())
		}
		expect(screen.getByRole("button", { name: "New", exact: true })).toBeVisible()
		expect(screen.getByRole("button", { name: "Manage" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("button", { name: "Customize Workspace" })).not.toBeInTheDocument()
		expect(screen.getByRole("checkbox", { name: "Allow unsandboxed fallback" })).not.toBeVisible()
		fireEvent.click(screen.getByText("Details and advanced settings"))
		expect(screen.getByRole("checkbox", { name: "Allow unsandboxed fallback" })).toBeVisible()
	})
	it("groups settings and keeps routine host details collapsed without hiding default isolation guidance", async () => {
		enabled()
		getStatus.mockResolvedValue(
			SandboxStatus.create({
				hostPlatform: "linux",
				effectiveState: "native",
				available: true,
				limitations: ["Bubblewrap encodes workload signals as exit codes 128+signal."],
			}),
		)
		mount()
		expect(screen.getByRole("region", { name: "Agent profiles" })).toBeVisible()
		expect(screen.getByRole("region", { name: "Saved profiles" })).toBeVisible()
		expect(
			within(screen.getByRole("region", { name: "Agent profiles" })).getByText(/does not provide meaningful isolation/),
		).toBeVisible()
		const diagnostic = await screen.findByText(/Bubblewrap encodes/)
		expect(diagnostic).not.toBeVisible()
		fireEvent.click(screen.getByText("Details and advanced settings"))
		expect(diagnostic).toBeVisible()
	})
	it("assigns builtins and custom profiles explicitly", async () => {
		enabled({ profiles: [custom] })
		mount()
		fireEvent.keyDown(screen.getByLabelText("Main-agent profile"), { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "Workspace", exact: true }))
		await waitFor(() =>
			expect(persist).toHaveBeenLastCalledWith("sandboxSettings", { ...settings, mainAgentProfileId: "builtin-workspace" }),
		)
		await waitFor(() => expect(screen.getByLabelText("Subagent profile")).not.toBeDisabled())
		fireEvent.keyDown(screen.getByLabelText("Subagent profile"), { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: custom.name }))
		await waitFor(() =>
			expect(persist).toHaveBeenLastCalledWith("sandboxSettings", { ...settings, subagentProfileId: custom.id }),
		)
	})
	it("keeps current warnings and errors visible, not hidden in diagnostics", async () => {
		enabled()
		getStatus.mockResolvedValue(
			SandboxStatus.create({
				hostPlatform: "win32",
				effectiveState: "blocked",
				error: "Windows unavailable",
				remediation: "Disable sandbox execution",
				limitations: ["Native policy unavailable"],
			}),
		)
		mount()
		expect(await screen.findByText("Windows unavailable")).toBeVisible()
		expect(screen.getByText("Disable sandbox execution")).toBeVisible()
		expect(screen.getByText("Native policy unavailable")).toBeVisible()
		expect(screen.getByText(/Host: win32/)).not.toBeVisible()
	})
	it("retains critical configuration errors and explicit repair while disabled", async () => {
		getStatus.mockResolvedValue(
			SandboxStatus.create({
				effectiveState: "configuration-error",
				error: "Invalid profile",
				remediation: "Reset settings",
			}),
		)
		mount()
		expect(await screen.findByText("Invalid profile")).toBeVisible()
		expect(screen.getByText("Reset settings")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Reset sandbox settings to Default (Off)" }))
		await waitFor(() => expect(persist).toHaveBeenCalledWith("sandboxSettings", DEFAULT_SANDBOX_SETTINGS))
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
	})
	it("surfaces failed status requests with retry and save failures without claiming success", async () => {
		getStatus.mockRejectedValueOnce(new Error("Disconnected"))
		persist.mockRejectedValueOnce(new Error("Disk full"))
		mount()
		await screen.findByText(/Status unavailable: Error: Disconnected/)
		fireEvent.click(screen.getByRole("button", { name: "Retry status" }))
		await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
		fireEvent.click(screen.getByRole("checkbox", { name: "Sandbox commands" }))
		expect(await screen.findByText(/Could not save sandbox settings: Error: Disk full/)).toBeVisible()
		expect(screen.getByRole("checkbox", { name: "Sandbox commands" })).not.toBeChecked()
	})
	it("creates a named profile atomically and never assigns it on save", async () => {
		enabled()
		mount()
		openNew()
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
		await screen.findByText(/Invalid sandbox profile name/)
		expect(persist).not.toHaveBeenCalled()
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New workspace" } })
		fireEvent.click(within(screen.getByRole("group", { name: "Network" })).getByRole("radio", { name: "Blocked" }))
		expect(persist).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
		await waitFor(() => expect(persist).toHaveBeenCalledOnce())
		expect(persist.mock.calls[0][1]).toMatchObject({
			mainAgentProfileId: "default",
			subagentProfileId: "default",
			profiles: [{ name: "New workspace", network: "deny", filesystem: { base: "selected", workspace: "read-write" } }],
		})
	})
	it("keeps builtins immutable and Customize creates an unassigned copy", async () => {
		enabled()
		mount()
		manage()
		expect(screen.queryByRole("button", { name: "Edit Workspace" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Duplicate Default" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Customize Offline workspace" }))
		expect(screen.getByLabelText("Name")).toHaveValue("Offline workspace copy")
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
		await waitFor(() => expect(persist).toHaveBeenCalledOnce())
		const copy = persist.mock.calls[0][1].profiles[0]
		const builtin = SANDBOX_PROFILES.find((profile) => profile.id === "builtin-offline-workspace")
		expect(copy).toEqual({ ...builtin, id: copy.id, name: "Offline workspace copy", revision: 1 })
		expect(copy.id).not.toBe(builtin?.id)
		expect(persist.mock.calls[0][1].mainAgentProfileId).toBe("default")
		expect(builtin?.name).toBe("Offline workspace")
	})
	it("duplicates custom profiles exactly with a distinct identity and revision", async () => {
		enabled({ profiles: [custom] })
		mount()
		manage()
		fireEvent.click(screen.getByRole("button", { name: "Duplicate Personal offline" }))
		expect(screen.getByLabelText("Name")).toHaveValue("Personal offline copy")
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
		await waitFor(() => expect(persist).toHaveBeenCalledOnce())
		const copy = persist.mock.calls[0][1].profiles[1]
		expect(copy.id).not.toBe(custom.id)
		expect(copy).toEqual({ ...custom, id: copy.id, revision: 1, name: "Personal offline copy" })
	})
	it("cancels edits without persisting", async () => {
		enabled({ profiles: [custom] })
		mount()
		await screen.findByText(/Host: linux/)
		manage()
		fireEvent.click(screen.getByRole("button", { name: "Edit Personal offline" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(persist).not.toHaveBeenCalled()
	})
	it("uses focusable on-demand help and native radios operable by keyboard", async () => {
		const user = userEvent.setup()
		enabled()
		mount()
		await user.click(screen.getByRole("button", { name: "New", exact: true }))
		expect(screen.getByLabelText("Name")).toHaveFocus()
		const workspace = screen.getByRole("group", { name: "Workspace" })
		const readWrite = within(workspace).getByRole("radio", { name: "Read & write" })
		await user.tab()
		expect(screen.getByRole("button", { name: "About workspace" })).toHaveFocus()
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Access to workspace folders.")
		await user.tab()
		expect(readWrite).toHaveFocus()
		await user.keyboard("{ArrowLeft}")
		expect(within(workspace).getByRole("radio", { name: "Read-only" })).toBeChecked()
		expect(within(workspace).getByRole("radio", { name: "Read-only" })).toHaveFocus()
	})
})
