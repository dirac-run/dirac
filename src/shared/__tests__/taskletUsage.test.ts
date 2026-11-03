import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { CardStatus, type Card, type DiracMessage, DiracMessageType } from "../ExtensionMessage"
import { getApiMetrics, getLastApiReqInfo, getLastApiReqTotalTokens } from "../getApiMetrics"
import { getSubagentUsage } from "../subagentUsage"
import { getTaskletUsage, isTaskletUsageSnapshot, taskletUsageTotal, type TaskletUsageInfo } from "../taskletUsage"

const usage: TaskletUsageInfo = {
	source: "tasklet", taskletId: "tasklet-1", tokensIn: 100, tokensOut: 20,
	cacheWrites: 4, cacheReads: 8, cost: 0.5, reasoningTokens: 3,
}

function card(rawOutput: Record<string, unknown> = { ...usage }): Card {
	return { id: "accounting", header: "Localized accounting label", body: "Not JSON", status: CardStatus.SUCCESS, renderType: "text", rawOutput }
}

function message(id: string, rawOutput: Record<string, unknown>): DiracMessage {
	return { id, ts: 2, content: { type: DiracMessageType.CARD, card: { ...card(rawOutput), id } } }
}

describe("tasklet usage accounting", () => {
	it("reads structured accounting independently of presentation and legacy subagent usage", () => {
		assert.deepEqual(getTaskletUsage(card()), usage)
		assert.equal(getSubagentUsage(card()), undefined)
		assert.equal(getTaskletUsage({ ...card(), rawOutput: undefined, header: "Tasklet Usage", body: JSON.stringify(usage) }), undefined)
		assert.equal(getTaskletUsage(card({ ...usage, source: "subagents" })), undefined)
	})

	it("requires identity and finite required metrics and rejects malformed optional metrics", () => {
		for (const field of ["tokensIn", "tokensOut", "cost", "reasoningTokens"]) {
			for (const invalid of [undefined, "1", Number.NaN, Number.POSITIVE_INFINITY, null]) {
				assert.equal(getTaskletUsage(card({ ...usage, [field]: invalid })), undefined, `${field}: ${invalid}`)
			}
		}
		for (const field of ["cacheWrites", "cacheReads"]) {
			for (const invalid of ["1", Number.NaN, Number.NEGATIVE_INFINITY, null]) {
				assert.equal(getTaskletUsage(card({ ...usage, [field]: invalid })), undefined, `${field}: ${invalid}`)
			}
		}
		for (const taskletId of [undefined, "", 1, null]) assert.equal(getTaskletUsage(card({ ...usage, taskletId })), undefined)
		const { cacheWrites: _writes, cacheReads: _reads, ...withoutCaches } = usage
		assert.deepEqual(getTaskletUsage(card(withoutCaches)), withoutCaches)
	})

	it("validates durable primary and Utility snapshots without accepting malformed or negative usage", () => {
		const part = { tokensIn: 10, tokensOut: 2, cost: 0, reasoningTokens: 0 }
		assert.equal(isTaskletUsageSnapshot({ primary: part, utility: part }), true)
		assert.equal(isTaskletUsageSnapshot({ primary: { ...part, cacheWrites: 0 }, utility: part }), true)
		for (const invalid of [undefined, null, [], {}, { primary: part }, { primary: null, utility: part }]) {
			assert.equal(isTaskletUsageSnapshot(invalid), false)
		}
		for (const key of ["primary", "utility"]) {
			for (const field of ["tokensIn", "tokensOut", "cost", "reasoningTokens", "cacheWrites", "cacheReads"]) {
				for (const invalid of [-1, Number.NaN, Infinity, "1", null]) {
					assert.equal(isTaskletUsageSnapshot({ primary: part, utility: part, [key]: { ...part, [field]: invalid } }), false)
				}
			}
		}
	})

	it("combines primary and Utility usage without manufacturing unavailable cache counts", () => {
		const primary = { tokensIn: 10, tokensOut: 4, cost: 0.25, reasoningTokens: 2 }
		const utility = { tokensIn: 3, tokensOut: 1, cost: 0.125, reasoningTokens: 1 }
		assert.deepEqual(taskletUsageTotal({ primary, utility }), { tokensIn: 13, tokensOut: 5, cost: 0.375, reasoningTokens: 3 })
		assert.deepEqual(taskletUsageTotal({ primary: { ...primary, cacheWrites: 2 }, utility: { ...utility, cacheReads: 0 } }), {
			tokensIn: 13, tokensOut: 5, cost: 0.375, reasoningTokens: 3, cacheWrites: 2, cacheReads: 0,
		})
	})

	it("aggregates root, multiple tasklets and legacy subagents without changing root context metrics", () => {
		const main: DiracMessage = {
			id: "root", ts: 1, content: {
				type: DiracMessageType.API_STATUS, status: {
					tokensIn: 10, tokensOut: 5, cacheWrites: 2, cacheReads: 1, cost: 0.25, reasoningTokens: 1,
				}
			},
		}
		const messages = [
			main, message("child-1", { ...usage }),
			message("child-2", { ...usage, taskletId: "tasklet-2", tokensIn: 50, cost: 1 }),
			message("legacy", { source: "subagents", tokensIn: 7, tokensOut: 2, cacheWrites: 0, cacheReads: 0, cost: 0.125 }),
		]
		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 167)
		assert.equal(metrics.totalTokensOut, 47)
		assert.equal(metrics.totalCacheWrites, 10)
		assert.equal(metrics.totalCacheReads, 17)
		assert.equal(metrics.totalReasoningTokens, 7)
		assert.equal(metrics.totalCost, 1.875)
		assert.equal(metrics.cacheHitRate, 17 / (167 + 10 + 17))
		assert.equal(getLastApiReqTotalTokens(messages), 18)
		assert.equal(getLastApiReqInfo(messages), main.content.type === DiracMessageType.API_STATUS ? main.content.status : undefined)
		messages[1] = message("child-1", { ...usage, cost: 0.75 })
		assert.equal(getApiMetrics(messages).totalCost, 2.125)
	})

	it("ignores malformed tasklet metrics and retains unknown cache counts", () => {
		assert.equal(getApiMetrics([message("bad", { ...usage, cost: "bad" })]).totalCost, 0)
		const { cacheWrites: _writes, cacheReads: _reads, ...withoutCaches } = usage
		const metrics = getApiMetrics([message("child", withoutCaches)])
		assert.equal(metrics.totalCost, 0.5)
		assert.equal(metrics.totalCacheWrites, undefined)
		assert.equal(metrics.totalCacheReads, undefined)
	})
})
