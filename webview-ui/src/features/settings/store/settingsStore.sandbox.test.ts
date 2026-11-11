import { describe, expect, it } from "vitest"
import { useSettingsStore } from "./settingsStore"

describe("fresh extension Sandbox settings", () => {
	it("starts off and never authorizes fallback before receiving persisted user settings", () => {
		const settings = useSettingsStore.getInitialState().sandboxSettings
		expect(settings.enabled).toBe(false)
		expect(settings.allowUnsandboxedFallback).toBe(false)
		expect(settings.mainAgentProfileId).toBe("default")
		expect(settings.subagentProfileId).toBe("default")
	})
})
