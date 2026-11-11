import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "@shared/settings-presentation"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import SandboxProfileEditor from "./SandboxProfileEditor"

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
beforeAll(() => Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})

const save = vi.fn()
const cancel = vi.fn()
const profile: CustomSandboxProfile = sandboxProfileFromDraft(
	{
		...sandboxProfileDraft(),
		name: "Existing",
		description: "Advanced policy",
		base: "broad-read",
		workspace: "read-only",
		network: "deny",
		readable: "/opt/docs\n~/notes",
		writable: "/var/build",
		blocked: "/opt/private",
		caches: "~/.cache/npm\n/opt/pip-cache",
		temporaryDirectory: "/private-temp",
		passthrough: "PATH\nHOME\nCUSTOM_FLAG",
		overrides: "MODE=test\nVALUE=contains=equals",
	},
	"existing",
	9,
)
const mount = (entry = profile) => render(<SandboxProfileEditor onCancel={cancel} onSave={save} profile={entry} />)
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
beforeEach(() => {
	vi.clearAllMocks()
	save.mockResolvedValue(undefined)
})
describe("Sandbox capability editor", () => {
	it("groups independently labelled capability rows and keeps exact caches and advanced fields collapsed", () => {
		mount()
		expect(screen.getByRole("region", { name: "Capabilities" })).toBeInTheDocument()
		expect(screen.getByRole("region", { name: "Additional folders" })).toBeInTheDocument()
		for (const [name, labels] of [
			["Workspace", ["Read-only", "Read & write"]],
			["Other host files", ["Blocked", "Read-only"]],
			["Network", ["Blocked", "Allowed"]],
		] as const) {
			expect(
				within(screen.getByRole("group", { name }))
					.getAllByRole("radio")
					.map((radio) => radio.parentElement?.textContent),
			).toEqual(labels)
		}
		expect(screen.queryByRole("columnheader")).not.toBeInTheDocument()
		expect(screen.getByLabelText("Writable cache directories")).not.toBeVisible()
		fireEvent.click(screen.getByText("Package cache directories (2)"))
		expect(screen.getByLabelText("Writable cache directories")).toBeVisible()
		expect(screen.getByLabelText("Writable cache directories")).toHaveValue("~/.cache/npm\n/opt/pip-cache")
		expect(screen.getByLabelText("Environment passthrough names")).not.toBeVisible()
	})
	it("round trips every existing advanced field unchanged when saved without edits", async () => {
		mount()
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledWith(profile))
	})
	it("edits the filesystem base through the real themed select without changing other fields", async () => {
		mount()
		fireEvent.click(screen.getByText("Advanced", { exact: true }))
		const base = screen.getByRole("combobox", { name: "Filesystem base" })
		expect(base).toHaveTextContent("Entire host filesystem (read-only)")
		fireEvent.keyDown(base, { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "System runtime paths" }))
		expect(base).toHaveTextContent("System runtime paths")
		expect(save).not.toHaveBeenCalled()
		submit()
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({
				...profile,
				filesystem: { ...profile.filesystem, base: "selected" },
			}),
		)
	})
	it("dismisses the real select with Escape without changing its value", async () => {
		mount()
		fireEvent.click(screen.getByText("Advanced", { exact: true }))
		const base = screen.getByRole("combobox", { name: "Filesystem base" })
		fireEvent.keyDown(base, { key: "ArrowDown" })
		const option = await screen.findByRole("option", { name: "System runtime paths" })
		fireEvent.keyDown(option, { key: "Escape" })
		await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument())
		await waitFor(() => expect(base).toHaveFocus())
		expect(base).toHaveTextContent("Entire host filesystem (read-only)")
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledWith(profile))
	})
	it("changes one capability without rewriting advanced paths, environment or private temp", async () => {
		mount()
		fireEvent.click(within(screen.getByRole("group", { name: "Network" })).getByRole("radio", { name: "Allowed" }))
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledWith({ ...profile, network: "allow" }))
	})
	it("edits individual additional-folder access and exact cache directories without broad grants", async () => {
		mount()
		const folder = screen.getByRole("group", { name: "Folder 1" })
		expect(within(folder).getByLabelText("Path")).toHaveValue("/opt/docs")
		fireEvent.click(within(folder).getByRole("radio", { name: "Blocked" }))
		fireEvent.click(screen.getByRole("button", { name: "Add folder" }))
		const added = screen.getByRole("group", { name: "Folder 5" })
		fireEvent.change(within(added).getByLabelText("Path"), { target: { value: "/opt/output" } })
		fireEvent.click(within(added).getByRole("radio", { name: "Read/write" }))
		fireEvent.click(screen.getByText("Package cache directories (2)"))
		fireEvent.change(screen.getByLabelText("Writable cache directories"), { target: { value: "~/.cache/exact" } })
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledOnce())
		expect(save.mock.calls[0][0]).toEqual({
			...profile,
			filesystem: {
				...profile.filesystem,
				readable: ["~/notes"],
				writable: ["/var/build", "/opt/output"],
				blocked: ["/opt/docs", "/opt/private"],
				caches: ["~/.cache/exact"],
			},
		})
	})
	it("rejects empty and invalid additional paths before saving, and allows removing a row", async () => {
		mount()
		fireEvent.click(screen.getByRole("button", { name: "Add folder" }))
		submit()
		await screen.findByText(/Enter a path for each additional folder/)
		expect(save).not.toHaveBeenCalled()
		fireEvent.change(within(screen.getByRole("group", { name: "Folder 5" })).getByLabelText("Path"), {
			target: { value: "relative-path" },
		})
		submit()
		await screen.findByText(/Sandbox paths must be absolute/)
		expect(save).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Remove folder 5" }))
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledWith(profile))
	})
	it("synchronizes technical path edits with folder rows and preserves other advanced choices", async () => {
		mount()
		fireEvent.click(screen.getByText("Advanced", { exact: true }))
		fireEvent.change(screen.getByLabelText("Readable paths"), { target: { value: "/new-docs" } })
		expect(within(screen.getByRole("group", { name: "Folder 1" })).getByLabelText("Path")).toHaveValue("/new-docs")
		fireEvent.change(screen.getByLabelText("Environment overrides (NAME=value; avoid secrets)"), {
			target: { value: "ONLY=new" },
		})
		fireEvent.click(within(screen.getByRole("group", { name: "Workspace" })).getByRole("radio", { name: "Read & write" }))
		submit()
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({
				...profile,
				filesystem: { ...profile.filesystem, readable: ["/new-docs"], workspace: "read-write" },
				environment: { ...profile.environment, overrides: { ONLY: "new" } },
			}),
		)
	})
	it("keeps failed saves visible and retains the draft for retry", async () => {
		save.mockRejectedValueOnce(new Error("Cannot persist"))
		mount()
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retained draft" } })
		submit()
		expect(await screen.findByRole("alert")).toHaveTextContent("Cannot persist")
		expect(screen.getByLabelText("Name")).toHaveValue("Retained draft")
		submit()
		await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
	})
})
