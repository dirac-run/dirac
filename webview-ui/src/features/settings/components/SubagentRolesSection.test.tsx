import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelProviderSelection } from "@shared/api"
import { DEFAULT_SUBAGENT_ROLES } from "@shared/subagentRoles"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { convertProtoToSubagentRoles } from "@shared/proto-conversions/subagent-roles"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { SubagentRolesSection } from "./SubagentRolesSection"

const mocks = vi.hoisted(() => ({ persist: vi.fn() }))
vi.mock("./utils/settingsHandlers", () => ({ persistSetting: mocks.persist }))
vi.mock("./ModelSelectionEditor", () => ({
	ModelSelectionEditor: ({ onChange, onValidityChange }: { onChange: (selection: ModelProviderSelection) => void; onValidityChange: (valid: boolean) => void }) => <>
		<button onClick={() => onValidityChange(false)}>Change role provider</button>
		<button onClick={() => { onValidityChange(true); onChange({ provider: "openai", modelId: "role-model", openAiProfileName: "Local", reasoningEffort: "none", thinkingBudgetTokens: 0 }) }}>Select role model</button>
	</>,
}))

const main = { planModeApiProvider: "anthropic" as const, actModeApiProvider: "anthropic" as const, apiKey: "main-secret" }
const utility = { provider: "together" as const, modelId: "utility-model" }

describe("user-global subagent role settings", () => {
	beforeEach(() => {
		mocks.persist.mockReset().mockResolvedValue(undefined)
		useSettingsStore.setState({ subagentRoles: structuredClone(DEFAULT_SUBAGENT_ROLES), apiConfiguration: main, utilityModelSelection: utility })
	})

	it("offers Configure for starter roles without inventing models or a default row", () => {
		render(<SubagentRolesSection />)
		for (const role of DEFAULT_SUBAGENT_ROLES) {
			expect(screen.getByRole("button", { name: `Configure ${role.name}` })).toBeVisible()
			expect(screen.getByText(role.description)).toBeVisible()
			expect(screen.queryByRole("switch", { name: `Enable ${role.name}` })).not.toBeInTheDocument()
		}
		expect(screen.getAllByText("No model selected")).toHaveLength(DEFAULT_SUBAGENT_ROLES.length)
		expect(screen.getAllByText("Not configured")).toHaveLength(DEFAULT_SUBAGENT_ROLES.length)
		expect(screen.getByText(SETTINGS_HELP.subagentRoles)).toBeVisible()
		expect(screen.queryByLabelText("Edit default")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument()
		expect(mocks.persist).not.toHaveBeenCalled()
	})

	it("saves an enabled independent selection without touching main, Utility, or credentials", async () => {
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Configure Scout"))
		expect(screen.getByRole("switch", { name: "Role enabled" })).toBeDisabled()
		fireEvent.click(screen.getByText("Select role model"))
		fireEvent.click(screen.getByLabelText("Role enabled"))
		fireEvent.click(screen.getByText("Save role"))
		await waitFor(() => expect(screen.queryByText("Save role")).not.toBeInTheDocument())
		expect(screen.getByText(/\(Local\) \/ role-model/)).toBeVisible()
		expect(screen.getByRole("switch", { name: "Enable Scout" })).toBeChecked()
		expect(screen.getByText("Enabled")).toBeVisible()
		expect(mocks.persist).toHaveBeenCalledTimes(1)
		const [field, payload] = mocks.persist.mock.calls[0]
		expect(field).toBe("subagentRoles")
		expect(convertProtoToSubagentRoles(payload)[0]).toEqual(expect.objectContaining({ enabled: true, modelSelection: { provider: "openai", modelId: "role-model", openAiProfileName: "Local", reasoningEffort: "none", thinkingBudgetTokens: 0 } }))
		expect(JSON.stringify(payload)).not.toContain("main-secret")
		expect(useSettingsStore.getState().apiConfiguration).toEqual(main)
		expect(useSettingsStore.getState().utilityModelSelection).toEqual(utility)
	})

	it("allows an unconfigured custom role and offers configuration rather than an invalid enable action", async () => {
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByText("Add role"))
		expect(screen.getByLabelText("Role description")).toHaveAccessibleDescription(SETTINGS_HELP.subagentRoleDescription)
		expect(screen.getByText(SETTINGS_HELP.subagentRoleDescription)).toBeVisible()
		fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Researcher" } })
		fireEvent.change(screen.getByLabelText("Role description"), { target: { value: "Research APIs." } })
		fireEvent.click(screen.getByText("Save role"))
		await screen.findByLabelText("Configure Researcher")
		expect(screen.getByText("Research APIs.")).toBeVisible()
		expect(convertProtoToSubagentRoles(mocks.persist.mock.calls[0][1]).at(-1)).toEqual({ name: "Researcher", description: "Research APIs.", enabled: false })
		expect(screen.queryByLabelText("Enable Researcher")).not.toBeInTheDocument()
		fireEvent.click(screen.getByLabelText("Configure Researcher"))
		expect(screen.getByLabelText("Role enabled")).toBeDisabled()
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(mocks.persist).toHaveBeenCalledTimes(1)
	})

	it("shows a configured model and persists its labelled enable switch", async () => {
		useSettingsStore.setState({ subagentRoles: [{ ...DEFAULT_SUBAGENT_ROLES[0], modelSelection: { provider: "anthropic", modelId: "chosen-model" } }] })
		render(<SubagentRolesSection />)
		expect(screen.getByText("Anthropic / chosen-model")).toBeVisible()
		expect(screen.getByText("Disabled")).toBeVisible()
		expect(screen.getByLabelText("Edit Scout")).toBeVisible()
		fireEvent.click(screen.getByRole("switch", { name: "Enable Scout" }))
		await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Scout" })).toBeChecked())
		expect(convertProtoToSubagentRoles(mocks.persist.mock.calls[0][1])[0]).toEqual(expect.objectContaining({ enabled: true, modelSelection: { provider: "anthropic", modelId: "chosen-model" } }))
	})

	it("keeps the editor below its role and prevents replacing a draft until Save or Cancel", () => {
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Configure Scout"))
		const editor = screen.getByRole("group", { name: "Role settings" })
		expect(screen.getByLabelText("Configure Scout").compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(editor.compareDocumentPosition(screen.getByLabelText("Configure Reviewer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(within(editor).getByRole("button", { name: "Remove Scout" })).toBeVisible()
		fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Draft scout" } })
		expect(screen.getByLabelText("Configure Reviewer")).toBeDisabled()
		fireEvent.click(screen.getByLabelText("Configure Reviewer"))
		expect(screen.getByLabelText("Role name")).toHaveValue("Draft scout")
		expect(screen.queryByText("Add role")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Cancel"))
		fireEvent.click(screen.getByLabelText("Configure Reviewer"))
		expect(screen.getByLabelText("Role name")).toHaveValue("Reviewer")
		expect(mocks.persist).not.toHaveBeenCalled()
	})

	it("requires a description for a new role", async () => {
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByText("Add role"))
		fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Researcher" } })
		fireEvent.click(screen.getByText("Save role"))
		expect(await screen.findByRole("alert")).toHaveTextContent("Role description must be non-empty text")
		expect(mocks.persist).not.toHaveBeenCalled()
	})

	it.each(["default", "scout"])("rejects reserved or duplicate role name %s", async (name) => {
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByText("Add role"))
		fireEvent.change(screen.getByLabelText("Role name"), { target: { value: name } })
		fireEvent.change(screen.getByLabelText("Role description"), { target: { value: "Description." } })
		fireEvent.click(screen.getByText("Save role"))
		expect(await screen.findByRole("alert")).toBeVisible()
		expect(mocks.persist).not.toHaveBeenCalled()
	})

	it("persists an explicit empty wrapper when removing the last role from its editor", async () => {
		useSettingsStore.setState({ subagentRoles: [DEFAULT_SUBAGENT_ROLES[0]] })
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Configure Scout"))
		fireEvent.click(screen.getByLabelText("Remove Scout"))
		await waitFor(() => expect(screen.queryByLabelText("Configure Scout")).not.toBeInTheDocument())
		expect(screen.queryByRole("group", { name: "Role settings" })).not.toBeInTheDocument()
		expect(mocks.persist).toHaveBeenCalledWith("subagentRoles", { roles: [] })
	})

	it("blocks saving the previous selection after an incomplete provider change", () => {
		useSettingsStore.setState({ subagentRoles: [{ ...DEFAULT_SUBAGENT_ROLES[0], modelSelection: { provider: "anthropic", modelId: "old-model" } }] })
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Edit Scout"))
		fireEvent.click(screen.getByText("Change role provider"))
		expect(screen.getByText("Save role")).toBeDisabled()
		expect(screen.getByLabelText("Role enabled")).toBeDisabled()
		fireEvent.click(screen.getByText("Save role"))
		expect(mocks.persist).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("Select role model"))
		expect(screen.getByText("Save role")).not.toBeDisabled()
	})

	it("retains saved rows and the draft when persistence fails", async () => {
		mocks.persist.mockRejectedValueOnce(new Error("save failed"))
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Configure Scout"))
		fireEvent.change(screen.getByLabelText("Role description"), { target: { value: "Unsaved description" } })
		fireEvent.click(screen.getByText("Save role"))
		expect(await screen.findByRole("alert")).toHaveTextContent("save failed")
		expect(screen.getByLabelText("Configure Scout")).toBeVisible()
		expect(screen.getByLabelText("Role description")).toHaveValue("Unsaved description")
	})

	it("keeps the role and editor open when removal fails", async () => {
		mocks.persist.mockRejectedValueOnce(new Error("remove failed"))
		render(<SubagentRolesSection />)
		fireEvent.click(screen.getByLabelText("Configure Scout"))
		fireEvent.click(screen.getByLabelText("Remove Scout"))
		expect(await screen.findByRole("alert")).toHaveTextContent("remove failed")
		expect(screen.getByLabelText("Configure Scout")).toBeVisible()
		expect(screen.getByRole("group", { name: "Role settings" })).toBeVisible()
	})
})
