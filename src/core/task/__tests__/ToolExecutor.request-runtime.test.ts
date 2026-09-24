import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DiracDefaultTool } from "@shared/tools"
import { ToolExecutor } from "../ToolExecutor"
import { createTaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

function configuration(mode: "plan" | "act", revision = 1, autoApproveAllToggled = false) {
	return createTaskWorkingConfiguration({
		revision,
		settings: {
			mode,
			strictPlanModeEnabled: true,
			autoApproveAllToggled,
			yoloModeToggled: false,
			autoApprovalSettings: { actions: {} },
			userApprovedCommands: [],
		} as any,
		apiConfiguration: {
			planModeApiProvider: "anthropic",
			actModeApiProvider: "anthropic",
		} as any,
		workspaceConfiguration: {} as any,
		executionOptions: {
			terminalReuseEnabled: true,
			vscodeTerminalExecutionMode: "backgroundExec",
			multiRootEnabled: false,
		},
	})
}

function authorizationHarness(requestMode: "plan" | "act", currentMode: "plan" | "act", currentRevision = 2) {
	const runtime = createTaskRequestRuntime(configuration(requestMode), {} as any, "request-1")
	let current = configuration(currentMode, currentRevision)
	const harness = {
		requestRuntime: () => runtime,
		getCurrentWorkingConfiguration: () => current,
		isPlanModeToolRestricted: (toolName: DiracDefaultTool) =>
			[DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST].includes(toolName),
	}
	return {
		harness,
		runtime,
		setCurrent: (next: ReturnType<typeof configuration>) => {
			current = next
		},
	}
}

function executionHarness(requestMode: "plan" | "act", currentMode: "plan" | "act") {
	const auth = authorizationHarness(requestMode, currentMode)
	const bufferPartialToolUse = sinon.stub().callsFake(async () => undefined)
	const createCard = sinon.stub().resolves({})
	const pushToolResult = sinon.stub().resolves()
	const closeBrowser = sinon.stub().resolves()
	const harness = {
		...auth.harness,
		coordinator: {
			has: () => true,
			bufferPartialToolUse,
		},
		asToolConfig: () => ({ requestId: auth.runtime.requestId }),
		taskState: { didRejectTool: false, userMessageContent: [] },
		browserSession: { closeBrowser },
		taskMessenger: { createCard },
		resultPusher: { pushToolResult },
		errorHandler: { handleError: sinon.stub().resolves() },
		isPlanModeRestricted: (ToolExecutor.prototype as any).isPlanModeRestricted,
		assertMutationAuthorized: (ToolExecutor.prototype as any).assertMutationAuthorized,
		isPlanModeToolRestricted: (ToolExecutor.prototype as any).isPlanModeToolRestricted,
		handleCompleteBlock: sinon.stub().resolves(),
	}
	return {
		harness,
		runtime: auth.runtime,
		setCurrent: auth.setCurrent,
		bufferPartialToolUse,
		createCard,
		pushToolResult,
		closeBrowser,
	}
}

describe("ToolExecutor request-runtime authorization", () => {
	it("restricts file-writing tools in Plan Mode while allowing execute_command", async () => {
		const isRestricted = (toolName: DiracDefaultTool) =>
			(ToolExecutor.prototype as any).isPlanModeToolRestricted.call({}, toolName)

		assert.equal(isRestricted(DiracDefaultTool.FILE_NEW), true)
		assert.equal(isRestricted(DiracDefaultTool.EDIT_FILE), true)
		assert.equal(isRestricted(DiracDefaultTool.EDIT_AST), true)
		assert.equal(isRestricted(DiracDefaultTool.EXECUTE_COMMAND), false)

		const { harness, createCard, closeBrowser } = executionHarness("plan", "plan")
		await (ToolExecutor.prototype as any).execute.call(
			harness,
			{ type: "tool_use", name: DiracDefaultTool.EXECUTE_COMMAND, params: {}, isComplete: true },
			true,
		)

		sinon.assert.notCalled(createCard)
		sinon.assert.calledOnce(closeBrowser)
		sinon.assert.calledOnce(harness.handleCompleteBlock)
	})

	it("enforces both originating and current mode while ignoring unrelated Act revisions", () => {
		const planToAct = authorizationHarness("plan", "act")
		assert.throws(
			() => (ToolExecutor.prototype as any).assertMutationAuthorized.call(planToAct.harness, DiracDefaultTool.EDIT_FILE),
			/Plan Mode does not permit file mutations/,
		)

		const actToPlan = authorizationHarness("act", "plan")
		assert.throws(
			() => (ToolExecutor.prototype as any).assertMutationAuthorized.call(actToPlan.harness, DiracDefaultTool.EDIT_AST),
			/Plan Mode does not permit file mutations/,
		)

		const unrelatedActUpdate = authorizationHarness("act", "act", 9)
		assert.doesNotThrow(() =>
			(ToolExecutor.prototype as any).assertMutationAuthorized.call(
				unrelatedActUpdate.harness,
				DiracDefaultTool.FILE_NEW,
			),
		)
	})

	it("rejects a partial Plan mutation after Plan-to-Act before buffering it", async () => {
		const { harness, bufferPartialToolUse, createCard, pushToolResult, closeBrowser } = executionHarness("plan", "act")
		await (ToolExecutor.prototype as any).execute.call(
			harness,
			{ type: "tool_use", name: DiracDefaultTool.EDIT_FILE, params: {}, isComplete: false },
			false,
		)

		sinon.assert.calledOnce(createCard)
		sinon.assert.notCalled(bufferPartialToolUse)
		sinon.assert.notCalled(pushToolResult)
		sinon.assert.notCalled(closeBrowser)
	})

	it("evaluates auto-approval from the Task's current configuration", () => {
		const runtime = createTaskRequestRuntime(configuration("act", 1, false), {} as any, "request-1")
		let current = configuration("act", 2, true)
		const harness = {
			requestRuntime: () => runtime,
			getCurrentWorkingConfiguration: () => current,
			commandPermissionController: {},
		}
		const autoApprover = (ToolExecutor.prototype as any).requestAutoApprover.call(harness)

		assert.equal(autoApprover.isUnrestrictedAutoApprove(), true)
		current = configuration("act", 3, false)
		assert.equal(autoApprover.isUnrestrictedAutoApprove(), false)
	})

	it("builds permission handling from the supplied current configuration", () => {
		const enabled = createTaskWorkingConfiguration({
			revision: 2,
			settings: {
				mode: "act",
				utilityModelUsePermissionHandling: true,
				utilityModelPermissionPolicy: "Allow repository edits.",
				utilityModelSelection: { provider: "openai", modelId: "utility-model" },
			} as any,
			apiConfiguration: {} as any,
			workspaceConfiguration: {} as any,
			executionOptions: {
				terminalReuseEnabled: true,
				vscodeTerminalExecutionMode: "backgroundExec",
				multiRootEnabled: false,
			},
		})
		const disabled = {
			...enabled,
			revision: 3,
			settings: { ...enabled.settings, utilityModelUsePermissionHandling: false },
		}
		const harness = { createUtilityRunner: sinon.stub().returns({ run: sinon.stub() }) }
		const createBinding = (ToolExecutor.prototype as any).createPermissionDecisionBinding

		const binding = createBinding.call(harness, enabled)
		assert.ok(binding)
		assert.equal(binding.configurationRevision, enabled.revision)
		assert.equal(typeof harness.createUtilityRunner.firstCall.args[1].onUsage, "function")
		assert.equal(createBinding.call(harness, disabled), undefined)
	})

	it("keeps concurrent calls bound to the same request runtime", async () => {
		const { harness, runtime, bufferPartialToolUse } = executionHarness("act", "act")
		const seenRequestIds: string[] = []
		bufferPartialToolUse.callsFake(async (_block: unknown, config: { requestId: string }) => {
			seenRequestIds.push(config.requestId)
			await Promise.resolve()
		})

		await Promise.all([
			(ToolExecutor.prototype as any).execute.call(
				harness,
				{ type: "tool_use", name: DiracDefaultTool.EDIT_FILE, params: {}, isComplete: false },
				false,
			),
			(ToolExecutor.prototype as any).execute.call(
				harness,
				{ type: "tool_use", name: DiracDefaultTool.EDIT_AST, params: {}, isComplete: false },
				false,
			),
		])

		assert.deepEqual(seenRequestIds, [runtime.requestId, runtime.requestId])
		sinon.assert.calledTwice(bufferPartialToolUse)
	})
})
