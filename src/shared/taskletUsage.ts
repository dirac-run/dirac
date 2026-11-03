import type { Card } from "./ExtensionMessage"

/** Cumulative usage attributable to one execution, independent of its context window. */
export interface TaskletUsage {
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	cost: number
	reasoningTokens: number
}

/** Primary and Utility spend remain distinguishable within a tasklet's durable record. */
export interface TaskletUsageSnapshot {
	primary: TaskletUsage
	utility: TaskletUsage
}

export interface TaskletUsageInfo extends TaskletUsage {
	source: "tasklet"
	taskletId: string
}

/** Accounting identity comes from structured data, never card titles or display text. */
export function getTaskletUsage(card: Card): TaskletUsageInfo | undefined {
	const usage = card.rawOutput
	if (usage?.source !== "tasklet" || typeof usage.taskletId !== "string" || !usage.taskletId) return undefined
	const required = ["tokensIn", "tokensOut", "cost", "reasoningTokens"] as const
	if (!required.every((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]))) return undefined
	const optional = ["cacheWrites", "cacheReads"] as const
	if (!optional.every((field) => usage[field] === undefined || (typeof usage[field] === "number" && Number.isFinite(usage[field])))) return undefined
	return {
		source: "tasklet",
		taskletId: usage.taskletId,
		tokensIn: usage.tokensIn as number,
		tokensOut: usage.tokensOut as number,
		cost: usage.cost as number,
		reasoningTokens: usage.reasoningTokens as number,
		...(usage.cacheWrites !== undefined ? { cacheWrites: usage.cacheWrites as number } : {}),
		...(usage.cacheReads !== undefined ? { cacheReads: usage.cacheReads as number } : {}),
	}
}

/** Combine lifetime snapshots without turning unavailable cache counts into reported zeroes. */
export function taskletUsageTotal({ primary, utility }: TaskletUsageSnapshot): TaskletUsage {
	return {
		tokensIn: primary.tokensIn + utility.tokensIn,
		tokensOut: primary.tokensOut + utility.tokensOut,
		cost: primary.cost + utility.cost,
		reasoningTokens: primary.reasoningTokens + utility.reasoningTokens,
		...(primary.cacheWrites !== undefined || utility.cacheWrites !== undefined
			? { cacheWrites: (primary.cacheWrites ?? 0) + (utility.cacheWrites ?? 0) } : {}),
		...(primary.cacheReads !== undefined || utility.cacheReads !== undefined
			? { cacheReads: (primary.cacheReads ?? 0) + (utility.cacheReads ?? 0) } : {}),
	}
}

/** Validate durable snapshots at the storage boundary, including unavailable cache fields. */
export function isTaskletUsageSnapshot(value: unknown): value is TaskletUsageSnapshot {
	if (!value || typeof value !== "object") return false
	const snapshot = value as Record<string, unknown>
	return [snapshot.primary, snapshot.utility].every((part) => {
		if (!part || typeof part !== "object") return false
		const usage = part as Record<string, unknown>
		return ["tokensIn", "tokensOut", "cost", "reasoningTokens"].every((key) =>
			typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0,
		) && ["cacheWrites", "cacheReads"].every((key) => usage[key] === undefined ||
			(typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0),
		)
	})
}
