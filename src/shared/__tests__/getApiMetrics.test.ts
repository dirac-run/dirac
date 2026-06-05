import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DiracMessage, DiracMessageType } from "../ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
	it("includes subagent_usage in aggregate totals", () => {
		const messages: DiracMessage[] = [
			{
				id: "1",
				ts: 1,
				content: {
					type: DiracMessageType.API_STATUS,
					status: {
						tokensIn: 10,
						tokensOut: 20,
						cacheWrites: 3,
						cacheReads: 1,
						cost: 0.12,
					},
				},
			},
			{
				id: "2",
				ts: 2,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "card-2",
						header: "Subagent Usage",
						status: "success" as any,
						renderType: "text",
						body: JSON.stringify({
							source: "subagents",
							tokensIn: 4,
							tokensOut: 8,
							cacheWrites: 2,
							cacheReads: 1,
							cost: 0.05,
						}),
					},
				},
			},
			{
				id: "3",
				ts: 3,
				content: {
					type: DiracMessageType.API_STATUS,
					status: {
						tokensIn: 6,
						tokensOut: 9,
						cacheWrites: 1,
						cacheReads: 0,
						cost: 0.03,
					},
				},
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 20)
		assert.equal(metrics.totalTokensOut, 37)
		assert.equal(metrics.totalCacheWrites, 6)
		assert.equal(metrics.totalCacheReads, 2)
		assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
	})

	it("ignores malformed usage payloads", () => {
		const messages: DiracMessage[] = [
			{
				id: "1",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "card-1",
						header: "Subagent Usage",
						status: "success" as any,
						renderType: "text",
						body: "{not-json",
					},
				},
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: DiracMessage[] = [
			{
				id: "1",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "card-1",
						header: "Subagent Usage",
						status: "success" as any,
						renderType: "text",
						body: JSON.stringify({
							source: "subagents",
							tokensIn: 100,
							tokensOut: 200,
						}),
					},
				},
			},
			{
				id: "2",
				ts: 2,
				content: {
					type: DiracMessageType.API_STATUS,
					status: {
						tokensIn: 11,
						tokensOut: 7,
						cacheWrites: 2,
						cacheReads: 3,
					},
				},
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})
})
