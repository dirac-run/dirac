import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolTimeoutError } from "../ToolExecutionDeadline"
import { presentToolTimeout } from "../ToolTimeoutPresentation"

function fixture() {
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() } as unknown as ICardHandle
	const env = { ui: { createCard: sinon.stub().resolves(card) } } as unknown as IToolEnvironment
	return { card, env }
}

describe("Tool timeout presentation", () => {
	it("creates and finalizes a timeout card even when execution failed before a progress card existed", async () => {
		const { card, env } = fixture()
		const error = new ToolTimeoutError("read_file", "resolving a path", 2000)

		await assert.rejects(presentToolTimeout(env, error), (thrown) => thrown === error)

		sinon.assert.calledOnce(env.ui.createCard as sinon.SinonStub)
		sinon.assert.calledWithMatch(card.update as sinon.SinonStub, {
			status: CardStatus.ERROR,
			rawOutput: { operation: error.operation, timeoutMs: 2000, outcome: error.outcome },
		})
		sinon.assert.calledOnceWithExactly(card.finalize as sinon.SinonStub, CardStatus.ERROR)
	})

	it("terminalizes existing progress cards without creating duplicate timeout cards", async () => {
		const { card, env } = fixture()
		const error = new ToolTimeoutError("search_files", "searching", 2000)

		await assert.rejects(presentToolTimeout(env, error, [card]), (thrown) => thrown === error)

		sinon.assert.notCalled(env.ui.createCard as sinon.SinonStub)
		sinon.assert.calledOnceWithExactly(card.finalize as sinon.SinonStub, CardStatus.ERROR)
	})
})
