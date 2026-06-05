import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "../../../../TaskState"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { ReadFileTool } from "../ReadFileTool"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"

/**
 * End-to-end tests for ReadFileToolHandler.execute().
 *
 * These exercise the actual handler with a mock TaskConfig (following the
 * SubagentToolHandler.test.ts pattern), verifying that:
 *
 *   1. Reading a non-existent file returns a tool error (not a thrown exception)
 *   2. consecutiveMistakeCount is NOT incremented for non-existent files (valid outcome)
 *   3. Repeated file-not-found failures do NOT accumulate the counter
 *   4. A successful read resets consecutiveMistakeCount to 0
 *   5. Missing path parameter increments the counter
 */

let tmpDir: string

class ReadFileToolHandler {
	private tool = new ReadFileTool()
	constructor(_validator: any) {}
	async execute(config: TaskConfig, block: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(block.params, env)
	}
}


function createConfig() {
	const taskState = new TaskState()

	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
		saveCheckpoint: sinon.stub().resolves(),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		switchToActMode: sinon.stub().resolves(false),
		setActiveHookExecution: sinon.stub().resolves(),
		clearActiveHookExecution: sinon.stub().resolves(),
		getActiveHookExecution: sinon.stub().resolves(undefined),
		runUserPromptSubmitHook: sinon.stub().resolves({}),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		updateFCListFromToolResponse: sinon.stub().resolves(),
		shouldAutoApproveTool: sinon.stub().returns([true, true]),
		applyLatestBrowserSettings: sinon.stub().resolves(undefined),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: tmpDir,
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: true,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: true,
		isSubagentExecution: true, // skip UI calls and approval flow
		taskState,
		messageState: {
			getApiConversationHistory: sinon.stub().returns([]),
		},
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeCommands: false },
		},
		autoApprover: {
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
			stateManager: {
				getGlobalStateKey: () => undefined,
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					if (key === "hooksEnabled") return false
					return undefined
				},
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
			},
			fileContextTracker: {
				trackFileContext: sinon.stub().resolves(),
			},
			browserSession: {},
			urlContentFetcher: {},
			diffViewProvider: {},
			diracIgnoreController: { validateAccess: () => true },
			commandPermissionController: {},
			contextManager: {},
		},
		callbacks,
		coordinator: { getHandler: sinon.stub() },
	context: createMockContext(),

	taskMessenger: createMockTaskMessenger(),

	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator }
}

function makeBlock(relPath?: string) {
	return {
		type: "tool_use" as const,
		name: DiracDefaultTool.FILE_READ,
		params: relPath !== undefined ? { paths: [relPath] } : {},
		
	}
}

describe("ReadFileToolHandler.execute – file not found", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-read-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("returns a tool error (not a thrown exception) for a non-existent file", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)

		const result = await handler.execute(config, makeBlock("no-such-file.py"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Error reading file:"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does not increment consecutiveMistakeCount for non-existent files", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)

		await handler.execute(config, makeBlock("ghost-1.py"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("ghost-2.py"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		await handler.execute(config, makeBlock("ghost-3.py"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("resets consecutiveMistakeCount to 0 after a successful read", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)

		// Non-existent files do not accumulate mistakes
		await handler.execute(config, makeBlock("ghost-1.py"))
		await handler.execute(config, makeBlock("ghost-2.py"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		// Create a real file and read it
		const realFile = "real-file.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "hello world")

		const result = await handler.execute(config, makeBlock(realFile))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)

		const result = await handler.execute(config, makeBlock())

		assert.ok((result as string).includes("Missing required parameter"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})
})
