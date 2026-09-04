import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { telemetryService } from "@/services/telemetry"
import type { ToolPermissionDisposition } from "../../autoApprove"
import { WriteToFileTool } from "./WriteToFileTool"

function makeEnvironment(backgroundEditEnabled: boolean, requiresUserInteraction: boolean) {
	const permissionCard = {
		requiresUserInteraction,
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
	}
	const createCard = sinon.stub().resolves(permissionCard)
	const assertMutationAuthorized = sinon.stub()
	const saveResult = { content: "saved", userEdits: false, autoFormatting: false }
	const editor = {
		showReview: sinon.stub().resolves(),
		hideReview: sinon.stub().resolves(),
		open: sinon.stub().resolves(),
		update: sinon.stub().resolves(),
		scrollToFirstDiff: sinon.stub().resolves(),
		saveChanges: sinon.stub().resolves(saveResult),
		applyAndSaveSilently: sinon.stub().resolves(saveResult),
	}
	const env = {
		config: {
			backgroundEditEnabled,
			callbacks: { assertMutationAuthorized },
			model: { id: "request-model", info: {} },
			providerId: "anthropic",
			ulid: "task-ulid",
		},
		ui: { createCard, upsertText: sinon.stub().resolves() },
		editor,
	}
	return { env, editor, createCard, permissionCard, assertMutationAuthorized, saveResult }
}

function write(env: ReturnType<typeof makeEnvironment>["env"], disposition: ToolPermissionDisposition, fileExists = true) {
	return (new WriteToFileTool() as any).awaitApprovalThenWriteFile(
		env,
		"/workspace/file.ts",
		"file.ts",
		"new content",
		fileExists,
		fileExists ? "old content" : "",
		disposition,
		true,
	)
}

function assertNoWrites(editor: ReturnType<typeof makeEnvironment>["editor"]) {
	sinon.assert.notCalled(editor.open)
	sinon.assert.notCalled(editor.update)
	sinon.assert.notCalled(editor.saveChanges)
	sinon.assert.notCalled(editor.applyAndSaveSilently)
}

const scenarios = [
	{ name: "manual", disposition: "manual_only", requiresUserInteraction: true },
	{ name: "utility escalation", disposition: "utility_eligible", requiresUserInteraction: true },
	{ name: "utility approval", disposition: "utility_eligible", requiresUserInteraction: false },
] as const

describe("WriteToFileTool background editing", () => {
	const sandbox = sinon.createSandbox()
	beforeEach(() => {
		sandbox.stub(telemetryService, "captureAiOutputAccepted")
		sandbox.stub(telemetryService, "captureAiOutputRejected")
	})
	afterEach(() => sandbox.restore())

	for (const scenario of scenarios) {
		for (const backgroundEditEnabled of [true, false]) {
			for (const fileExists of [true, false]) {
				it(`${scenario.name}: background=${backgroundEditEnabled} ${fileExists ? "modifies" : "creates"} only after approval`, async () => {
					const { env, editor, createCard, permissionCard, assertMutationAuthorized, saveResult } = makeEnvironment(
						backgroundEditEnabled,
						scenario.requiresUserInteraction,
					)
					createCard.callsFake(async () => {
						sinon.assert.notCalled(editor.showReview)
						return permissionCard
					})
					permissionCard.waitForInteraction.callsFake(async () => {
						assertNoWrites(editor)
						assert.equal(editor.showReview.callCount, scenario.requiresUserInteraction ? 1 : 0)
						return { action: DiracAskResponse.APPROVE }
					})

					const result = await write(env, scenario.disposition, fileExists)

					assert.equal(result, saveResult)
					sinon.assert.calledOnceWithExactly(assertMutationAuthorized, "write_to_file")
					sinon.assert.calledWithMatch(createCard, {
						requireApproval: true,
						permissionRequestKind: scenario.disposition === "manual_only" ? "manual_tool" : "tool",
						diffs: [{ path: "file.ts", oldText: fileExists ? "old content" : "", newText: "new content" }],
					})
					if (scenario.requiresUserInteraction || backgroundEditEnabled) {
						sinon.assert.calledOnceWithExactly(
							editor.applyAndSaveSilently,
							"/workspace/file.ts",
							"new content",
							fileExists ? "modify" : "create",
						)
						sinon.assert.callOrder(
							permissionCard.waitForInteraction,
							assertMutationAuthorized,
							editor.applyAndSaveSilently,
						)
						sinon.assert.notCalled(editor.open)
						sinon.assert.notCalled(editor.update)
						sinon.assert.notCalled(editor.saveChanges)
					} else {
						sinon.assert.notCalled(editor.applyAndSaveSilently)
						sinon.assert.calledOnceWithExactly(editor.open, "/workspace/file.ts", {
							editType: fileExists ? "modify" : "create",
						})
						sinon.assert.calledOnceWithExactly(editor.update, "new content", true)
						sinon.assert.calledOnce(editor.saveChanges)
					}
					assert.equal(editor.hideReview.callCount, scenario.requiresUserInteraction ? 1 : 0)
				})
			}

			it(`${scenario.name}: background=${backgroundEditEnabled} revalidates authorization after approval`, async () => {
				const { env, editor, permissionCard, assertMutationAuthorized } = makeEnvironment(
					backgroundEditEnabled,
					scenario.requiresUserInteraction,
				)
				assertMutationAuthorized.throws(new Error("Plan Mode revoked mutation"))
				await assert.rejects(write(env, scenario.disposition), /Plan Mode revoked mutation/)
				sinon.assert.callOrder(permissionCard.waitForInteraction, assertMutationAuthorized)
				assertNoWrites(editor)
				assert.equal(editor.hideReview.callCount, scenario.requiresUserInteraction ? 1 : 0)
			})

			if (scenario.requiresUserInteraction) {
				for (const action of [DiracAskResponse.REJECT, DiracAskResponse.MESSAGE]) {
					it(`${scenario.name}: background=${backgroundEditEnabled} ${action} never writes and cleans review`, async () => {
						const { env, editor, permissionCard, assertMutationAuthorized } = makeEnvironment(
							backgroundEditEnabled,
							true,
						)
						permissionCard.waitForInteraction.resolves({ action, text: "Try another approach" })
						assert.equal(typeof (await write(env, scenario.disposition)), "string")
						sinon.assert.notCalled(assertMutationAuthorized)
						sinon.assert.calledOnce(editor.showReview)
						sinon.assert.calledOnce(editor.hideReview)
						assertNoWrites(editor)
					})
				}
			}
		}
	}

	for (const key of ["file.ts", "/workspace/file.ts"]) {
		it(`preserves manual user edits keyed by ${key}`, async () => {
			const { env, editor, permissionCard } = makeEnvironment(true, true)
			permissionCard.waitForInteraction.resolves({ action: DiracAskResponse.APPROVE, userEdits: { [key]: "user content" } })
			const result = await write(env, "manual_only")
			sinon.assert.calledOnceWithExactly(editor.applyAndSaveSilently, "/workspace/file.ts", "user content", "modify")
			assert.equal(result.userEdits, true)
		})
	}

	it("cleans up review when waiting for approval fails", async () => {
		const { env, editor, permissionCard } = makeEnvironment(true, true)
		permissionCard.waitForInteraction.rejects(new Error("cancelled"))
		await assert.rejects(write(env, "manual_only"), /cancelled/)
		sinon.assert.calledOnce(editor.hideReview)
		assertNoWrites(editor)
	})

	for (const backgroundEditEnabled of [true, false]) {
		it(`preserves directly auto-approved routing with background=${backgroundEditEnabled}`, async () => {
			const { env, editor, createCard } = makeEnvironment(backgroundEditEnabled, false)
			await write(env, "auto_approve")
			sinon.assert.notCalled(createCard)
			sinon.assert.notCalled(editor.showReview)
			assert.equal(editor.applyAndSaveSilently.callCount, backgroundEditEnabled ? 1 : 0)
			assert.equal(editor.open.callCount, backgroundEditEnabled ? 0 : 1)
			sinon.assert.notCalled(editor.hideReview)
		})
	}
})
