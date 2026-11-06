import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import * as utility from "@core/utility-model/UtilityModelRunner"
import { DiracDefaultTool } from "@shared/tools"
import { ToolExecutor } from "../ToolExecutor"
import { TaskState } from "../TaskState"
import { createTaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { TASK_CALLBACKS_KEYS } from "../tools/utils/ToolConstants"

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

	it("keeps tasklet interception enabled across live permission changes", async () => {
		let current = configuration("act", 1, false)
		const harness = {
			executionProfile: "tasklet",
			getCurrentWorkingConfiguration: () => current,
			commandPermissionController: { validateTool: sinon.stub().returns({ allowed: true, reason: "allowed" }) },
		}
		const autoApprover = (ToolExecutor.prototype as any).requestAutoApprover.call(harness)
		assert.equal(autoApprover.requiresCounterpartyApproval, true)
		assert.equal(autoApprover.isUnrestrictedAutoApprove(), false)
		current = configuration("act", 2, true)
		assert.equal(autoApprover.isUnrestrictedAutoApprove(), false)
		assert.equal(await autoApprover.resolveToolPathPermission(DiracDefaultTool.EDIT_FILE, "src/index.ts"), "manual_only")
		sinon.assert.notCalled(harness.commandPermissionController.validateTool)
	})

	it("keeps tasklet question/plan flows interactive without legacy subagent or Utility shortcuts", () => {
		const current = configuration("act", 2, true)
		const workingConfiguration = { ...current, settings: { ...current.settings, yoloModeToggled: true } }
		const runtime = createTaskRequestRuntime(workingConfiguration, { getModel: () => ({ id: "test", info: {} }) } as any, "request-1")
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			executionProfile: "tasklet",
			requestRuntime: () => runtime,
			getCurrentWorkingConfiguration: () => workingConfiguration,
			commandPermissionController: {},
			createPermissionDecisionBinding: sinon.stub().returns({ service: {} }),
		})
		for (const key of TASK_CALLBACKS_KEYS) {
			if (typeof executor[key] !== "function") executor[key] = sinon.stub()
		}
		const config = executor.asToolConfig()
		assert.equal(config.yoloModeToggled, false)
		assert.equal(config.executionProfile, "tasklet")
		assert.equal(config.permissionDecisionBinding, undefined)
		sinon.assert.notCalled(executor.createPermissionDecisionBinding)
		executor.executionProfile = "standalone"
		const foreground = executor.asToolConfig()
		assert.equal(foreground.yoloModeToggled, true)
		assert.ok(foreground.permissionDecisionBinding)
		sinon.assert.calledOnce(executor.createPermissionDecisionBinding)
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
		sinon.assert.calledOnceWithExactly(harness.createUtilityRunner, enabled.settings.utilityModelSelection, {}, enabled.apiConfiguration)
		assert.equal(createBinding.call(harness, disabled), undefined)
		sinon.assert.calledOnce(harness.createUtilityRunner)
	})

	it("accounts permission and other Utility requests once while keeping primary usage separate", async () => {
		const current = configuration("act", 2)
		const enabled = {
			...current,
			settings: {
				...current.settings,
				utilityModelUsePermissionHandling: true,
				utilityModelPermissionPolicy: "Allow repository edits.",
				utilityModelSelection: { provider: "openai" as const, modelId: "utility-model" },
			},
		}
		const state = new TaskState()
		const primaryUsage = {
			totalInputTokens: 100, totalOutputTokens: 50, totalReasoningTokens: 10,
			totalCacheWriteTokens: 20, totalCacheReadTokens: 30, totalCost: 2,
		}
		Object.assign(state, primaryUsage)
		const usage = {
			type: "usage" as const, inputTokens: 11, outputTokens: 7, reasoningTokens: 3,
			cacheWriteTokens: 2, cacheReadTokens: 5, totalCost: 0.25,
		}
		const createRunner = sinon.stub(utility, "createUtilityModelRunner").callsFake((_configuration, selection, options) =>
			new utility.UtilityModelRunner(selection, () => ({
				getModel: () => ({ id: selection.modelId, info: { supportsPromptCache: false } }),
				async *createMessage() {
					yield usage
					yield { type: "text" as const, text: '{"decision":"approve","reason":"Allowed by policy."}' }
				},
			}), options),
		)
		let notificationCount = 0
		const notified = sinon.spy(() => {
			assert.equal(state.utilityPermissionInputTokens, ++notificationCount * usage.inputTokens)
		})
		const harness = {
			taskState: state,
			ulid: "utility-accounting-test",
			onUtilityUsageRecorded: notified,
			requestRuntime: () => ({ workingConfiguration: current }),
			createUtilityRunner: (ToolExecutor.prototype as any).createUtilityRunner,
		}
		try {
			const binding = (ToolExecutor.prototype as any).createPermissionDecisionBinding.call(harness, enabled)
			assert.deepEqual(await binding.service.decide({
				toolCall: { name: "write_to_file", arguments: { path: "src/index.ts" } },
				permission: { header: "Permission" },
				runtime: { cwd: "/test", mode: "act", isSubagent: false },
			}), { decision: "approve", reason: "Allowed by policy." })
			assert.equal(state.utilityPermissionInputTokens, 11)
			assert.equal(state.utilityPermissionOutputTokens, 7)
			assert.equal(state.utilityPermissionCost, 0.25)
			sinon.assert.calledOnce(notified)

			const observer = sinon.spy((event: utility.UtilityModelUsageEvent) => {
				assert.deepEqual(event, { selection: enabled.settings.utilityModelSelection, usage })
				assert.equal(state.utilityPermissionInputTokens, 22)
				sinon.assert.calledTwice(notified)
			})
			const runner = harness.createUtilityRunner(enabled.settings.utilityModelSelection, { onUsage: observer })
			for await (const _chunk of runner.run({ systemPrompt: "Summarize", messages: [] })) { }

			sinon.assert.calledTwice(createRunner)
			assert.equal(createRunner.firstCall.args[0], enabled.apiConfiguration)
			assert.equal(createRunner.secondCall.args[0], current.apiConfiguration)
			assert.equal(createRunner.firstCall.args[2]!.ulid, harness.ulid)
			sinon.assert.calledOnce(observer)
			assert.equal(state.utilityPermissionInputTokens, 22)
			assert.equal(state.utilityPermissionOutputTokens, 14)
			assert.equal(state.utilityModelReasoningTokens, 6)
			assert.equal(state.utilityPermissionCacheWriteTokens, 4)
			assert.equal(state.utilityPermissionCacheReadTokens, 10)
			assert.equal(state.utilityPermissionCost, 0.5)
			assert.equal(state.utilityModelUsageObserved, true)
			for (const [key, value] of Object.entries(primaryUsage)) {
				assert.equal(state[key as keyof typeof primaryUsage], value)
			}
		} finally {
			createRunner.restore()
		}
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
