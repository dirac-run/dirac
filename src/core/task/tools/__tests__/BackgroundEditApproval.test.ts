import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { SourceMutationPlan } from "@services/source-ast/types"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { IToolEnvironment } from "../interfaces/IToolEnvironment"
import { AstEditApproval } from "../modules/edit_ast/AstEditApproval"
import { AstEditFormatter } from "../modules/edit_ast/AstEditFormatter"
import { EditFileApprovalFlow } from "../modules/edit_file/EditFileApprovalFlow"
import type { PreparedFileBatch } from "../modules/edit_file/types"

const originalContent = "const oldName = 1"
const content = "const newName = 1"
const absolutePath = "/workspace/file.ts"
const displayPath = "file.ts"
const edit = { edit_type: "replace" as const, anchor: "Apple§const oldName = 1", text: content }
const batches: PreparedFileBatch[] = [
	{
		absolutePath,
		displayPath,
		blocks: [],
		prepared: {
			content: originalContent,
			finalContent: content,
			diff: "-const oldName = 1\n+const newName = 1",
			resolvedEdits: [{ lineIdx: 0, endIdx: 0, edit, editIndex: 0 }],
			failedEdits: [],
			appliedEdits: [],
			lines: [originalContent],
			lineHashes: [],
			finalLines: [content],
			displayPath,
			fileIndex: 0,
		},
	},
]
const plan: SourceMutationPlan = {
	operation: "rename",
	files: [
		{
			absolutePath,
			displayPath,
			originalContent,
			content,
			changedSymbols: ["oldName"],
			editCount: 1,
			edits: [{ startIndex: 6, endIndex: 13, replacement: "newName", symbol: "oldName", source: "rename" }],
		},
	],
	editCount: 1,
	unchangedTargets: [],
	failures: [],
}

function makeEnvironment(
	backgroundEditEnabled: boolean,
	disposition: "manual_only" | "utility_eligible" | "auto_approve",
	requiresUserInteraction: boolean,
) {
	const card = {
		requiresUserInteraction,
		update: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
	}
	const editor = {
		showReview: sinon.stub().resolves(),
		scrollToFirstDiff: sinon.stub().resolves(),
		hideReview: sinon.stub().resolves(),
		undoUserEdits: sinon.stub().resolves(),
	}
	const resolveToolPathPermission = sinon.stub().resolves(disposition)
	const createCard = sinon.stub().resolves(card)
	const env = {
		config: {
			backgroundEditEnabled,
			permissionDecisionBinding: { service: { decide: sinon.stub() }, configurationRevision: 1 },
			callbacks: { resolveToolPathPermission },
		},
		ui: { createCard, upsertText: sinon.stub().resolves() },
		editor,
	} as unknown as IToolEnvironment
	return { env, card, editor, resolveToolPathPermission, createCard }
}

const flows = [
	{
		tool: "edit_file",
		request: (env: IToolEnvironment) => new EditFileApprovalFlow().handle(env, batches, {}),
	},
	{
		tool: "edit_ast",
		request: (env: IToolEnvironment) =>
			new AstEditApproval(new AstEditFormatter()).request(
				env,
				{ operation: "rename", targets: [{ path: displayPath, symbol: "oldName", replacement: "newName" }] },
				plan,
				new Map(),
			),
	},
]
const scenarios = [
	{ name: "manual", disposition: "manual_only", requiresUserInteraction: true },
	{ name: "utility escalation", disposition: "utility_eligible", requiresUserInteraction: true },
	{ name: "utility approval", disposition: "utility_eligible", requiresUserInteraction: false },
] as const

for (const flow of flows) {
	describe(`${flow.tool} background approval review`, () => {
		for (const scenario of scenarios) {
			for (const backgroundEditEnabled of [true, false]) {
				it(`${scenario.name}: background=${backgroundEditEnabled} resolves permission before deciding to show review`, async () => {
					const { env, card, editor, resolveToolPathPermission, createCard } = makeEnvironment(
						backgroundEditEnabled,
						scenario.disposition,
						scenario.requiresUserInteraction,
					)
					createCard.callsFake(async () => {
						sinon.assert.notCalled(editor.showReview)
						return card
					})
					card.waitForInteraction.callsFake(async () => {
						assert.equal(editor.showReview.callCount, scenario.requiresUserInteraction ? 1 : 0)
						assert.equal(editor.scrollToFirstDiff.callCount, scenario.requiresUserInteraction ? 1 : 0)
						return { action: DiracAskResponse.APPROVE }
					})

					const result = await flow.request(env)

					assert.equal(result.approved, true)
					sinon.assert.calledOnceWithExactly(resolveToolPathPermission, flow.tool, displayPath)
					sinon.assert.calledOnce(card.waitForInteraction)
					sinon.assert.calledWithMatch(createCard, {
						requireApproval: true,
						renderType: "diff",
						permissionRequestKind: scenario.disposition === "manual_only" ? "manual_tool" : "tool",
					})
					if (flow.tool === "edit_ast") {
						assert.deepEqual(createCard.firstCall.args[0].diffs, [
							{ path: displayPath, oldText: originalContent, newText: content },
						])
					} else {
						assert.match(createCard.firstCall.args[0].body, /const newName = 1/)
					}
				})
			}
		}

		for (const disposition of ["manual_only", "utility_eligible"] as const) {
			for (const action of [DiracAskResponse.VIEW, DiracAskResponse.EDIT]) {
				it(`${disposition}: explicit ${action} reopens manual review in background mode`, async () => {
					const { env, card, editor } = makeEnvironment(true, disposition, true)
					card.waitForInteraction.onFirstCall().resolves({ action })
					const userEdits = { [absolutePath]: "const userName = 1" }
					card.waitForInteraction.onSecondCall().resolves({ action: DiracAskResponse.APPROVE, userEdits })

					const result = await flow.request(env)

					assert.equal(result.approved, true)
					assert.deepEqual(result.userEdits, userEdits)
					sinon.assert.calledTwice(card.waitForInteraction)
					sinon.assert.calledTwice(editor.showReview)
					sinon.assert.calledWithExactly(editor.showReview, [{ absolutePath, displayPath, content, originalContent }])
					sinon.assert.calledTwice(editor.scrollToFirstDiff)
				})
			}

			it(`${disposition}: rejecting a manual review still denies the edit`, async () => {
				const { env, card, editor } = makeEnvironment(true, disposition, true)
				card.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })

				const result = await flow.request(env)

				assert.equal(result.approved, false)
				sinon.assert.calledOnce(card.waitForInteraction)
				sinon.assert.calledOnce(editor.showReview)
				sinon.assert.calledOnce(editor.hideReview)
			})
		}

		it("keeps directly auto-approved edits silent without requesting approval", async () => {
			const { env, editor, createCard } = makeEnvironment(true, "auto_approve", false)
			const result = await flow.request(env)
			assert.equal(result.approved, true)
			sinon.assert.notCalled(createCard)
			sinon.assert.notCalled(editor.showReview)
			sinon.assert.notCalled(editor.scrollToFirstDiff)
		})
	})
}
