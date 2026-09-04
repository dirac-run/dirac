import { randomUUID } from "node:crypto"
import { CardStatus, DiracMessageType, type Card, type DiracSubagentUsageInfo } from "@shared/ExtensionMessage"
import type { MessageStateHandler } from "../../../message-state"
import type { SubagentRunStats } from "../../subagent/SubagentRunTypes"

/** Persists one cumulative usage record per run, even when execution cards fail to render. */
export class SubagentUsagePublisher {
	private readonly id = randomUUID()
	private created = false
	private finished = false
	private pending = Promise.resolve()

	constructor(
		private readonly messages: Pick<MessageStateHandler, "addToDiracMessages" | "patchCardById">,
		private readonly publishState: () => Promise<void>,
		private readonly agentName: string,
	) {}

	update(stats: SubagentRunStats): Promise<void> {
		if (this.finished) return this.pending
		// UI publication is not part of the accounting queue: it may fail or never settle.
		return this.enqueue(stats, CardStatus.RUNNING).then(() => this.publishState())
	}

	async finish(stats: SubagentRunStats): Promise<void> {
		this.finished = true
		// The owning execution publishes its terminal state; never wait for a stalled UI here.
		await this.enqueue(stats, CardStatus.SUCCESS)
	}

	private enqueue(stats: SubagentRunStats, status: CardStatus): Promise<void> {
		const usage: DiracSubagentUsageInfo = {
			source: "subagents",
			tokensIn: stats.inputTokens,
			tokensOut: stats.outputTokens,
			cacheWrites: stats.cacheWriteTokens,
			cacheReads: stats.cacheReadTokens,
			cost: stats.totalCost,
		}
		const card: Card = {
			id: this.id,
			header: `Subagent usage: ${this.agentName}`,
			status,
			renderType: "text",
			collapsed: true,
			body: `$${usage.cost.toFixed(4)} · ${usage.tokensIn} input / ${usage.tokensOut} output tokens`,
			rawOutput: { ...usage },
		}
		this.pending = this.pending.then(async () => {
			if (this.created) {
				await this.messages.patchCardById(this.id, card)
			} else {
				await this.messages.addToDiracMessages({
					id: this.id,
					ts: Date.now(),
					content: { type: DiracMessageType.CARD, card },
				})
				this.created = true
			}
		})
		return this.pending
	}
}
