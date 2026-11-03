import { ApiHandler } from "@core/api"
import { DiracApiReqCancelReason } from "@shared/ExtensionMessage"
import { MessageStateHandler } from "./message-state"
import { calculateCost, updateApiReqMsg } from "./utils"

export interface StreamingMetrics {
	inputTokens: number
	outputTokens: number
	reasoningTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost: number | undefined
	availability: UsageMetricAvailability
}

export interface UsageMetricAvailability {
	inputTokens: boolean
	outputTokens: boolean
	reasoningTokens: boolean
	cacheWrites: boolean
	cacheReads: boolean
	cost: boolean
}

interface UsageChunk {
	inputTokens: number
	outputTokens: number
	reasoningTokens?: number
	thoughtsTokenCount?: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	totalCost?: number
}

/**
 * Encapsulates per-API-request token metrics accumulation and the
 * `updateApiReqMsg` call that persists them to the UI message.
 *
 * Both `attemptApiRequest` (error-retry path) and
 * `recursivelyMakeDiracRequests` (normal stream path) use a single
 * instance so metrics are never duplicated or out of sync.
 */
export class StreamingMetricsManager {
	private metrics: StreamingMetrics = {
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: undefined,
		availability: {
			inputTokens: false,
			outputTokens: false,
			reasoningTokens: false,
			cacheWrites: false,
			cacheReads: false,
			cost: false,
		},
	}

	constructor(
		private messageStateHandler: MessageStateHandler,
		private lastApiReqIndex: number,
		private api: ApiHandler,
	) { }

	/** Merge a usage chunk into the running totals. */
	updateFromChunk(chunk: UsageChunk): void {
		this.metrics.availability.inputTokens = true
		this.metrics.availability.outputTokens = true
		this.metrics.availability.reasoningTokens ||= chunk.reasoningTokens !== undefined || chunk.thoughtsTokenCount !== undefined
		this.metrics.availability.cacheWrites ||= chunk.cacheWriteTokens !== undefined
		this.metrics.availability.cacheReads ||= chunk.cacheReadTokens !== undefined
		this.metrics.inputTokens = chunk.inputTokens
		this.metrics.outputTokens = chunk.outputTokens
		this.metrics.reasoningTokens = chunk.reasoningTokens ?? chunk.thoughtsTokenCount ?? this.metrics.reasoningTokens
		this.metrics.cacheWriteTokens = chunk.cacheWriteTokens ?? this.metrics.cacheWriteTokens
		this.metrics.cacheReadTokens = chunk.cacheReadTokens ?? this.metrics.cacheReadTokens
		this.metrics.totalCost = chunk.totalCost ?? this.metrics.totalCost
		this.metrics.availability.cost = this.getTotalCost() !== undefined
	}

	/** Persist current metrics to the api_status dirac message. */
	async updateApiReqMsgFromMetrics(cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string, archiveForRetry = false): Promise<void> {
		const modelInfo = this.api.getModel().info
		const contextWindow = modelInfo.contextWindow
		const totalTokens =
			this.metrics.inputTokens +
			this.metrics.outputTokens +
			(this.metrics.cacheWriteTokens || 0) +
			(this.metrics.cacheReadTokens || 0)
		const contextUsagePercentage = contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined

		await updateApiReqMsg({
			messageStateHandler: this.messageStateHandler,
			lastApiReqIndex: this.lastApiReqIndex,
			inputTokens: this.metrics.inputTokens,
			outputTokens: this.metrics.outputTokens,
			reasoningTokens: this.metrics.reasoningTokens,
			cacheWriteTokens: this.metrics.cacheWriteTokens,
			cacheReadTokens: this.metrics.cacheReadTokens,
			api: this.api,
			totalCost: this.metrics.totalCost,
			usageAvailability: this.metrics.availability,
			cancelReason,
			streamingFailedMessage,
			contextWindow,
			contextUsagePercentage,
			archiveForRetry,
		})
	}

	/** Retire one failed attempt before the same API-status record is reused for its retry. */
	async archiveForRetry(): Promise<void> {
		await this.updateApiReqMsgFromMetrics("streaming_failed", undefined, true)
		this.metrics = {
			inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalCost: undefined,
			availability: { inputTokens: false, outputTokens: false, reasoningTokens: false, cacheWrites: false, cacheReads: false, cost: false },
		}
	}

	/** Compute the cost, using the provider-calculated value when available. Returns undefined when pricing is unknown. */
	getTotalCost(): number | undefined {
		return (
			this.metrics.totalCost ??
			calculateCost({
				inputTokens: this.metrics.inputTokens,
				outputTokens: this.metrics.outputTokens,
				cacheWriteTokens: this.metrics.cacheWriteTokens,
				cacheReadTokens: this.metrics.cacheReadTokens,
				reasoningTokens: this.metrics.reasoningTokens,
				api: this.api,
			})
		)
	}

	/** Return a snapshot of the current metrics. */
	getMetrics(): StreamingMetrics {
		return { ...this.metrics, availability: { ...this.metrics.availability } }
	}
}
