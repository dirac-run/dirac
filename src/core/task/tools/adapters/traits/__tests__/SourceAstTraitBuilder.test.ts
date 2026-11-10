import { strict as assert } from "node:assert"
import * as path from "node:path"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import * as workspace from "@core/workspace"
import { SourceAstService } from "@services/source-ast/SourceAstService"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { buildSourceAstTrait } from "../SourceAstTraitBuilder"

afterEach(() => sinon.restore())

describe("SourceAstTraitBuilder", () => {
	for (const method of ["outline", "implementations", "occurrences"] as const) {
		it(`does not start ${method} after cancellation during anchor preparation`, async () => {
			const { config } = createMockTaskConfig({ cwd: path.join(path.sep, "workspace") })
			let finishPreparation!: () => void
			const preparing = new Promise<void>((resolve) => { finishPreparation = resolve })
			sinon.stub(config.context, "ensureAnchorState").returns(preparing)
			const query = sinon.stub(SourceAstService.prototype, method).resolves({} as any)
			const controller = new AbortController()
			const pending = buildSourceAstTrait(config)[method]({ paths: ["a.ts"], symbols: ["run"], kind: "both", includeAnchors: true }, controller.signal)
			controller.abort(new Error("cancelled"))
			finishPreparation()
			await assert.rejects(pending, /cancelled/)
			sinon.assert.notCalled(query)
		})
	}

	it("prevents late anchor reconciliation from committing tool context", async () => {
		const { config } = createMockTaskConfig({ cwd: path.join(path.sep, "workspace") })
		let finishRead!: () => void
		const reading = new Promise<void>((resolve) => { finishRead = resolve })
		const reconcile = sinon.stub(AnchorStateManager, "reconcileWithChanges")
		const markDirty = sinon.spy(config.context, "markAnchorStateDirty")
		sinon.stub(SourceAstService.prototype, "outline").callsFake(async function (this: SourceAstService) {
			await reading
			const dependencies = (this as any).dependencies
			dependencies.reconcileAnchors("/workspace/a.ts", ["late"])
			return { files: [] }
		})
		const controller = new AbortController()
		const pending = buildSourceAstTrait(config).outline({ paths: ["a.ts"] }, controller.signal)
		controller.abort(new Error("cancelled"))
		finishRead()
		await assert.rejects(pending, /cancelled/)
		sinon.assert.notCalled(reconcile)
		sinon.assert.notCalled(markDirty)
	})

	it("forwards every source-AST request to its service facade", async () => {
		const cwd = path.join(path.sep, "workspace")
		const { config } = createMockTaskConfig({ cwd })
		const outlineRequest = { paths: ["src/a.ts"], includeAnchors: true }
		const implementationRequest = { paths: ["src/a.ts"], symbols: ["A.run"] }
		const occurrenceRequest = { paths: ["src"], symbols: ["run"], kind: "both" as const }
		const renameRequest = { paths: ["src"], symbol: "run", replacement: "execute" }
		const replacementRequest = { targets: [{ path: "src/a.ts", symbol: "A.run", replacement: "run() {}" }] }
		const outlineResult = { files: [] }
		const implementationResult = { targets: [] }
		const occurrenceResult = { targets: [], occurrences: [] }
		const renamePlan = { operation: "rename" as const, files: [], editCount: 0, unchangedTargets: [], failures: [] }
		const replacementPlan = { operation: "replace" as const, files: [], editCount: 0, unchangedTargets: [], failures: [] }

		const outline = sinon.stub(SourceAstService.prototype, "outline").resolves(outlineResult)
		const implementations = sinon.stub(SourceAstService.prototype, "implementations").resolves(implementationResult)
		const occurrences = sinon.stub(SourceAstService.prototype, "occurrences").resolves(occurrenceResult)
		const planRename = sinon.stub(SourceAstService.prototype, "planRename").resolves(renamePlan)
		const planReplacements = sinon.stub(SourceAstService.prototype, "planReplacements").resolves(replacementPlan)
		const getAnchorFingerprint = sinon.stub(SourceAstService.prototype, "getAnchorFingerprint").returns("fingerprint")

		const trait = buildSourceAstTrait(config)

		assert.equal(await trait.outline(outlineRequest), outlineResult)
		assert.equal(await trait.implementations(implementationRequest), implementationResult)
		assert.equal(await trait.occurrences(occurrenceRequest), occurrenceResult)
		assert.equal(await trait.planRename(renameRequest), renamePlan)
		assert.equal(await trait.planReplacements(replacementRequest), replacementPlan)
		assert.equal(trait.getAnchorFingerprint("/workspace/src/a.ts"), "fingerprint")
		sinon.assert.calledOnceWithExactly(outline, outlineRequest)
		sinon.assert.calledOnceWithExactly(implementations, implementationRequest)
		sinon.assert.calledOnceWithExactly(occurrences, occurrenceRequest)
		sinon.assert.calledOnceWithExactly(planRename, renameRequest)
		sinon.assert.calledOnceWithExactly(planReplacements, replacementRequest)
		sinon.assert.calledOnceWithExactly(getAnchorFingerprint, "/workspace/src/a.ts")
	})

	it("adapts path resolution, access checks, anchors, and fingerprints into service dependencies", async () => {
		const cwd = path.join(path.sep, "workspace")
		const absolutePath = path.join(cwd, "src", "a.ts")
		const validateAccess = sinon.stub().returns(true)
		const { config } = createMockTaskConfig({
			cwd,
			serviceOverrides: { diracIgnoreController: { validateAccess } as any },
		})
		sinon.stub(workspace, "resolveWorkspacePath").returns({ absolutePath, displayPath: "src/a.ts" } as any)
		const reconcile = sinon.stub(AnchorStateManager, "reconcileWithChanges").returns({
			anchors: ["anchor"],
			changed: false,
		})
		const fingerprint = sinon.stub(AnchorStateManager, "getDocumentFingerprint").returns("fingerprint")
		let capturedDependencies: any
		sinon.stub(SourceAstService.prototype, "outline").callsFake(async function (this: SourceAstService) {
			capturedDependencies = (this as any).dependencies
			return { files: [] }
		})

		const trait = buildSourceAstTrait(config)
		await trait.outline({ paths: ["src/a.ts"] })

		assert.deepEqual(await capturedDependencies.resolvePath("src/a.ts"), { absolutePath, displayPath: "src/a.ts" })
		assert.equal(capturedDependencies.validateAccess(absolutePath), true)
		assert.deepEqual(capturedDependencies.reconcileAnchors(absolutePath, ["line"]), ["anchor"])
		assert.equal(capturedDependencies.getAnchorFingerprint(absolutePath), "fingerprint")
		sinon.assert.calledOnceWithExactly(validateAccess, absolutePath)
		sinon.assert.calledOnceWithExactly(reconcile, absolutePath, ["line"], config.ulid)
		sinon.assert.calledOnceWithExactly(fingerprint, absolutePath, config.ulid)
	})
})
