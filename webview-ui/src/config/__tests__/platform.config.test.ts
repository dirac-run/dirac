import { afterEach, describe, expect, it } from "vitest"
import { resolveTogglePlanActKeys } from "../platform.config"

describe("resolveTogglePlanActKeys", () => {
	const fallback = "Alt+Shift+a"

	afterEach(() => {
		// Reset any injected runtime config between tests
		if (typeof window !== "undefined") {
			window.__DIRAC_CONFIG__ = undefined
		}
	})

	it("returns the fallback when no override is provided", () => {
		expect(resolveTogglePlanActKeys(undefined, fallback)).toBe(fallback)
	})

	it("returns the fallback when the override is an empty string", () => {
		expect(resolveTogglePlanActKeys("", fallback)).toBe(fallback)
	})

	it("returns the fallback when the override is whitespace only", () => {
		expect(resolveTogglePlanActKeys("   ", fallback)).toBe(fallback)
	})

	it("returns the user override when one is provided", () => {
		expect(resolveTogglePlanActKeys("Meta+Shift+p", fallback)).toBe("Meta+Shift+p")
	})

	it("trims surrounding whitespace from the override", () => {
		expect(resolveTogglePlanActKeys("  Control+Alt+t  ", fallback)).toBe("Control+Alt+t")
	})

	it("ignores a non-string override and falls back", () => {
		expect(resolveTogglePlanActKeys(42 as unknown as string, fallback)).toBe(fallback)
		expect(resolveTogglePlanActKeys(null as unknown as string, fallback)).toBe(fallback)
	})
})
