import { SETTINGS_DESTINATION_IDS, SETTINGS_DESTINATIONS } from "@shared/settings-presentation"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import SettingsView, { resolveSettingsTarget } from "./SettingsView"

vi.mock("@/shared/ui/ViewHeader", () => ({ default: () => null }))
vi.mock("../sections/ApiConfigurationSection", () => ({ default: () => null }))
vi.mock("../sections/ApprovalsSettingsSection", () => ({ default: () => null }))
vi.mock("../sections/BrowserSettingsSection", () => ({ default: () => null }))
vi.mock("../sections/GeneralSettingsSection", () => ({ default: () => null }))
vi.mock("../sections/ResponsesContextSection", () => ({ default: () => null }))
vi.mock("../sections/RunningTasksSection", () => ({ default: () => null }))
vi.mock("../sections/TerminalSettingsSection", () => ({ default: () => null }))
vi.mock("../sections/ToolsSettingsSection", () => ({ default: () => null }))
vi.mock("../sections/UtilityModelSection", () => ({ default: () => null }))

describe("resolveSettingsTarget", () => {
	it("opens Models & API by default", () => {
		expect(resolveSettingsTarget()).toEqual({ tab: "models-api" })
	})

	it("preserves canonical destination IDs", () => {
		for (const id of SETTINGS_DESTINATION_IDS) expect(resolveSettingsTarget(id)).toEqual({ tab: id })
	})

	it.each([
		["api-config", { tab: "models-api" }],
		["user-approved-commands", { tab: "approvals", focusId: "user-approved-commands" }],
		["auto-approve", { tab: "approvals", focusId: "auto-approve-actions" }],
		["approved-command-rules", { tab: "approvals", focusId: "user-approved-commands" }],
		["strict-plan-mode", { tab: "approvals", focusId: "approval-policies" }],
		["yolo", { tab: "approvals", focusId: "yolo-mode" }],
		["auto-compact", { tab: "responses-context", focusId: "auto-condense-conversations" }],
		["low-verbosity-responses", { tab: "responses-context", focusId: "low-verbosity-responses" }],
		["dirac-web-tools", { tab: "tools", focusId: "web-search-fetch" }],
		["hooks", { tab: "tools", focusId: "hooks" }],
		["about", { tab: "general", focusId: "about" }],
		["debug", { tab: "general", focusId: "advanced-diagnostics" }],
	])("maps legacy target %s to its editable owner", (target, expected) => {
		expect(resolveSettingsTarget(target)).toEqual(expected)
	})

	it("falls back to Running Tasks while preserving an unknown feature focus ID", () => {
		expect(resolveSettingsTarget("future-feature")).toEqual({
			tab: "running-tasks",
			focusId: "future-feature",
		})
	})
})

describe("settings navigation rail", () => {
	it("starts collapsed with accessible destinations and the requested active tab", () => {
		render(createElement(SettingsView, { onDone: vi.fn(), targetSection: "tools" }))
		expect(screen.getByRole("navigation", { name: "Settings navigation" })).toHaveAttribute("data-expanded", "false")
		expect(screen.queryByText("Settings navigation")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /settings navigation/i })).not.toBeInTheDocument()
		expect(screen.getAllByRole("tab")).toHaveLength(SETTINGS_DESTINATION_IDS.length)
		expect(screen.getAllByRole("tab")[0]).toHaveAccessibleName(SETTINGS_DESTINATIONS["models-api"].label)
		for (const id of SETTINGS_DESTINATION_IDS) {
			expect(screen.getByRole("tab", { name: SETTINGS_DESTINATIONS[id].label })).toHaveAttribute(
				"aria-selected",
				String(id === "tools"),
			)
		}
	})

	it("collapses on mouseleave even when the clicked destination retains focus", async () => {
		const user = userEvent.setup()
		render(createElement(SettingsView, { onDone: vi.fn() }))
		const navigation = screen.getByRole("navigation", { name: "Settings navigation" })
		await user.hover(navigation)
		expect(navigation).toHaveAttribute("data-expanded", "true")
		const tools = screen.getByRole("tab", { name: SETTINGS_DESTINATIONS.tools.label })
		await user.click(tools)
		await user.unhover(tools)
		expect(tools).toHaveFocus()
		expect(tools).toHaveAttribute("aria-selected", "true")
		expect(navigation).toHaveAttribute("data-expanded", "false")
	})

	it("expands for keyboard focus and preserves arrow selection and Escape dismissal", async () => {
		const user = userEvent.setup()
		render(createElement(SettingsView, { onDone: vi.fn() }))
		const navigation = screen.getByRole("navigation", { name: "Settings navigation" })
		await user.tab()
		expect(navigation).toHaveAttribute("data-expanded", "true")
		expect(screen.getByRole("tab", { name: SETTINGS_DESTINATIONS["models-api"].label })).toHaveFocus()
		await user.keyboard("{ArrowDown}")
		const utility = screen.getByRole("tab", { name: SETTINGS_DESTINATIONS["utility-model"].label })
		expect(utility).toHaveFocus()
		expect(utility).toHaveAttribute("aria-selected", "true")
		await user.keyboard("{Escape}")
		expect(navigation).toHaveAttribute("data-expanded", "false")
		expect(utility).toHaveFocus()
	})

	it("expands on a touch destination selection and collapses when focus leaves", async () => {
		const user = userEvent.setup()
		render(
			createElement(
				"div",
				null,
				createElement(SettingsView, { onDone: vi.fn() }),
				createElement("button", null, "Outside navigation"),
			),
		)
		const navigation = screen.getByRole("navigation", { name: "Settings navigation" })
		const tools = screen.getByRole("tab", { name: SETTINGS_DESTINATIONS.tools.label })
		await user.pointer({ keys: "[TouchA]", target: tools })
		expect(tools).toHaveAttribute("aria-selected", "true")
		expect(navigation).toHaveAttribute("data-expanded", "true")
		await user.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: "Outside navigation" }) })
		expect(navigation).toHaveAttribute("data-expanded", "false")
	})
})
