import type { Card, DiracApiReqInfo } from "./ExtensionMessage"

export type TaskletUsageAvailability = NonNullable<DiracApiReqInfo["usageAvailability"]>

/** Cumulative usage attributable to one execution, independent of its context window. */
export interface TaskletUsage {
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	cost: number
	reasoningTokens: number
	/** False proves that this source has not incurred usage; absence means historical knowledge is unavailable. */
	usageObserved?: boolean
	/** Numeric counters retain incurred spend even when a complete field total is unavailable. */
	usageAvailability?: TaskletUsageAvailability
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

const availabilityFields = ["inputTokens", "outputTokens", "reasoningTokens", "cacheWrites", "cacheReads", "cost"] as const

/** Historical placeholder zeroes are not evidence that a complete metric is known. */
export function taskletUsageAvailability(usage: TaskletUsage): TaskletUsageAvailability {
	const available = usage.usageObserved === false
	if (!available && usage.usageAvailability) return usage.usageAvailability
	return {
		inputTokens: true, outputTokens: true, reasoningTokens: available,
		cacheWrites: available, cacheReads: available, cost: available,
	}
}

function isUsageKnowledgeValid(usage: Record<string, unknown>): boolean {
	if (usage.usageObserved !== undefined && typeof usage.usageObserved !== "boolean") return false
	if (usage.usageAvailability !== undefined) {
		const availability = usage.usageAvailability
		if (!availability || typeof availability !== "object" || Array.isArray(availability)) return false
		if (!availabilityFields.every((key) => typeof (availability as Record<string, unknown>)[key] === "boolean")) return false
	}
	// An explicit no-use observation cannot contradict incurred numeric counters.
	return usage.usageObserved !== false || ["tokensIn", "tokensOut", "cost", "reasoningTokens", "cacheWrites", "cacheReads"]
		.every((key) => usage[key] === undefined || usage[key] === 0)
}

/** Accounting identity comes from structured data, never card titles or display text. */
export function getTaskletUsage(card: Card): TaskletUsageInfo | undefined {
	const usage = card.rawOutput
	if (usage?.source !== "tasklet" || typeof usage.taskletId !== "string" || !usage.taskletId) return undefined
	const required = ["tokensIn", "tokensOut", "cost", "reasoningTokens"] as const
	if (!required.every((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]) && (usage[field] as number) >= 0)) return undefined
	const optional = ["cacheWrites", "cacheReads"] as const
	if (!optional.every((field) => usage[field] === undefined || (typeof usage[field] === "number" && Number.isFinite(usage[field]) && (usage[field] as number) >= 0))) return undefined
	if (!isUsageKnowledgeValid(usage)) return undefined
	return {
		source: "tasklet",
		taskletId: usage.taskletId,
		tokensIn: usage.tokensIn as number,
		tokensOut: usage.tokensOut as number,
		cost: usage.cost as number,
		reasoningTokens: usage.reasoningTokens as number,
		...(usage.cacheWrites !== undefined ? { cacheWrites: usage.cacheWrites as number } : {}),
		...(usage.cacheReads !== undefined ? { cacheReads: usage.cacheReads as number } : {}),
		...(usage.usageObserved !== undefined ? { usageObserved: usage.usageObserved as boolean } : {}),
		...(usage.usageAvailability !== undefined ? { usageAvailability: { ...usage.usageAvailability as TaskletUsageAvailability } } : {}),
	}
}

/** Keep partial incurred counters, certifying a field only when every attributable source reports it. */
export function taskletUsageTotal({ primary, utility }: TaskletUsageSnapshot): TaskletUsage {
	const sources = [primary, utility].filter((part) => part.usageObserved !== false)
	const knowledge = sources.map(taskletUsageAvailability)
	return {
		tokensIn: primary.tokensIn + utility.tokensIn,
		tokensOut: primary.tokensOut + utility.tokensOut,
		cost: primary.cost + utility.cost,
		reasoningTokens: primary.reasoningTokens + utility.reasoningTokens,
		...(primary.cacheWrites !== undefined || utility.cacheWrites !== undefined
			? { cacheWrites: (primary.cacheWrites ?? 0) + (utility.cacheWrites ?? 0) } : {}),
		...(primary.cacheReads !== undefined || utility.cacheReads !== undefined
			? { cacheReads: (primary.cacheReads ?? 0) + (utility.cacheReads ?? 0) } : {}),
		usageObserved: sources.length > 0,
		usageAvailability: {
			inputTokens: knowledge.every((part) => part.inputTokens),
			outputTokens: knowledge.every((part) => part.outputTokens),
			reasoningTokens: knowledge.every((part) => part.reasoningTokens),
			cacheWrites: knowledge.every((part) => part.cacheWrites),
			cacheReads: knowledge.every((part) => part.cacheReads),
			cost: knowledge.every((part) => part.cost),
		},
	}
}

/** Validate durable snapshots at the storage boundary, including unavailable fields and knowledge metadata. */
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
		) && isUsageKnowledgeValid(usage)
	})
}
