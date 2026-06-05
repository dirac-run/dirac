import { DiracApiReqInfo, DiracMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
	totalReasoningTokens: number
}

/**
 * Calculates API metrics from an array of DiracMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
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
		} else if (message.content.type === "card" && message.content.card.header === "Subagent Usage") {
			// Handle subagent usage cards
			try {
				const usage = JSON.parse(message.content.card.body || "{}")
				if (usage.tokensIn) result.totalTokensIn += usage.tokensIn
				if (usage.tokensOut) result.totalTokensOut += usage.tokensOut
				if (usage.cacheWrites) result.totalCacheWrites = (result.totalCacheWrites ?? 0) + usage.cacheWrites
				if (usage.cacheReads) result.totalCacheReads = (result.totalCacheReads ?? 0) + usage.cacheReads
				if (usage.cost) result.totalCost += usage.cost
			} catch {
				// Ignore parse errors
			}
		}
	})

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
