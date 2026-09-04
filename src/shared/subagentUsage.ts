import type { Card, DiracSubagentUsageInfo } from "./ExtensionMessage"

/** Structured accounting records are independent of card titles and rendered text. */
export function getSubagentUsage(card: Card): DiracSubagentUsageInfo | undefined {
	if (card.rawOutput?.source === "subagents") {
		return parseUsage(card.rawOutput)
	}
	// Retain support for sessions saved before structured usage records.
	if (card.header !== "Subagent Usage") return undefined
	try {
		return parseUsage(JSON.parse(card.body || "{}"))
	} catch {
		return undefined
	}
}

function parseUsage(value: unknown): DiracSubagentUsageInfo | undefined {
	if (!value || typeof value !== "object") return undefined
	const usage = value as Record<string, unknown>
	const fields = ["tokensIn", "tokensOut", "cacheWrites", "cacheReads", "cost"] as const
	if (
		!fields.every(
			(field) => usage[field] === undefined || (typeof usage[field] === "number" && Number.isFinite(usage[field])),
		)
	) {
		return undefined
	}
	return {
		source: "subagents",
		tokensIn: (usage.tokensIn as number | undefined) ?? 0,
		tokensOut: (usage.tokensOut as number | undefined) ?? 0,
		cacheWrites: (usage.cacheWrites as number | undefined) ?? 0,
		cacheReads: (usage.cacheReads as number | undefined) ?? 0,
		cost: (usage.cost as number | undefined) ?? 0,
	}
}
