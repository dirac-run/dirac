import type { OpenAiCodexUsageSnapshot } from "@shared/openai-codex-usage"
import { describe, expect, it } from "vitest"
import { getSubscriptionQuotaDisplay } from "./getSubscriptionQuotaDisplay"

const now = Date.UTC(2026, 5, 1)
const snapshot: OpenAiCodexUsageSnapshot = {
	quotaFetchedAt: now,
	rateLimits: [
		{
			limitId: "codex",
			primary: { usedPercent: 90, windowMinutes: 300, resetsAt: now / 1000 + 3600 },
			secondary: { usedPercent: 22, windowMinutes: 10080, resetsAt: now / 1000 + 86400 },
		},
	],
}

describe("getSubscriptionQuotaDisplay", () => {
	it("prefers weekly remaining quota and explains both windows and reset times", () => {
		const display = getSubscriptionQuotaDisplay(snapshot, now)
		expect(display.label).toBe("78% left")
		expect(display.description).toContain("5-hour: 10% remaining")
		expect(display.description).toContain("Weekly: 78% remaining")
		expect(display.description).toContain("Resets")
		expect(display.description).toContain("not task cost")
		expect(display.outdated).toBe(false)
	})

	it("uses actual durations rather than assuming secondary is weekly", () => {
		const display = getSubscriptionQuotaDisplay(
			{
				quotaFetchedAt: now,
				rateLimits: [
					{
						limitId: "codex",
						primary: { usedPercent: 40, windowMinutes: 60 },
						secondary: { usedPercent: 36, windowMinutes: 300 },
					},
				],
			},
			now,
		)
		expect(display.label).toBe("64% left")
	})

	it("prefers weekly over a longer window and ignores unrelated buckets", () => {
		const display = getSubscriptionQuotaDisplay(
			{
				quotaFetchedAt: now,
				rateLimits: [
					{ limitId: "other", primary: { usedPercent: 1, windowMinutes: 10080 } },
					{
						limitId: "codex",
						primary: { usedPercent: 50, windowMinutes: 10080 },
						secondary: { usedPercent: 20, windowMinutes: 43200 },
					},
				],
			},
			now,
		)
		expect(display.label).toBe("50% left")
	})

	it("does not invent a period when duration is missing", () => {
		expect(
			getSubscriptionQuotaDisplay(
				{
					quotaFetchedAt: now,
					rateLimits: [
						{
							limitId: "codex",
							secondary: { usedPercent: 20 },
						},
					],
				},
				now,
			).label,
		).toBe("80% left")
	})

	it.each([
		undefined,
		{ rateLimits: [] },
		{ rateLimits: [{ limitId: "other", primary: { usedPercent: 50 } }] },
	])("uses Subscription when the main quota is unavailable (%j)", (value) => {
		expect(getSubscriptionQuotaDisplay(value, now).label).toBe("Subscription")
	})

	it("marks old, untimestamped, and reset-passed snapshots as stale", () => {
		expect(getSubscriptionQuotaDisplay(snapshot, now + 16 * 60_000).label).toBe("78% left · stale")
		expect(getSubscriptionQuotaDisplay({ ...snapshot, quotaFetchedAt: undefined }, now).outdated).toBe(true)
		const resetPassed = getSubscriptionQuotaDisplay({ ...snapshot, quotaFetchedAt: now + 86400_000 }, now + 86400_000)
		expect(resetPassed.outdated).toBe(true)
		expect(resetPassed.description).toContain("Reset time has passed")
		expect(resetPassed.description).not.toContain("refreshing quietly")
	})

	it.each([
		[100, "0%"],
		[99.8, "<1%"],
		[0, "100%"],
	])("formats %s percent used as %s left", (usedPercent, expected) => {
		expect(
			getSubscriptionQuotaDisplay(
				{
					quotaFetchedAt: now,
					rateLimits: [
						{
							limitId: "codex",
							primary: { usedPercent: usedPercent as number, windowMinutes: 10080 },
						},
					],
				},
				now,
			).label,
		).toBe(`${expected} left`)
	})
})
