import { DiracApiReqInfo, DiracMessage } from "./ExtensionMessage"
import { getSubagentUsage } from "./subagentUsage"
import { getTaskletUsage, taskletUsageAvailability, type TaskletUsageAvailability } from "./taskletUsage"

export interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
	totalReasoningTokens: number
	/** Weighted-average cache hit rate: totalCacheReads / total prompt tokens */
	cacheHitRate: number
}

/** Availability is separate from numeric incurred counters, whose unknown fields retain placeholder zeroes. */
export function getApiUsageKnowledge(messages: DiracMessage[]): { usageObserved: boolean; usageAvailability: TaskletUsageAvailability } {
	const fields = {
		inputTokens: "tokensIn", outputTokens: "tokensOut", reasoningTokens: "reasoningTokens",
		cacheWrites: "cacheWrites", cacheReads: "cacheReads", cost: "cost",
	} as const
	const sources: TaskletUsageAvailability[] = []
	for (const message of messages) {
		if (message.content.type === "api_status") {
			const status = message.content.status
			const currentObserved = status.usageAvailability?.inputTokens || status.usageAvailability?.outputTokens ||
				Object.values(fields).some((key) => (status[key] ?? 0) > 0 || (!status.usageAvailability && status[key] !== undefined))
			const archivedObserved = status.deletedUsageAvailability?.inputTokens || status.deletedUsageAvailability?.outputTokens ||
				Object.values(fields).some((key) => (status.deletedMetrics?.[key] ?? 0) > 0 ||
					(!status.deletedUsageAvailability && status.deletedMetrics?.[key] !== undefined))
			for (const archived of [false, true]) {
				if (!(archived ? archivedObserved : currentObserved)) continue
				const availability = {} as TaskletUsageAvailability
				for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
					availability[field] = archived
						? (status.deletedUsageAvailability?.[field] ??
							((field === "inputTokens" || field === "outputTokens") && status.deletedMetrics?.[fields[field]] !== undefined))
						: (status.usageAvailability?.[field] ?? status[fields[field]] !== undefined)
				}
				sources.push(availability)
			}
		} else if (message.content.type === "card") {
			const usage = getTaskletUsage(message.content.card)
			if (usage && usage.usageObserved !== false) sources.push(taskletUsageAvailability(usage))
			const legacy = getSubagentUsage(message.content.card)
			if (legacy) sources.push({ inputTokens: true, outputTokens: true, reasoningTokens: false, cacheWrites: false, cacheReads: false, cost: false })
		}
	}
	return {
		usageObserved: sources.length > 0,
		usageAvailability: {
			inputTokens: sources.every((source) => source.inputTokens),
			outputTokens: sources.every((source) => source.outputTokens),
			reasoningTokens: sources.every((source) => source.reasoningTokens),
			cacheWrites: sources.every((source) => source.cacheWrites),
			cacheReads: sources.every((source) => source.cacheReads),
			cost: sources.every((source) => source.cost),
		},
	}
}

/**
 * Calculates API metrics from an array of DiracMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * - structured tasklet accounting cards, one replaceable cumulative contribution per child
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of DiracMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: DiracMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
		totalReasoningTokens: 0,
		cacheHitRate: 0,
	}

	messages.forEach((message) => {
		if (message.content.type === "api_status") {
			const { tokensIn, tokensOut, cacheWrites, cacheReads, cost, reasoningTokens } = message.content.status

			if (typeof tokensIn === "number") {
				result.totalTokensIn += tokensIn
			}
			if (typeof tokensOut === "number") {
				result.totalTokensOut += tokensOut
			}
			if (typeof cacheWrites === "number") {
				result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
			}
			if (typeof cacheReads === "number") {
				result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
			}
			if (typeof cost === "number") {
				result.totalCost += cost
			}
			if (typeof reasoningTokens === "number") {
				result.totalReasoningTokens += reasoningTokens
			}
			// Include deletedMetrics from checkpoint restore for accurate total tracking
			const deletedMetrics = message.content.status.deletedMetrics
			if (deletedMetrics) {
				if (typeof deletedMetrics.tokensIn === "number") result.totalTokensIn += deletedMetrics.tokensIn
				if (typeof deletedMetrics.tokensOut === "number") result.totalTokensOut += deletedMetrics.tokensOut
				if (typeof deletedMetrics.cacheWrites === "number")
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + deletedMetrics.cacheWrites
				if (typeof deletedMetrics.cacheReads === "number")
					result.totalCacheReads = (result.totalCacheReads ?? 0) + deletedMetrics.cacheReads
				if (typeof deletedMetrics.cost === "number") result.totalCost += deletedMetrics.cost
				if (typeof deletedMetrics.reasoningTokens === "number") result.totalReasoningTokens += deletedMetrics.reasoningTokens
			}
		} else if (message.content.type === "card") {
			const taskletUsage = getTaskletUsage(message.content.card)
			const usage = taskletUsage ?? getSubagentUsage(message.content.card)
			if (!usage) return
			result.totalTokensIn += usage.tokensIn
			result.totalTokensOut += usage.tokensOut
			if (usage.cacheWrites !== undefined) result.totalCacheWrites = (result.totalCacheWrites ?? 0) + usage.cacheWrites
			if (usage.cacheReads !== undefined) result.totalCacheReads = (result.totalCacheReads ?? 0) + usage.cacheReads
			result.totalCost += usage.cost
			result.totalReasoningTokens += taskletUsage?.reasoningTokens ?? 0
		}
	})

	// Compute weighted-average cache hit rate from aggregated totals
	const totalPromptTokens = result.totalTokensIn + (result.totalCacheWrites ?? 0) + (result.totalCacheReads ?? 0)
	result.cacheHitRate = totalPromptTokens > 0 ? (result.totalCacheReads ?? 0) / totalPromptTokens : 0

	return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of DiracMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: DiracMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.content.type === "api_status") {
			const info = msg.content.status
			const total = (info.tokensIn || 0) + (info.tokensOut || 0) + (info.cacheWrites || 0) + (info.cacheReads || 0)
			if (total > 0) {
				return total
			}
		}
	}
	return 0
}

/**
 * Gets the info from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of DiracMessage objects to process.
 * @returns A DiracApiReqInfo object from the last api_req_started message, or undefined if none found.
 */
export function getLastApiReqInfo(messages: DiracMessage[]): DiracApiReqInfo | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.content.type === "api_status") {
			const info = msg.content.status
			const total = (info.tokensIn || 0) + (info.tokensOut || 0) + (info.cacheWrites || 0) + (info.cacheReads || 0)
			if (total > 0) {
				return info
			}
		}
	}
	return undefined
}
