import { describe, it } from "mocha"
import "should"
import type { ToolUse } from "@core/assistant-message"
import * as HookExecutor from "@core/hooks/hook-executor"
import { TaskState } from "@core/task/TaskState"
import { DiracDefaultTool } from "@shared/tools"
import { ResponseOperation } from "@shared/responseTool"
import * as sinon from "sinon"
import { ToolHookUtils } from "../ToolHookUtils"

describe("ToolHookUtils", () => {
	describe("runPreToolUseIfEnabled", () => {
		it("skips hooks for response completion", async () => {
			const executeHookStub = sinon.stub(HookExecutor, "executeHook")
			const config: any = {
				hooksEnabled: true,
			}
			const block: ToolUse = {
				type: "tool_use",
				name: DiracDefaultTool.RESPOND,
				params: { operation: ResponseOperation.COMPLETE, text: "Done" },
			}

			try {
				const shouldContinue = await ToolHookUtils.runPreToolUseIfEnabled(config, block)

				shouldContinue.should.equal(true)
				executeHookStub.called.should.equal(false)
			} finally {
				executeHookStub.restore()
			}
		})

		it("returns early without running hooks when hooks are disabled", async () => {
			const saySpy = sinon.spy(async () => Date.now())
			const cancelTaskSpy = sinon.spy(async () => { })

			const config: any = {
				taskState: new TaskState(),
				hooksEnabled: false,
				callbacks: {
					say: saySpy,
					cancelTask: cancelTaskSpy,
				},
			}

			const block: ToolUse = {
				type: "tool_use",
				name: DiracDefaultTool.FILE_READ,
				params: { path: "src/index.ts" },
			}

			const shouldContinue = await ToolHookUtils.runPreToolUseIfEnabled(config, block)

			shouldContinue.should.equal(true)
			saySpy.called.should.equal(false)
			cancelTaskSpy.called.should.equal(false)
			config.taskState.userMessageContent.should.have.length(0)
		})

		it("treats undefined hooksEnabled as enabled and runs hook flow", async () => {
			const saySpy = sinon.spy(async () => Date.now())
			const executeHookStub = sinon.stub(HookExecutor, "executeHook").resolves({ wasCancelled: false })

			const config: any = {
				taskState: new TaskState(),
				taskId: "test-task-id",
				hooksEnabled: undefined,
				providerId: "unknown",
				model: { id: "test-model", info: {} },
				callbacks: {
					say: saySpy,
					cancelTask: async () => { },
					setActiveHookExecution: async () => { },
					clearActiveHookExecution: async () => { },
				},
			}

			const block: ToolUse = {
				type: "tool_use",
				name: DiracDefaultTool.EXECUTE_COMMAND,
				params: { command: "echo hello" },
			}

			try {
				const shouldContinue = await ToolHookUtils.runPreToolUseIfEnabled(config, block)

				shouldContinue.should.equal(true)
				saySpy.called.should.equal(false)
				executeHookStub.calledOnce.should.equal(true)
				config.taskState.userMessageContent.should.have.length(0)
			} finally {
				executeHookStub.restore()
			}
		})
	})
})
