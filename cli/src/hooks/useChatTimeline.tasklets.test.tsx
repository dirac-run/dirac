import { type DiracMessage, DiracMessageType, CardStatus } from "@shared/ExtensionMessage"
import { createTaskletPresentationCard } from "@shared/taskletPresentation"
import { getApiMetrics } from "@shared/getApiMetrics"
import { describe, expect, it } from "vitest"
import { prepareTranscriptMessages } from "./useChatTimeline"

const root: DiracMessage = {
	id: "root",
	ts: 1,
	content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Delegate work" },
}

describe("tasklet projections retired from the parent timeline", () => {
	it.each([
		"running",
		"waiting",
		"completed",
		"failed",
		"interrupted",
	] as const)("hides historical %s projection cards instead of reopening them", (status) => {
		const card = createTaskletPresentationCard({
			taskletId: "child",
			title: "Worker",
			prompt: "Inspect",
			createdAt: 2,
			status,
			result: "Private result",
			communications: [],
			activity: [],
		})
		const messages: DiracMessage[] = [root, { id: card.id, ts: 2, content: { type: DiracMessageType.CARD, card } }]
		expect(prepareTranscriptMessages(messages)).toEqual([root])
	})
	it("hides accounting cards without changing durable contributions or operation receipts", () => {
		const usage: DiracMessage = {
			id: "usage",
			ts: 3,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "usage",
					header: "Tasklet usage",
					renderType: "text",
					status: CardStatus.SUCCESS,
					rawOutput: {
						source: "tasklet",
						taskletId: "child",
						tokensIn: 42,
						tokensOut: 7,
						cost: 0.25,
						reasoningTokens: 0,
					},
				},
			},
		}
		const receipt: DiracMessage = {
			id: "spawn",
			ts: 2,
			content: {
				type: DiracMessageType.CARD,
				card: { id: "spawn", header: "Agents accepted", renderType: "text", status: CardStatus.SUCCESS },
			},
		}
		const messages = [root, receipt, usage]
		const before = getApiMetrics(messages)
		expect(prepareTranscriptMessages(messages)).toEqual([root, receipt])
		expect(getApiMetrics(messages)).toEqual(before)
		expect(before.totalTokensIn).toBe(42)
		expect(before.totalCost).toBe(0.25)
		expect(messages).toHaveLength(3)
	})
})
