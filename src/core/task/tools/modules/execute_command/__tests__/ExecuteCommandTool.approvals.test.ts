import assert from "node:assert/strict"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { TaskletCommandApprovals } from "../../../../TaskletCommandApprovals"
import type { CommandGrantSnapshot } from "../../../interfaces/CommandApprovals"
import type { CardParams, IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ExecuteCommandTool } from "../ExecuteCommandTool"

function fixture(options: { utility?: boolean; multiRoot?: boolean; initial?: CommandGrantSnapshot } = {}) {
	let durable = structuredClone(options.initial ?? { version: 1 as const, grants: [] })
	let restrictions: string[] = []
	const persist = sinon.stub().callsFake(async (snapshot: CommandGrantSnapshot) => { durable = structuredClone(snapshot) })
	const assertActive = sinon.stub()
	const approvals = new TaskletCommandApprovals(options.initial, persist, () => restrictions, assertActive)
	const ignore = { validateCommand: sinon.stub().returns(undefined) }
	const permissions = { assertConfigurationValid: sinon.stub(), validateTool: sinon.stub().returns({ allowed: true }) }
	const autoApprover = {
		requiresCounterpartyApproval: true,
		isUnrestrictedAutoApprove: sinon.stub().returns(false),
		isCommandAutoApproved: sinon.stub().returns(false),
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
		orchestration: { commandApprovals: approvals, reportFailure: sinon.stub(), getTaskState: () => new AbortController().signal },
		ui: { createCard, upsertText: sinon.stub().resolves() },
		system: { executeCommand },
		telemetry: { captureCustomMetadata: sinon.stub() },
	} as unknown as IToolEnvironment
	const tool = new ExecuteCommandTool(ignore, permissions, autoApprover, workspaceManager, options.multiRoot ?? false)
	return {
		tool, env, config, approvals, persist, assertActive, ignore, permissions, autoApprover,
		waitForInteraction, approvalCards, executionCards, onExecutionCard, executeCommand, workspaceManager,
		durable: () => durable,
		setRestrictions: (next: string[]) => { restrictions = next },
		setWorkspaceRoot: (next: string) => { workspaceRoot = next },
		run: (commands: string[]) => tool.processCall({ commands }, env),
		script: (script: string, language: string) => tool.processCall({ script, language }, env),
	}
}

function promptedCommands(test: ReturnType<typeof fixture>): string[][] {
	return test.approvalCards.map((card) => {
		assert.equal(card.permissionOperation?.kind, "commands")
		return (card.permissionOperation as { kind: "commands"; commands: string[] }).commands
	})
}

describe("ExecuteCommandTool child approval integration", () => {
	afterEach(() => sinon.restore())

	for (const utility of [false, true]) {
		it(`commits once and reuses exact approval with Utility ${utility ? "enabled" : "disabled"}`, async () => {
			const test = fixture({ utility })
			await test.run(["npm run mutate"])
			await test.run(["npm run mutate"])
			assert.deepEqual(promptedCommands(test), [["npm run mutate"]])
			sinon.assert.calledOnce(test.persist)
			sinon.assert.calledTwice(test.executeCommand)
			sinon.assert.callOrder(test.waitForInteraction, test.persist, test.executeCommand)
			assert.equal(test.approvalCards[0].permissionRequestKind, utility ? "tool" : undefined)
			assert.deepEqual(test.durable().grants[0].identity, {
				kind: "command", command: "npm run mutate", cwd: test.config.cwd,
			})
		})
	}

	it("reuses a restored durable grant but not an unrelated child's empty grants", async () => {
		const original = fixture()
		await original.run(["command-A"])
		const resumed = fixture({ initial: original.durable() })
		await resumed.run(["command-A"])
		assert.equal(resumed.approvalCards.length, 0)
		sinon.assert.notCalled(resumed.persist)
		const sibling = fixture()
		await sibling.run(["command-A"])
		assert.deepEqual(promptedCommands(sibling), [["command-A"]])
	})

	it("prompts only for C after approving [A,B] and then requesting [A,C]", async () => {
		const test = fixture()
		await test.run(["command-A", "command-B"])
		await test.run(["command-A", "command-C"])
		assert.deepEqual(promptedCommands(test), [["command-A", "command-B"], ["command-C"]])
		assert.deepEqual(test.executeCommand.getCalls().map((call) => call.args[0]), ["command-A", "command-B", "command-A", "command-C"])
		assert.equal(test.durable().grants.length, 3)
	})

	it("reuses python/python3 source identity despite different generated wrappers", async () => {
		const test = fixture()
		const random = sinon.stub(Math, "random")
		random.onFirstCall().returns(0.1)
		random.onSecondCall().returns(0.2)
		await test.script("print('same source')", "python")
		await test.script("print('same source')", "python3")
		assert.equal(test.approvalCards.length, 1)
		assert.notEqual(test.executeCommand.firstCall.args[0], test.executeCommand.secondCall.args[0])
		assert.match(test.executeCommand.firstCall.args[0], /^python3 << /)
		assert.deepEqual(test.durable().grants[0].identity, {
			kind: "script", script: "print('same source')", interpreter: "python3", cwd: test.config.cwd,
		})
	})

	it("separates script source, interpreter, and cwd, and does not cover literal shell commands", async () => {
		const test = fixture()
		await test.script("echo first", "bash")
		await test.script("echo second", "bash")
		await test.script("echo second", "sh")
		test.config.cwd = path.resolve("/work/other")
		await test.script("echo second", "sh")
		await test.run([test.executeCommand.lastCall.args[0]])
		assert.equal(test.approvalCards.length, 5)
		assert.equal(test.durable().grants.length, 5)
	})

	it("does not split an approved compound into constituent grants", async () => {
		const test = fixture()
		await test.run(["command-A && command-B"])
		await test.run(["command-A", "command-B"])
		assert.deepEqual(promptedCommands(test), [["command-A && command-B"], ["command-A", "command-B"]])
	})

	for (const failure of ["exit", "throw"] as const) {
		it(`retains approval after command ${failure} failure`, async () => {
			const test = fixture()
			if (failure === "exit") test.executeCommand.onFirstCall().resolves({ output: "failed", exitCode: 1 })
			else test.executeCommand.onFirstCall().rejects(new Error("Process launch failed"))
			await test.run(["command-A"])
			await test.run(["command-A"])
			assert.equal(test.approvalCards.length, 1)
			sinon.assert.calledTwice(test.executeCommand)
			sinon.assert.calledOnce(test.persist)
		})
	}

	it("never dispatches or installs a reusable grant when durable commit fails", async () => {
		const test = fixture()
		const failure = new Error("Grant persistence failed")
		test.persist.onFirstCall().rejects(failure)
		await assert.rejects(test.run(["command-A"]), (error) => error === failure)
		sinon.assert.notCalled(test.executeCommand)
		assert.equal(test.executionCards.length, 0)
		assert.equal(test.durable().grants.length, 0)
		await test.run(["command-A"])
		assert.deepEqual(promptedCommands(test), [["command-A"], ["command-A"]])
		sinon.assert.calledOnce(test.executeCommand)
	})

	it("waits for durable commit before executing", async () => {
		const test = fixture()
		let release!: () => void
		let entered!: () => void
		const writing = new Promise<void>((resolve) => { entered = resolve })
		test.persist.callsFake(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
		const running = test.run(["command-A"])
		await writing
		sinon.assert.notCalled(test.executeCommand)
		release()
		await running
		sinon.assert.calledOnce(test.executeCommand)
	})

	for (const workspace of [false, true]) {
		it(`freezes ${workspace ? "workspace hint" : "environment"} cwd before an approval wait`, async () => {
			const test = fixture({ multiRoot: workspace })
			const originalCwd = workspace ? path.resolve("/work/secondary") : test.config.cwd
			test.waitForInteraction.callsFake(async () => {
				test.config.cwd = path.resolve("/work/changed")
				test.setWorkspaceRoot(path.resolve("/work/moved-root"))
				return { action: DiracAskResponse.APPROVE }
			})
			const input = workspace ? "@secondary:command-A" : "command-A"
			await test.run([input])
			assert.deepEqual(promptedCommands(test), [["command-A"]])
			assert.equal(test.executeCommand.firstCall.args[0], "command-A")
			assert.equal(test.executeCommand.firstCall.args[1].cwd, originalCwd)
			assert.equal(test.durable().grants[0].identity.cwd, originalCwd)
			assert.ok(test.approvalCards[0].body?.includes(JSON.stringify(originalCwd)))
			assert.equal((test.approvalCards[0].rawInput as { commands: { cwd: string }[] }).commands[0].cwd, originalCwd)
			await test.run([input])
			assert.equal(test.approvalCards.length, 2, "The same text in the new cwd needs its own approval")
		})
	}

	for (const boundary of ["approval", "execution-card"] as const) {
		it(`rechecks ignore policy after ${boundary} yields and before dispatch`, async () => {
			const test = fixture()
			const change = () => test.ignore.validateCommand.returns("newly ignored")
			if (boundary === "approval") test.waitForInteraction.callsFake(async () => { change(); return { action: DiracAskResponse.APPROVE } })
			else test.onExecutionCard.callsFake(async () => { change() })
			if (boundary === "approval") await assert.rejects(test.run(["command-A"]), /Diracignore error/)
			else assert.match(await test.run(["command-A"]), /Diracignore error/)
			sinon.assert.notCalled(test.executeCommand)
		})

		it(`rejects restrictions tightened during ${boundary} before dispatch`, async () => {
			const test = fixture()
			const change = () => test.setRestrictions(["new restrictive rule"])
			if (boundary === "approval") test.waitForInteraction.callsFake(async () => { change(); return { action: DiracAskResponse.APPROVE } })
			else test.onExecutionCard.callsFake(async () => { change() })
			if (boundary === "approval") await assert.rejects(test.run(["command-A"]), /restrictions changed/)
			else assert.match(await test.run(["command-A"]), /current restrictions/)
			sinon.assert.notCalled(test.executeCommand)
		})
	}

	it("does not dispatch if restrictions tighten during the durable commit", async () => {
		const test = fixture()
		test.persist.callsFake(async () => { test.setRestrictions(["new restrictive rule"]) })
		await assert.rejects(test.run(["command-A"]), /current restrictions/)
		sinon.assert.notCalled(test.executeCommand)
		assert.equal(test.executionCards.length, 0)
	})

	it("invalidates a prior grant when restrictions tighten between calls", async () => {
		const test = fixture({ utility: true })
		await test.run(["command-A"])
		test.setRestrictions(["manual restriction"])
		test.permissions.validateTool.returns({ allowed: false })
		await test.run(["command-A"])
		await test.run(["command-A"])
		assert.deepEqual(promptedCommands(test), [["command-A"], ["command-A"]])
		assert.equal(test.approvalCards[1].permissionRequestKind, "manual_tool")
		assert.deepEqual(test.durable().grants[0].restrictions, ["manual restriction"])
	})

	for (const changedPolicy of ["restrictions", "ignore", "retirement"] as const) {
		it(`supplies a spawn-time guard rejecting ${changedPolicy} changes during terminal acquisition`, async () => {
			const test = fixture()
			const spawn = sinon.stub().returns({ output: "spawned", exitCode: 0 })
			test.executeCommand.callsFake(async (_command: string, options: { assertAuthorized: () => void }) => {
				await Promise.resolve() // Simulate asynchronous backend/terminal acquisition.
				if (changedPolicy === "restrictions") test.setRestrictions(["new restrictive rule"])
				else if (changedPolicy === "ignore") test.ignore.validateCommand.returns("newly ignored")
				else test.assertActive.throws(new Error("Child retired"))
				assert.equal(typeof options.assertAuthorized, "function")
				options.assertAuthorized()
				return spawn()
			})
			const output = await test.run(["command-A"])
			assert.match(output, /current restrictions|Diracignore error|Child retired/)
			sinon.assert.calledOnce(test.executeCommand)
			sinon.assert.notCalled(spawn)
		})
	}

	it("rechecks formerly auto-approved commands if policy changes before dispatch", async () => {
		const test = fixture()
		test.autoApprover.isCommandAutoApproved.returns(true)
		test.onExecutionCard.callsFake(async () => { test.autoApprover.isCommandAutoApproved.returns(false) })
		assert.match(await test.run(["command-A"]), /now requires approval/)
		sinon.assert.notCalled(test.executeCommand)
		sinon.assert.notCalled(test.persist)
	})

	for (const action of [DiracAskResponse.REJECT, DiracAskResponse.MESSAGE]) {
		it(`does not grant or dispatch after ${action}`, async () => {
			const test = fixture()
			test.waitForInteraction.resolves({ action, text: "Do not run" })
			await test.run(["command-A"])
			sinon.assert.notCalled(test.persist)
			sinon.assert.notCalled(test.executeCommand)
			assert.equal(test.durable().grants.length, 0)
		})
	}
})
