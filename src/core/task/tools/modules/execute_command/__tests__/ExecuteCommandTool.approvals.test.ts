import assert from "node:assert/strict"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { CardStatus } from "@shared/ExtensionMessage"
import { TaskletCommandApprovals } from "../../../../TaskletCommandApprovals"
import { TaskCommandCapabilities, type TaskCommandCapabilitySnapshot } from "../../../../TaskCommandCapabilities"
import type { CardParams, IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { isSafeCommand } from "../../../utils/CommandSafetyChecker"
import { ExecuteCommandTool } from "../ExecuteCommandTool"

function rootAuthority(initial?: TaskCommandCapabilitySnapshot) {
	let durable = initial
	const persist = sinon.stub().callsFake(async (snapshot: TaskCommandCapabilitySnapshot) => { durable = structuredClone(snapshot) })
	return { capabilities: new TaskCommandCapabilities(async () => initial, persist), persist, durable: () => durable }
}

function fixture(options: { utility?: boolean; child?: boolean; masterGate?: boolean; root?: ReturnType<typeof rootAuthority>; multiRoot?: boolean } = {}) {
	const root = options.root ?? rootAuthority()
	let restrictions: string[] = []
	const abortController = new AbortController()
	const assertActive = sinon.stub().callsFake(() => abortController.signal.throwIfAborted())
	const approvals = new TaskletCommandApprovals(undefined, () => restrictions, assertActive)
	const ignore = { validateCommand: sinon.stub().returns(undefined) }
	const permissions = { assertConfigurationValid: sinon.stub(), validateTool: sinon.stub().returns({ allowed: true }) }
	const autoApprover = {
		requiresCounterpartyApproval: options.child ?? true,
		isUnrestrictedAutoApprove: sinon.stub().returns(false),
		shouldAutoApproveTool: sinon.stub().returns(options.masterGate ?? true),
		isCommandAutoApproved: sinon.stub().callsFake((command: string) =>
			((options.child ?? true) || (options.masterGate ?? true)) && isSafeCommand(command, root.capabilities.current())),
	}
	let workspaceRoot = path.resolve("/work/secondary")
	const workspaceManager = { getRootByName: sinon.stub().callsFake(() => ({ name: "secondary", path: workspaceRoot })) }
	const waitForInteraction = sinon.stub().resolves({ action: DiracAskResponse.APPROVE })
	const approvalCards: CardParams[] = []
	const executionCards: CardParams[] = []
	const onExecutionCard = sinon.stub().resolves()
	const createCard = sinon.stub().callsFake(async (params: CardParams) => {
		if (params.requireApproval) approvalCards.push(params)
		else { executionCards.push(params); await onExecutionCard() }
		return { update: sinon.stub().resolves(), finalize: sinon.stub().resolves(), waitForInteraction }
	})
	const executeCommand = sinon.stub().resolves({ output: "done", exitCode: 0 })
	const config = { cwd: path.resolve("/work/primary"), permissionDecisionBinding: options.utility ? {} : undefined }
	const env = {
		config,
		orchestration: { commandCapabilities: root.capabilities, commandApprovals: approvals, reportFailure: sinon.stub(), getTaskState: () => abortController.signal },
		ui: { createCard, upsertText: sinon.stub().resolves() },
		system: { executeCommand },
		telemetry: { captureCustomMetadata: sinon.stub() },
	} as unknown as IToolEnvironment
	const tool = new ExecuteCommandTool(ignore, permissions, autoApprover, workspaceManager, options.multiRoot ?? false)
	return {
		tool, env, config, approvals, root, assertActive, abortController, ignore, permissions, autoApprover,
		waitForInteraction, approvalCards, executionCards, onExecutionCard, executeCommand, createCard,
		setRestrictions: (next: string[]) => { restrictions = next },
		setWorkspaceRoot: (next: string) => { workspaceRoot = next },
		run: (commands: string[]) => tool.processCall({ commands }, env),
		script: (script: string, language: string) => tool.processCall({ script, language }, env),
	}
}
const ids = (test: ReturnType<typeof fixture>, index = 0) => test.approvalCards[index].commandApprovalChoices?.map(({ id }) => id)
const select = (test: ReturnType<typeof fixture>, id: string) => test.waitForInteraction.resolves({ action: DiracAskResponse.APPROVE, commandApprovalChoiceId: id })

describe("ExecuteCommandTool task capability approvals", () => {
	afterEach(() => sinon.restore())

	for (const utility of [false, true]) {
		it(`plain/Utility approval is one-shot with Utility ${utility ? "enabled" : "disabled"}`, async () => {
			const test = fixture({ utility })
			await test.run(["rm file"])
			await test.run(["rm file"])
			assert.equal(test.approvalCards.length, 2)
			sinon.assert.notCalled(test.root.persist)
			sinon.assert.calledTwice(test.executeCommand)
			assert.equal(test.approvalCards[0].permissionRequestKind, utility ? "tool" : undefined)
		})
	}

	it("shares one selected category with the root and all existing/future children, survives resume, isolates roots", async () => {
		const shared = rootAuthority()
		const root = fixture({ root: shared, child: false })
		const child = fixture({ root: shared })
		select(child, "allow-filesystem-7")
		await child.run(["rm file"])
		await root.run(["touch other"])
		await fixture({ root: shared }).run(["rm third"])
		assert.equal(root.approvalCards.length, 0)
		sinon.assert.calledOnce(shared.persist)
		const resumed = fixture({ root: rootAuthority(shared.durable()) })
		await resumed.run(["rm file"])
		assert.equal(resumed.approvalCards.length, 0)
		const unrelated = fixture()
		await unrelated.run(["rm file"])
		assert.equal(unrelated.approvalCards.length, 1)
	})

	it("approves the whole current multi-deficit command but saves only the selected category", async () => {
		const test = fixture()
		select(test, "allow-filesystem-7")
		await test.run(["curl https://example.com > file"])
		assert.deepEqual(ids(test), ["approve", "allow-filesystem-7", "allow-remote_resources-3", "reject"])
		sinon.assert.calledOnce(test.executeCommand)
		test.waitForInteraction.resolves({ action: DiracAskResponse.APPROVE })
		await test.run(["curl https://example.com > file"])
		assert.deepEqual(ids(test, 1), ["approve", "allow-remote_resources-3", "allow-network-1", "reject"])
		sinon.assert.calledOnce(test.root.persist)
	})

	it("unknown commands and mixed unknown batches offer only approve/reject", async () => {
		const test = fixture({ utility: true })
		await test.run(["unknown-dirac-command", "rm file"])
		assert.deepEqual(ids(test), ["approve", "reject"])
		assert.equal(test.approvalCards[0].permissionRequestKind, "manual_tool")
		sinon.assert.notCalled(test.root.persist)
	})

	it("does not allow arbitrary, unoffered, or text-derived capability grants", async () => {
		const test = fixture()
		select(test, "allow-credentials-7")
		await assert.rejects(test.run(["rm file"]), /not offered/)
		const card = await test.createCard.firstCall.returnValue
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.CANCELLED)
		sinon.assert.notCalled(test.executeCommand)
		sinon.assert.notCalled(test.root.persist)
		test.waitForInteraction.resolves({ action: DiracAskResponse.APPROVE, text: "allow filesystem/mutate for this task" })
		await test.run(["rm file"])
		sinon.assert.notCalled(test.root.persist)
	})

	it("suppresses persistent offers when root master gate is disabled or permissions require manual approval", async () => {
		const root = fixture({ child: false, masterGate: false })
		await root.run(["rm file"])
		assert.deepEqual(ids(root), ["approve", "reject"])
		const restricted = fixture({ utility: true })
		restricted.permissions.validateTool.returns({ allowed: false })
		await restricted.run(["rm file"])
		assert.deepEqual(ids(restricted), ["approve", "reject"])
		assert.equal(restricted.approvalCards[0].permissionRequestKind, "manual_tool")
	})

	it("does not dispatch or install a reusable grant when capability persistence fails", async () => {
		const test = fixture()
		select(test, "allow-filesystem-7")
		test.root.persist.rejects(new Error("disk failure"))
		await assert.rejects(test.run(["rm file"]), /disk failure/)
		const card = await test.createCard.firstCall.returnValue
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.CANCELLED)
		sinon.assert.notCalled(test.executeCommand)
		assert.equal(test.executionCards.length, 0)
		assert.equal(test.root.durable(), undefined)
	})

	for (const failure of ["cancellation", "ignore", "configuration"] as const) {
		it(`finalizes the approval card when ${failure} fails after interaction`, async () => {
			const test = fixture()
			const error = new Error(`approval ${failure} failure`)
			const initialCapabilities = test.root.capabilities.current()
			test.waitForInteraction.callsFake(async () => {
				if (failure === "cancellation") test.abortController.abort(error)
				else if (failure === "ignore") test.ignore.validateCommand.throws(error)
				else test.permissions.assertConfigurationValid.throws(error)
				return { action: DiracAskResponse.APPROVE, commandApprovalChoiceId: "allow-filesystem-7" }
			})
			await assert.rejects(test.run(["rm file"]), (caught) => caught === error)
			const card = await test.createCard.firstCall.returnValue
			sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.CANCELLED)
			sinon.assert.calledWithMatch(card.update, { header: "Cancelled: rm file", collapsed: true })
			sinon.assert.notCalled(test.executeCommand)
			sinon.assert.notCalled(test.root.persist)
			assert.equal(test.root.capabilities.current(), initialCapabilities)
		})
	}

	it("waits for durable category commit before executing", async () => {
		const test = fixture()
		select(test, "allow-filesystem-7")
		let release!: () => void
		let entered!: () => void
		const writing = new Promise<void>((resolve) => { entered = resolve })
		test.root.persist.callsFake(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
		const running = test.run(["rm file"])
		await writing
		sinon.assert.notCalled(test.executeCommand)
		release()
		await running
		sinon.assert.calledOnce(test.executeCommand)
	})

	for (const change of ["cancellation", "restrictions"] as const) {
		it(`does not dispatch when ${change} change during a blocked durable capability commit`, async () => {
			const test = fixture()
			select(test, "allow-filesystem-7")
			let release!: () => void
			let entered!: () => void
			const writing = new Promise<void>((resolve) => { entered = resolve })
			test.root.persist.callsFake(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
			const running = test.run(["rm file"])
			await writing
			if (change === "cancellation") test.abortController.abort(new Error("cancelled during commit"))
			else test.setRestrictions(["new manual restriction"])
			release()
			await assert.rejects(running, change === "cancellation" ? /cancelled during commit/ : /restrictions changed/)
			sinon.assert.notCalled(test.executeCommand)
			assert.equal(test.executionCards.length, 0)
		})
	}

	it("script approvals remain one-shot despite identical source and different generated wrappers", async () => {
		const test = fixture()
		await test.script("print('same source')", "python")
		await test.script("print('same source')", "python3")
		assert.equal(test.approvalCards.length, 2)
	})

	for (const workspace of [false, true]) {
		it(`freezes ${workspace ? "workspace hint" : "environment"} cwd before approval`, async () => {
			const test = fixture({ multiRoot: workspace })
			const originalCwd = workspace ? path.resolve("/work/secondary") : test.config.cwd
			test.waitForInteraction.callsFake(async () => {
				test.config.cwd = path.resolve("/work/changed")
				test.setWorkspaceRoot(path.resolve("/work/moved-root"))
				return { action: DiracAskResponse.APPROVE }
			})
			await test.run([workspace ? "@secondary:rm file" : "rm file"])
			assert.equal(test.executeCommand.firstCall.args[0], "rm file")
			assert.equal(test.executeCommand.firstCall.args[1].cwd, originalCwd)
			assert.ok(test.approvalCards[0].body?.includes(JSON.stringify(originalCwd)))
		})
	}

	for (const boundary of ["approval", "execution-card"] as const) {
		it(`rechecks ignore policy after ${boundary} and before dispatch`, async () => {
			const test = fixture()
			const change = () => test.ignore.validateCommand.returns("newly ignored")
			if (boundary === "approval") test.waitForInteraction.callsFake(async () => { change(); return { action: DiracAskResponse.APPROVE } })
			else test.onExecutionCard.callsFake(async () => { change() })
			if (boundary === "approval") await assert.rejects(test.run(["rm file"]), /Diracignore error/)
			else assert.match(await test.run(["rm file"]), /Diracignore error/)
			sinon.assert.notCalled(test.executeCommand)
		})

		it(`rejects restrictions tightened during ${boundary} before dispatch`, async () => {
			const test = fixture()
			const change = () => test.setRestrictions(["new restrictive rule"])
			if (boundary === "approval") test.waitForInteraction.callsFake(async () => { change(); return { action: DiracAskResponse.APPROVE } })
			else test.onExecutionCard.callsFake(async () => { change() })
			if (boundary === "approval") await assert.rejects(test.run(["rm file"]), /restrictions changed/)
			else assert.match(await test.run(["rm file"]), /current restrictions/)
			sinon.assert.notCalled(test.executeCommand)
		})
	}

	it("revalidates newly covered commands against live capability and manual permissions before execution", async () => {
		const test = fixture()
		test.onExecutionCard.callsFake(async () => { test.permissions.validateTool.returns({ allowed: false }) })
		assert.match(await test.run(["cat file"]), /now requires approval/)
		sinon.assert.notCalled(test.executeCommand)
	})

	it("retains captured sandbox restrictions regardless of capability approval", async () => {
		const test = fixture()
		const { captureSandboxExecution } = await import("@shared/SandboxExecution")
		const { DEFAULT_SANDBOX_SETTINGS } = await import("@shared/SandboxSettings")
		const requested = captureSandboxExecution({ ...DEFAULT_SANDBOX_SETTINGS, enabled: true, allowUnsandboxedFallback: true }, true)
		test.env.system.captureCommandSandbox = () => requested
		select(test, "allow-filesystem-7")
		await test.run(["rm file"])
		assert.equal(test.executeCommand.firstCall.args[1].sandboxContext, requested)
		assert.match(test.approvalCards[0].body!, /no meaningful isolation/)
	})
})
