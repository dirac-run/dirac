import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { GoalChildToolEnvironmentFactory, type GoalChildSurfaceOwner } from "../GoalTaskEnvironment"

function owner(overrides: Partial<GoalChildSurfaceOwner> = {}): GoalChildSurfaceOwner {
	return {
		goalId: "goal-1",
		recordActivity: async () => undefined,
		recordResponse: async () => undefined,
		waitForInteraction: async () => ({
			action: DiracAskResponse.APPROVE,
			response: DiracAskResponse.APPROVE,
		}),
		...overrides,
	}
}

describe("GoalChildToolEnvironmentFactory", () => {
	it("routes a real child interaction to its Goal owner without using the Task wait queue", async () => {
		const { config, taskState } = createMockTaskConfig({
			overrides: { yoloModeToggled: false, isSubagentExecution: false },
		})
		let waits = 0
		const environment = new GoalChildToolEnvironmentFactory(
			"child-1",
			"task",
			owner({
				waitForInteraction: async () => {
					waits += 1
					return { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
				},
			}),
		).create(config, "respond")

		const card = await environment.ui.createCard({ header: "Question", requireFeedback: true })
		await card.waitForInteraction()

		assert.equal(waits, 1)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	it("keeps an auto-approved child permission local", async () => {
		const { config } = createMockTaskConfig({
			overrides: {
				yoloModeToggled: true,
				isSubagentExecution: false,
				autoApprover: { isUnrestrictedAutoApprove: () => true } as any,
			},
		})
		let waits = 0
		const environment = new GoalChildToolEnvironmentFactory(
			"child-1",
			"task",
			owner({
				waitForInteraction: async () => {
					waits += 1
					return { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
				},
			}),
		).create(config, "execute_command")

		const card = await environment.ui.createCard({
			header: "Permission",
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			permissionRequestKind: "tool",
		})
		await card.waitForInteraction()

		assert.equal(waits, 0)
	})

	// ToolExecutorCoordinator throws "left nonterminal card(s)" if the permission card is
	// still waiting when a Goal child's custom tool returns.
	for (const [action, expected] of [
		[DiracAskResponse.APPROVE, CardStatus.SUCCESS],
		[DiracAskResponse.REJECT, CardStatus.CANCELLED],
		[DiracAskResponse.MESSAGE, CardStatus.SKIPPED],
	] as const) {
		it(`askPermission finalizes a child permission card as ${expected} after ${action}`, async () => {
			const { config } = createMockTaskConfig({
				overrides: {
					yoloModeToggled: false,
					isSubagentExecution: false,
					autoApprover: { isUnrestrictedAutoApprove: () => false } as any,
				},
			})
			const environment = new GoalChildToolEnvironmentFactory(
				"child-1",
				"task",
				owner({ waitForInteraction: async () => ({ action, response: action }) }),
			).create(config, "my_custom_tool")

			const result = await environment.interaction.askPermission("May I?")

			assert.equal(result.card.status, expected)
		})
	}

	it("persists response cards with the recovery identity", async () => {
		const { config, taskMessenger } = createMockTaskConfig({
			overrides: { yoloModeToggled: false, isSubagentExecution: false },
		})
		const environment = new GoalChildToolEnvironmentFactory("child-1", "task", owner()).create(config, "respond")

		await environment.responseObserver.recordResponse({ operation: ResponseOperation.COMPLETE, text: "Done" })

		const params = taskMessenger.createCard.lastCall.args[0]
		assert.equal(params.toolName, "goal_child_response")
	})
})
