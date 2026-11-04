import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { GoalCoordinatorToolEnvironmentFactory } from "../GoalCoordinatorEnvironment"

describe("GoalCoordinatorToolEnvironmentFactory", () => {
	it("keeps coordinator tracking attached to the card that tools finalize", async () => {
		const { config } = createMockTaskConfig({
			overrides: { yoloModeToggled: false },
		})
		const factory = new GoalCoordinatorToolEnvironmentFactory(() => ({}) as any)
		const environment = factory.create(config, "execute_command")

		const card = await environment.ui.createCard({ header: "Execute" })
		await card.finalize(CardStatus.SUCCESS)

		assert.equal(environment.getCreatedCards().length, 1)
		assert.equal(environment.getCreatedCards()[0].status, CardStatus.SUCCESS)
	})

	it("owns only interactions that actually wait for the user", async () => {
		const { config } = createMockTaskConfig({
			overrides: { yoloModeToggled: false },
		})
		let ownedInteractions = 0
		const factory = new GoalCoordinatorToolEnvironmentFactory(() => ({}) as any, {
			duringUserInteraction: async (operation) => {
				ownedInteractions += 1
				return operation()
			},
		})
		const environment = factory.create(config, "respond")

		const card = await environment.ui.createCard({ header: "Question", requireFeedback: true })
		await card.waitForInteraction()

		assert.equal(ownedInteractions, 1)
	})

	it("does not expose an auto-approved permission as a Goal interaction", async () => {
		const { config } = createMockTaskConfig({
			overrides: {
				yoloModeToggled: true,
				autoApprover: { isUnrestrictedAutoApprove: () => true } as any,
			},
		})
		let ownedInteractions = 0
		const factory = new GoalCoordinatorToolEnvironmentFactory(() => ({}) as any, {
			duringUserInteraction: async (operation) => {
				ownedInteractions += 1
				return operation()
			},
		})
		const environment = factory.create(config, "execute_command")

		const card = await environment.ui.createCard({
			header: "Permission",
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			permissionRequestKind: "tool",
		})
		await card.waitForInteraction()

		assert.equal(card.requiresUserInteraction, false)
		assert.equal(ownedInteractions, 0)
	})
})
