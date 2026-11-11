import { DEFAULT_SANDBOX_SETTINGS, getSandboxProfiles } from "@shared/SandboxSettings"
import { SETTINGS_DEFAULTS } from "@shared/storage/state-keys"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "@shared/settings-presentation"
import { SandboxStatus } from "@shared/proto/dirac/state"
import { describe, expect, it } from "vitest"
import { CLI_SETTINGS_DESTINATIONS } from "./constants"
import { createSandboxSettingsItems } from "./sandboxSettingsItems"
import { SettingsItemType, SettingsTab } from "./types"

const enabled = { ...DEFAULT_SANDBOX_SETTINGS, enabled: true }
describe("CLI Sandbox settings", () => {
	it("keeps a fresh CLI installation off before any user configuration", () => {
		const settings = SETTINGS_DEFAULTS.sandboxSettings!
		expect(settings.enabled).toBe(false)
		expect(settings.allowUnsandboxedFallback).toBe(false)
		expect(createSandboxSettingsItems(settings)[0].value).toBe(false)
	})
	it("renders only the command checkbox and disabled message while off", () => {
		expect(CLI_SETTINGS_DESTINATIONS.some((item) => item.key === SettingsTab.SANDBOX)).toBe(true)
		expect(createSandboxSettingsItems()).toEqual([
			expect.objectContaining({
				key: "sandboxEnabled",
				label: "Sandbox commands",
				type: SettingsItemType.CHECKBOX,
				value: false,
			}),
			expect.objectContaining({ key: "sandboxOff", value: "Sandbox is disabled." }),
		])
		expect(createSandboxSettingsItems(DEFAULT_SANDBOX_SETTINGS, undefined, undefined, true)).toHaveLength(2)
	})
	it("places main and subagent selectors before profiles and labels Default unrestricted", () => {
		const items = createSandboxSettingsItems(enabled)
		expect(items.slice(0, 4).map((item) => item.key)).toEqual([
			"sandboxEnabled",
			"sandbox:mainAgentProfileId",
			"sandbox:subagentProfileId",
			"sandboxProfiles",
		])
		const ids = getSandboxProfiles(enabled).map((profile) => profile.id)
		expect(items.filter((item) => item.type === SettingsItemType.CYCLE).map((item) => item.cycleOptions)).toEqual([ids, ids])
		expect(items.find((item) => item.key === "sandbox:mainAgentProfileId")?.value).toBe("Default (unrestricted)")
		expect(items.find((item) => item.key === "sandbox:subagentProfileId")?.label).toBe("Subagents")
	})
	it("offers immutable builtin customization and custom-only edit and duplicate actions", () => {
		const custom = sandboxProfileFromDraft({ ...sandboxProfileDraft(), name: "Build" }, "build", 1)
		const items = createSandboxSettingsItems({ ...enabled, profiles: [custom], subagentProfileId: "build" })
		expect(items.find((item) => item.key === "sandbox:subagentProfileId")?.value).toBe("Build")
		expect(items.find((item) => item.key === "sandboxCustomize:builtin-workspace")?.label).toBe("Customize Workspace…")
		expect(items.find((item) => item.key === "sandboxCustomize:builtin-offline-workspace")?.label).toBe(
			"Customize Offline workspace…",
		)
		expect(items.find((item) => item.key === "sandboxCustomize:builtin-read-only")?.label).toBe("Customize Read-only…")
		expect(
			items.some((item) => item.key === "sandboxEdit:builtin-workspace" || item.key === "sandboxDuplicate:default"),
		).toBe(false)
		expect(items.find((item) => item.key === "sandboxCreate")?.type).toBe(SettingsItemType.ACTION)
		expect(items.find((item) => item.key === "sandboxEdit:build")?.label).toBe("Edit Build")
		expect(items.find((item) => item.key === "sandboxDuplicate:build")?.label).toBe("Duplicate Build")
	})
	it("keeps routine fallback, diagnostics and technical prose behind Advanced", () => {
		const settings = { ...enabled, allowUnsandboxedFallback: true }
		const collapsed = createSandboxSettingsItems(settings)
		expect(
			collapsed.some((item) => ["sandboxFallback", "sandboxStatus", "sandboxDetails", "sandboxScope"].includes(item.key)),
		).toBe(false)
		expect(collapsed.find((item) => item.key === "sandboxAdvanced")?.label).toBe("▸ Advanced")
		const items = createSandboxSettingsItems(settings, undefined, undefined, true)
		expect(items.find((item) => item.key === "sandboxFallback")?.persistentHelp).toContain("without sandbox restrictions")
		expect(items.find((item) => item.key === "sandboxDetails")?.expandedHelp).toContain("custom tools")
		expect(items.find((item) => item.key === "sandboxDetails")?.expandedHelp).toContain("Never retries policy denials")
	})
	it("retains critical errors, remediation and explicit repair while disabled", () => {
		const items = createSandboxSettingsItems(
			DEFAULT_SANDBOX_SETTINGS,
			SandboxStatus.create({
				hostPlatform: "win32",
				effectiveState: "configuration-error",
				available: false,
				error: "Invalid saved configuration",
				remediation: "Reset sandbox settings",
				limitations: ["Windows native helper unavailable"],
			}),
		)
		expect(items.find((item) => item.key === "sandboxError")).toMatchObject({
			value: "Invalid saved configuration",
			persistentHelp: "Reset sandbox settings",
			alwaysShowHelp: true,
			helpTone: "error",
		})
		expect(items.find((item) => item.key === "sandboxReset")?.label).toBe("Reset sandbox settings (disabled)")
		expect(items.find((item) => item.key === "sandboxRefresh")?.type).toBe(SettingsItemType.ACTION)
		expect(items.some((item) => item.type === SettingsItemType.CYCLE)).toBe(false)
		expect(createSandboxSettingsItems().some((item) => item.key === "sandboxReset")).toBe(false)
	})
	it("keeps status discovery failures visible rather than reporting availability", () => {
		const items = createSandboxSettingsItems(DEFAULT_SANDBOX_SETTINGS, undefined, "RPC disconnected")
		expect(items.find((item) => item.key === "sandboxStatus")?.value).toContain("Availability is unknown")
		expect(items.find((item) => item.key === "sandboxStatus")?.value).toContain("RPC disconnected")
		expect(items.some((item) => item.key === "sandboxRefresh")).toBe(true)
	})
	it("does not treat legacy customs with a builtin id as immutable presets", () => {
		const custom = sandboxProfileFromDraft({ ...sandboxProfileDraft(), name: "Legacy" }, "builtin-workspace", 1)
		const items = createSandboxSettingsItems({ ...enabled, profiles: [custom] })
		expect(items.some((item) => item.key === "sandboxEdit:builtin-workspace")).toBe(true)
		expect(items.some((item) => item.key === "sandboxCustomize:builtin-workspace")).toBe(false)
	})
})
