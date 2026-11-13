import type { OpenAiCodexUsageSnapshot } from "@shared/openai-codex-usage"
import {
	formatOpenAiCodexFreshness,
	formatOpenAiCodexRemaining,
	formatOpenAiCodexReset,
	OPENAI_CODEX_USAGE_STALE_MS,
	selectOpenAiCodexDisplayWindows,
} from "@/features/settings/components/providers/openai-codex/formatOpenAiCodexUsage"

/** Account quota is separate from this task's accumulated monetary cost. */
export function getSubscriptionQuotaDisplay(snapshot: OpenAiCodexUsageSnapshot | undefined, now: number) {
	const windows = selectOpenAiCodexDisplayWindows(snapshot).filter(({ bucket }) => bucket.limitId === "codex")
	const weekly = windows.find(({ label }) => label === "Weekly")
	const longestKnownWindow = windows.reduce<(typeof windows)[number] | undefined>((longest, candidate) => {
		if (candidate.window.windowMinutes === undefined) return longest
		return !longest || candidate.window.windowMinutes > longest.window.windowMinutes! ? candidate : longest
	}, undefined)
	const selected = weekly ?? longestKnownWindow ?? windows[0]
	if (!selected) {
		return {
			label: "Subscription",
			description: "ChatGPT subscription quota is unavailable. View account details in API providers.",
			outdated: false,
		}
	}

	const fetchedAt = snapshot?.quotaFetchedAt
	const resetPassed = selected.window.resetsAt !== undefined && selected.window.resetsAt * 1_000 <= now
	const outdated = fetchedAt === undefined || now - fetchedAt > OPENAI_CODEX_USAGE_STALE_MS || resetPassed
	const remaining = formatOpenAiCodexRemaining(selected.window.usedPercent).replace(" remaining", "")
	const details = windows.map(({ label, window }) => {
		const reset =
			window.resetsAt !== undefined && window.resetsAt * 1_000 <= now
				? "Reset time has passed; refresh usage in API providers"
				: formatOpenAiCodexReset(window.resetsAt, now)
		return `${label}: ${formatOpenAiCodexRemaining(window.usedPercent)}. ${reset}.`
	})
	return {
		label: `${remaining} left${outdated ? " · stale" : ""}`,
		description: [
			"ChatGPT account quota (not task cost).",
			...details,
			formatOpenAiCodexFreshness(fetchedAt, now),
			...(outdated ? ["Quota may be outdated; refresh it in API providers."] : []),
			...(snapshot?.quotaError ? [snapshot.quotaError] : []),
		].join("\n"),
		outdated,
	}
}
