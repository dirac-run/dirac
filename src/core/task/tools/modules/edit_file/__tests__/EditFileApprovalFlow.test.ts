import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { EditFileApprovalFlow } from "../EditFileApprovalFlow"
import type { PreparedFileBatch } from "../types"

const batches = [{
	absolutePath: "/workspace/file.ts",
	displayPath: "file.ts",
	prepared: { resolvedEdits: [{}], diff: "-before\n+after", content: "before", finalContent: "after" },
}] as unknown as PreparedFileBatch[]

function environment(executionProfile: string) {
	const card = {
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
		update: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
	}
	const env = {
		config: {
			executionProfile,
			autoApprover: { isUnrestrictedAutoApprove: sinon.stub().returns(false) },
			callbacks: { shouldAutoApproveToolWithPath: sinon.stub().resolves(false) },
		},
		ui: { createCard: sinon.stub().resolves(card) },
		editor: {
			showReview: sinon.stub().resolves(),
			scrollToFirstDiff: sinon.stub().resolves(),
			hideReview: sinon.stub().resolves(),
		},
	} as unknown as IToolEnvironment
	return { env, card }
}

describe("EditFileApprovalFlow current execution profiles", () => {
	for (const profile of ["standalone", "tasklet", "goal_coordinator", "goal_followup"]) {
		it(`requires path permission for ${profile} without Utility`, async () => {
			const { env, card } = environment(profile)
			const result = await new EditFileApprovalFlow().handle(env, batches, {})

			assert.equal(result.approved, false)
			sinon.assert.calledOnceWithExactly(env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub, "edit_file", "file.ts")
			sinon.assert.calledWithMatch(env.ui.createCard as sinon.SinonStub, {
				requireApproval: true,
				permissionOperation: { kind: "paths", paths: ["file.ts"] },
			})
			sinon.assert.calledOnce(card.waitForInteraction)
			sinon.assert.calledWithExactly(card.finalize, CardStatus.CANCELLED)
		})
	}

	it("retains explicit path auto-approval without opening a permission card", async () => {
		const { env, card } = environment("tasklet")
		;(env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub).resolves(true)

		assert.equal((await new EditFileApprovalFlow().handle(env, batches, {})).approved, true)
		sinon.assert.notCalled(env.ui.createCard as sinon.SinonStub)
		sinon.assert.notCalled(card.waitForInteraction)
	})
})
