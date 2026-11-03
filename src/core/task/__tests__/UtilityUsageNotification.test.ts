import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as utility from "@core/utility-model/UtilityModelRunner"
import { createDefaultTextCondensationTemplateRegistry } from "@core/text-condensation/templates"
import { LocalConversationCompaction } from "../LocalConversationCompaction"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"

const selection = { provider: "anthropic" as const, modelId: "claude-sonnet-4-20250514" }
const event: utility.UtilityModelUsageEvent = {
	selection,
	usage: { type: "usage", inputTokens: 11, outputTokens: 7, totalCost: 0.5 },
}

describe("Utility usage snapshot notifications", () => {
	afterEach(() => sinon.restore())

	for (const notify of [false, true]) {
		it(`records tool Utility usage before ${notify ? "notifying and observing" : "observing without a notification binding"}`, () => {
			const state = new TaskState()
			const order: string[] = []
			const capture = sinon.stub(utility, "createUtilityModelRunner").returns({} as utility.UtilityModelRunner)
			const harness = {
				taskState: state,
				ulid: "utility-notification-test",
				...(notify ? {
					onUtilityUsageRecorded: () => {
						assert.equal(state.utilityPermissionInputTokens, 11)
						assert.equal(state.utilityPermissionCost, 0.5)
						order.push("snapshot")
					}
				} : {}),
			}
				; (ToolExecutor.prototype as any).createUtilityRunner.call(harness, selection, {
					onUsage: (received: utility.UtilityModelUsageEvent) => {
						assert.equal(received, event)
						assert.equal(state.utilityPermissionOutputTokens, 7)
						order.push("observer")
					},
				}, {})
			capture.firstCall.args[2]!.onUsage!(event)
			assert.deepEqual(order, notify ? ["snapshot", "observer"] : ["observer"])
		})
	}

	it("notifies compaction usage synchronously after recording even when summary generation fails", async () => {
		const state = new TaskState()
		const notified = sinon.spy(() => {
			assert.equal(state.utilityPermissionInputTokens, 11)
			assert.equal(state.utilityPermissionCost, 0.5)
		})
		const compaction = new LocalConversationCompaction({
			taskState: state,
			ulid: "utility-compaction-notification-test",
			onUtilityUsageRecorded: notified,
			contextManager: { getTruncatedMessages: (messages: unknown[]) => messages },
			messageStateHandler: {
				getApiConversationHistory: () => [{ role: "user", content: "assignment" }],
			},
		} as any)
		const failure = new Error("summary generation stopped after usage")
		sinon.stub(utility.UtilityModelRunner.prototype, "run").callsFake(function (this: utility.UtilityModelRunner) {
			return (async function* (runner: any) {
				runner.options.onUsage(event)
				throw failure
			})(this)
		})
		await assert.rejects((compaction as any).generateSummary(
			selection, () => { throw new Error("provider must remain controlled") },
			createDefaultTextCondensationTemplateRegistry(), undefined, [],
		), (error: unknown) => error === failure)
		assert.equal(notified.callCount, 1)
	})
})
