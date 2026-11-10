import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { IToolEnvironment } from "../interfaces/IToolEnvironment"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

class ApprovalBoundaryTool implements IDiracTool {
	constructor(
		private readonly reachedPreparationBoundary: () => void,
		private readonly continueToApproval: Promise<void>,
	) { }

	spec(): DiracToolSpec {
		return { id: DiracDefaultTool.RESPOND, name: DiracDefaultTool.RESPOND, description: "test", parameters: [] }
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(_args: unknown, env: IToolEnvironment): Promise<string> {
		this.reachedPreparationBoundary()
		await this.continueToApproval
		const card = await env.ui.createCard({
			header: "Permission",
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
		})
		await card.waitForInteraction()
		await card.finalize(CardStatus.SUCCESS)
		return "done"
	}
}

function block() {
	return {
		type: "tool_use" as const,
		name: DiracDefaultTool.RESPOND,
		params: {},
	}
}

describe("ToolExecutorCoordinator live task settings", () => {
	for (const testCase of [
		{ name: "requires approval after YOLO is disabled", initialYolo: true, nextYolo: false },
		{ name: "auto-approves after YOLO is enabled", initialYolo: false, nextYolo: true },
	]) {
		it(testCase.name, async () => {
			let yoloModeToggled = testCase.initialYolo
			const { config, taskMessenger } = createMockTaskConfig()
			Object.defineProperty(config, "yoloModeToggled", {
				configurable: true,
				enumerable: true,
				get: () => yoloModeToggled,
			})

			const protocolCard = {
				id: "approval-card",
				getCard: () => ({ id: "approval-card", status: CardStatus.SUCCESS }),
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
			}
			taskMessenger.createCard.resolves(protocolCard)

			const reachedPreparationBoundary = deferred()
			const continueToApproval = deferred()
			const coordinator = new ToolExecutorCoordinator()
			coordinator.registerModularTool(
				new ApprovalBoundaryTool(reachedPreparationBoundary.resolve, continueToApproval.promise),
			)

			const execution = coordinator.execute(config, block())
			await reachedPreparationBoundary.promise
			yoloModeToggled = testCase.nextYolo
			continueToApproval.resolve()

			assert.equal((await execution).content, "done")
			if (testCase.nextYolo) {
				sinon.assert.calledWithMatch(taskMessenger.createCard, {
					status: CardStatus.RUNNING,
					requireApproval: false,
				})
				sinon.assert.notCalled(protocolCard.waitForInteraction)
				return
			}

			sinon.assert.calledWithMatch(taskMessenger.createCard, {
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
			})
			sinon.assert.calledOnce(protocolCard.waitForInteraction)
		})
	}
})
