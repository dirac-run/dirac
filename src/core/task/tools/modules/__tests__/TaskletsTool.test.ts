import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { IToolEnvironment, TaskletControls } from "../../interfaces/IToolEnvironment"
import { TaskletsTool, tasklets_spec } from "../use_subagents/UseSubagentsTool"

function fixture(controls: Partial<TaskletControls> = {}) {
	const finalized: CardStatus[] = []
	const environment = {
		orchestration: { tasklets: controls },
		ui: {
			createCard: async () => ({
				update: async () => {},
				finalize: async (status: CardStatus) => {
					finalized.push(status)
				},
			}),
		},
	} as unknown as IToolEnvironment
	return { environment, finalized }
}

describe("TaskletsTool input and result contracts", () => {
	it("describes acceptance, queued guidance, authority and non-consuming sleep", () => {
		assert.match(tasklets_spec.description, /queued, not necessarily consumed/)
		assert.match(tasklets_spec.description, /acceptance, not completion/)
		assert.match(tasklets_spec.description, /current parent authority/)
		assert.match(tasklets_spec.description, /without consuming events/)
	})

	it("rejects environments without parent controls", async () => {
		await assert.rejects(
			new TaskletsTool().processCall({ operation: "list" }, { orchestration: {} } as IToolEnvironment),
			/owning root/,
		)
	})

	for (const input of [
		null,
		[],
		{ operation: "spawn" },
		{ operation: "inspect" },
		{ operation: "steer", tasklet_id: "a" },
		{ operation: "list", tasklet_id: "a" },
		{ operation: "inspect", tasklet_id: "a", message: "ignored" },
		{ operation: "resolve", tasklet_id: "a", request_id: "r", resolution: "approve", answer: "yes" },
		{ operation: "resolve", tasklet_id: "a", request_id: "r", resolution: "answer", answer: " " },
		{ operation: "resolve", tasklet_id: "a", request_id: "r", resolution: "invalid" },
		{ operation: "sleep", timeout_ms: -1 },
		{ operation: "sleep", timeout_ms: 1.5 },
		{ operation: "sleep", timeout_ms: 2147483648 },
		{ operation: "sleep", tasklet_ids: [1] },
		{ operation: "sleep", tasklet_ids: [] },
		{ operation: "list", extra: true },
	]) {
		it(`rejects invalid input ${JSON.stringify(input)}`, async () => {
			const { environment, finalized } = fixture()
			await assert.rejects(new TaskletsTool().processCall(input, environment))
			assert.deepEqual(finalized, [])
		})
	}

	it("returns complete retained output without a preview cap", async () => {
		const result = { id: "a", responses: [{ response: "x".repeat(100000) }] }
		const { environment, finalized } = fixture({ inspect: () => result as any })
		assert.deepEqual(
			JSON.parse(await new TaskletsTool().processCall({ operation: "inspect", tasklet_id: "a" }, environment)),
			result,
		)
		assert.deepEqual(finalized, [CardStatus.SUCCESS])
	})

	it("maps question choices without granting permission", async () => {
		const { environment } = fixture({
			resolveInteraction: async (id, requestId, decision) => {
				assert.equal(id, "a")
				assert.equal(requestId, "r")
				assert.deepEqual(decision, {
					operation: "answer",
					response: {
						action: "choice-2",
						response: DiracAskResponse.MESSAGE,
						value: "choice-2",
						text: "Use option two",
					},
				})
				return { status: "resolved" }
			},
		})
		await new TaskletsTool().processCall(
			{
				operation: "resolve",
				tasklet_id: "a",
				request_id: "r",
				resolution: "answer",
				answer: "Use option two",
				action: "choice-2",
			},
			environment,
		)
	})

	it("finalizes failed operations without swallowing host errors", async () => {
		const { environment, finalized } = fixture({
			inspect: () => {
				throw new Error("unknown handle")
			},
		})
		await assert.rejects(
			new TaskletsTool().processCall({ operation: "inspect", tasklet_id: "missing" }, environment),
			/unknown handle/,
		)
		assert.deepEqual(finalized, [CardStatus.ERROR])
	})
})
