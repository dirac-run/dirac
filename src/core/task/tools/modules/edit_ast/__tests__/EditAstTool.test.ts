import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ToolSkippedByUserMessage } from "../../../types/ToolSkippedByUserMessage"
import { EditAstTool } from "../EditAstTool"

function card(status = CardStatus.RUNNING) {
	return {
		id: "card",
		header: "card",
		collapsed: true,
		renderType: "text" as const,
		status,
		update: sinon.stub().callsFake(async function (this: any, patch: any) {
			Object.assign(this, patch)
		}),
		finalize: sinon.stub().callsFake(async function (this: any, next: CardStatus) {
			this.status = next
		}),
		appendBody: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }),
	}
}

function makeEnv() {
	const progressCard = card()
	const approvalCard = card(CardStatus.WAITING_FOR_INPUT)
	const env = {
		config: {
			autoApprover: { isUnrestrictedAutoApprove: sinon.stub().returns(false) },
			callbacks: {
				shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
				resolveToolPathPermission: sinon.stub().resolves("auto_approve"),
				assertMutationAuthorized: sinon.stub(),
			},
		},
		workspace: {
			readFile: sinon.stub().resolves("const oldName = 1"),
		},
		sourceAst: {
			planRename: sinon.stub(),
			planReplacements: sinon.stub(),
		},
		ui: {
			createCard: sinon.stub().callsFake(async (params: any) => {
				const selected = params.requireApproval ? approvalCard : progressCard
				Object.assign(selected, params)
				return selected
			}),
			upsertText: sinon.stub().resolves(),
		},
		editor: {
			readText: sinon.stub().resolves("const oldName = 1"),
			showReview: sinon.stub().resolves(),
			scrollToFirstDiff: sinon.stub().resolves(),
			hideReview: sinon.stub().resolves(),
			undoUserEdits: sinon.stub().resolves(),
			applyAndSaveSilently: sinon
				.stub()
				.resolves({ content: "const newName = 1", userEdits: false, autoFormatting: false }),
		},
		diagnostics: {
			prepare: sinon.stub().resolves(),
			getRaw: sinon.stub().resolves([]),
		},
		orchestration: {
			getTaskState: sinon.stub().returns(0),
			setTaskState: sinon.stub(),
		},
		telemetry: { captureCustomMetadata: sinon.stub() },
	} as unknown as IToolEnvironment
	return { env, progressCard, approvalCard }
}

const renamePlan = {
	operation: "rename" as const,
	files: [
		{
			absolutePath: "/workspace/src/a.ts",
			displayPath: "src/a.ts",
			originalContent: "const oldName = 1",
			content: "const newName = 1",
			changedSymbols: ["oldName"],
			editCount: 1,
			edits: [{ startIndex: 6, endIndex: 13, replacement: "newName", symbol: "oldName", source: "rename" as const }],
		},
	],
	editCount: 1,
	unchangedTargets: [],
	failures: [],
}

describe("EditAstTool", () => {
	let tool: EditAstTool

	beforeEach(() => {
		tool = new EditAstTool()
	})

	it("does not write when planning has a failure", async () => {
		const { env } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves({
				...renamePlan,
				files: [],
				editCount: 0,
				failures: [{ status: "ambiguous", path: "src", symbol: "oldName", message: "ambiguous" }],
			})

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Ambiguous symbol/)
		sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	it("applies an auto-approved plan and finalizes the file card", async () => {
		const { env, progressCard } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed/)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
		sinon.assert.calledWith(progressCard.finalize, CardStatus.SUCCESS)
		sinon.assert.calledWith(env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub, "edit_ast", "src/a.ts")
	})

	it("saves successfully but reports diagnostics as unavailable on an unsupported host", async () => {
		const { env, progressCard } = makeEnv()
		const diagnostics = env.diagnostics!
		Object.assign(env, { diagnostics: undefined })
		const planRename = env.sourceAst.planRename as sinon.SinonStub
		planRename.resolves(renamePlan)

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed/)
		assert.match(result, /Diagnostics not available on this host\./)
		assert.doesNotMatch(result, /No diagnostics problems reported|Diagnostics collection failed/)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
		sinon.assert.notCalled(diagnostics.prepare as sinon.SinonStub)
		sinon.assert.notCalled(diagnostics.getRaw as sinon.SinonStub)
		sinon.assert.calledWith(progressCard.finalize, CardStatus.SUCCESS)
	})

	it("stops before the AST applier when mutation consent is revoked after approval", async () => {
		const { env } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (env.config.callbacks.assertMutationAuthorized as sinon.SinonStub).throws(new Error("Plan Mode revoked mutation"))

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Plan Mode revoked mutation/)
		sinon.assert.calledOnceWithExactly(env.config.callbacks.assertMutationAuthorized as sinon.SinonStub, "edit_ast")
		sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})


	it("asks the user to approve AST edits without Utility", async () => {
		const { env, approvalCard } = makeEnv()
			; (env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub).resolves(false)
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed/)
		sinon.assert.calledTwice(env.ui.createCard as sinon.SinonStub)
		sinon.assert.calledWithMatch(env.ui.createCard as sinon.SinonStub, { requireApproval: true })
		sinon.assert.calledOnce(approvalCard.waitForInteraction as sinon.SinonStub)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	it("does not apply AST edits rejected by the user without Utility", async () => {
		const { env, approvalCard } = makeEnv()
			; (env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub).resolves(false)
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (approvalCard.waitForInteraction as sinon.SinonStub).resolves({ action: DiracAskResponse.REJECT })

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.equal(result, "The user denied this operation.")
		sinon.assert.calledOnce(approvalCard.waitForInteraction as sinon.SinonStub)
		sinon.assert.calledWith(approvalCard.finalize as sinon.SinonStub, CardStatus.CANCELLED)
		sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	for (const modeSwitch of [undefined, "plan", "act"] as const) {
		it(`propagates ${modeSwitch ? `${modeSwitch} mode-switch` : "user-message"} skips after hiding review without finalizing cards as errors`, async () => {
			const { env, progressCard, approvalCard } = makeEnv()
			const skip = new ToolSkippedByUserMessage("New instructions", ["image"], ["file"], modeSwitch)
				; (env.config.callbacks.shouldAutoApproveToolWithPath as sinon.SinonStub).resolves(false)
				; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			approvalCard.waitForInteraction.rejects(skip)

			await assert.rejects(
				tool.processCall(
					{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
					env,
				),
				(error) => {
					sinon.assert.calledOnce(env.editor.hideReview as sinon.SinonStub)
					return error === skip
				},
			)

			sinon.assert.calledOnce(env.editor.showReview as sinon.SinonStub)
			sinon.assert.callOrder(approvalCard.waitForInteraction, env.editor.hideReview as sinon.SinonStub)
			assert.equal(approvalCard.status, CardStatus.WAITING_FOR_INPUT)
			assert.equal(progressCard.status, CardStatus.RUNNING)
			sinon.assert.notCalled(approvalCard.finalize)
			sinon.assert.notCalled(progressCard.finalize)
			sinon.assert.notCalled(approvalCard.update)
			sinon.assert.notCalled(env.config.callbacks.assertMutationAuthorized as sinon.SinonStub)
			sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
			sinon.assert.notCalled(env.orchestration.setTaskState as sinon.SinonStub)
			sinon.assert.notCalled(env.telemetry.captureCustomMetadata as sinon.SinonStub)
		})
	}

	it("routes Utility-eligible paths through the approval card", async () => {
		const { env, approvalCard } = makeEnv()
			; (env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, authorityMode: "act", configurationRevision: 1 }
			; (env.config.callbacks.resolveToolPathPermission as sinon.SinonStub).resolves("utility_eligible")
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed/)
		sinon.assert.calledWithMatch(env.ui.createCard as sinon.SinonStub, {
			requireApproval: true,
			permissionRequestKind: "tool",
		})
		sinon.assert.calledOnce(approvalCard.waitForInteraction as sinon.SinonStub)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	it("reports saved files when post-write observability fails", async () => {
		const { env, progressCard } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (progressCard.update as sinon.SinonStub).onSecondCall().rejects(new Error("card unavailable"))
			; (env.telemetry.captureCustomMetadata as sinon.SinonStub).throws(new Error("telemetry unavailable"))

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed/)
		assert.match(result, /Observability warning/)
		assert.match(result, /card update failed/)
		assert.match(result, /telemetry failed/)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
		sinon.assert.calledWith(progressCard.finalize, CardStatus.SUCCESS)
	})

	it("does not overwrite a file that changed after planning", async () => {
		const { env } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (env.editor.readText as sinon.SinonStub).resolves("const userChange = 1")

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /changed after the AST plan was created/)
		sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	it("preserves saved-file reporting when result formatting fails", async () => {
		const { env } = makeEnv()
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (tool as any).formatter.formatResult = sinon.stub().throws(new Error("formatter unavailable"))

		const result = await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		assert.match(result, /Rename completed: saved 1 of 1 file/)
		assert.match(result, /result formatting failed/)
		sinon.assert.calledOnce(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})

	it("sets approval cards to a terminal status before finalization", async () => {
		const { env, approvalCard } = makeEnv()
			; (env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, authorityMode: "act", configurationRevision: 1 }
			; (env.config.callbacks.resolveToolPathPermission as sinon.SinonStub).resolves("manual_only")
			; (env.sourceAst.planRename as sinon.SinonStub).resolves(renamePlan)
			; (approvalCard.finalize as sinon.SinonStub).rejects(new Error("finalization unavailable"))

		await tool.processCall(
			{ operation: "rename", targets: [{ path: "src", symbol: "oldName", replacement: "newName" }] },
			env,
		)

		sinon.assert.calledWithMatch(env.ui.createCard as sinon.SinonStub, {
			requireApproval: true,
			permissionRequestKind: "manual_tool",
		})

		assert.equal(approvalCard.status, CardStatus.SUCCESS)
		sinon.assert.notCalled(env.editor.applyAndSaveSilently as sinon.SinonStub)
	})
})
