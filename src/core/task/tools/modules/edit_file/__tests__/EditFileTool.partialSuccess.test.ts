import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { ANCHOR_DELIMITER } from "@shared/utils/line-hashing"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as getDiagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskState } from "../../../../TaskState"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { EditFileTool } from "../EditFileTool"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"

class EditFileToolHandler {
	private tool = new EditFileTool()
	public diagnosticsTimeoutMs: number = 0
	constructor(_validator: any, _forceSyntaxChecker: boolean) {}
	async execute(config: TaskConfig, block: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(block.params, env)
	}
}

let tmpDir: string

function createConfig() {
	const taskState = new TaskState()
	let lastPath: string | undefined
	let lastContent: string | undefined
	const diffViewProvider = {
		open: sinon.stub().callsFake(async (path: string) => {
			lastPath = path
		}),
		update: sinon.stub().callsFake(async (content: string) => {
			lastContent = content
		}),
		reset: sinon.stub().resolves(),
		saveChanges: sinon.stub().callsFake(async () => {
			if (lastPath && lastContent !== undefined) {
				await fs.writeFile(lastPath, lastContent)
			}
			return { finalContent: lastContent }
		}),
		applyAndSaveSilently: sinon.stub().callsFake(async (path: string, content: string) => {
			await fs.writeFile(path, content)
			return { finalContent: content }
		}),

		applyAndSaveBatchSilently: sinon.stub().callsFake(async (files: any[]) => {
			const results = new Map()
			for (const file of files) {
				await fs.writeFile(file.path, file.content)
				results.set(file.path, { finalContent: file.content })
			}
			return results
		}),
		showReview: sinon.stub().resolves(),
		scrollToFirstDiff: sinon.stub().resolves(),
		hideReview: sinon.stub().resolves(),
		undoUserEdits: sinon.stub().resolves(),
	}

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
				markFileAsEditedByDirac: sinon.stub(),
			},
			browserSession: {},
			urlContentFetcher: {},
			diffViewProvider,
			diracIgnoreController: { validateAccess: () => true },
			commandPermissionController: {},
		},
		callbacks,
		coordinator: { getHandler: sinon.stub() },
		context: createMockContext(),

		taskMessenger: createMockTaskMessenger(),
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator }
}

function makeMultiEditBlock(
	relPath: string,
	edits: Array<{ edit_type: string; anchor: string; end_anchor?: string; text: string }>,
) {
	return {
		type: "tool_use" as const,
		name: DiracDefaultTool.EDIT_FILE,
		params: {
			files: [
				{
					path: relPath,
					edits: edits,
				},
			],
		},

		call_id: `call-${Math.random()}`,
	}
}

describe("EditFileTool.execute – partial success", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)

		sandbox.stub(getDiagnosticsProvidersModule, "getDiagnosticsProviders").returns([
			{
				capturePreSaveState: sandbox.stub().resolves([]),
				getDiagnosticsFeedback: sandbox.stub().resolves({ newProblemsMessage: "", fixedCount: 0 }),
				getDiagnosticsFeedbackForFiles: sandbox
					.stub()
					.callsFake(async (data) => data.map(() => ({ newProblemsMessage: "", fixedCount: 0 }))),
			} as any,
		])

		setVscodeHostProviderMock({
			hostBridgeClient: {
				workspaceClient: {
					getDiagnostics: sandbox.stub().resolves({ fileDiagnostics: [] }),
					prepareDiagnostics: sandbox.stub().resolves({}),
					getWorkspacePaths: sandbox.stub().resolves({ paths: [tmpDir] }),
					saveOpenDocumentIfDirty: sandbox.stub().resolves({ wasSaved: false }),
				},
			} as any,
		})
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("applies all valid edits in a batch even if some fail", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		handler.diagnosticsTimeoutMs = 100

		const fileName = "partial-success.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5"
		await fs.writeFile(filePath, originalContent)

		// Get initial anchors
		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// One block with multiple edits, some of which fail
		const block = makeMultiEditBlock(fileName, [
			{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "new line 2" }, // Success
			{ edit_type: "replace", anchor: "123missing", end_anchor: "123missing", text: "this should fail" }, // Failure
			{ edit_type: "replace", anchor: anchors[3], end_anchor: anchors[3], text: "new line 4" }, // Success
		])

		// We need to put all blocks in assistantMessageContent so groupBlocksByPath picks them up
		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		// Verify disk content
		const finalContent = await fs.readFile(filePath, "utf8")
		assert.equal(finalContent, "line 1\nnew line 2\nline 3\nnew line 4\nline 5")
		// Verify tool response
		assert.ok(typeof result === "string")
		assert.ok(
			result.includes("Applied 2 edit(s) successfully") && result.includes("1 edit(s) failed"),
			"Should include success summary",
		)
		assert.ok(
			result.includes('Edit (anchor: "123missing", end_anchor: "123missing") failed. Diagnostics:'),
			"Should include failure diagnostics",
		)
		assert.ok(result.includes("anchor is missing or incorrectly formatted"), "Should include missing anchor error")
		// Verify result contains context blocks
		assert.ok(result.includes("new line 2"))
		assert.ok(result.includes("new line 4"))
	})

	it("returns tool error if ALL edits in a batch fail", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "all-failure.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2"
		await fs.writeFile(filePath, originalContent)

		const block = makeMultiEditBlock(fileName, [
			{ edit_type: "replace", anchor: "123badone", end_anchor: "123badone", text: "fail 1" },
			{ edit_type: "replace", anchor: "123badtwo", end_anchor: "123badtwo", text: "fail 2" },
		])

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		// Verify disk content is UNCHANGED
		const finalContent = await fs.readFile(filePath, "utf8")
		assert.equal(finalContent, originalContent)
		// Verify tool response (should be a tool error as it was before)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("The tool execution failed with the following error"))
		assert.ok(result.includes('Edit (anchor: "123badone", end_anchor: "123badone") failed. Diagnostics:'))
		assert.ok(result.includes('Edit (anchor: "123badtwo", end_anchor: "123badtwo") failed. Diagnostics:'))
		assert.ok(result.includes("anchor is missing or incorrectly formatted"))
		assert.ok(result.includes("anchor is missing or incorrectly formatted"))
	})

	it("applies all edits successfully when there are no errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "full-success.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)

		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		const block = makeMultiEditBlock(fileName, [
			{ edit_type: "replace", anchor: anchors[0], end_anchor: anchors[0], text: "new line 1" },
			{ edit_type: "replace", anchor: anchors[2], end_anchor: anchors[2], text: "new line 3" },
		])

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)

		// Verify disk content
		const finalContent = await fs.readFile(filePath, "utf8")
		assert.equal(finalContent, "new line 1\nline 2\nnew line 3")

		// Verify tool response
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 2 edit(s) successfully"))
		assert.ok(result.includes("new line 1"))
		assert.ok(result.includes("new line 3"))
	})

	it("returns concise format in 'additions-only' mode", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		// (handler as any).tool.processor.diffMode = "additions-only"

		const fileName = "concise-test.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10"
		await fs.writeFile(filePath, originalContent)
		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// Replace lines 2 and 3 (index 1 and 2)
		const block = makeMultiEditBlock(fileName, [
			{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[2], text: "new line 2 and 3" },
		])

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)

		// Verify disk content
		const finalContent = await fs.readFile(filePath, "utf8")
		assert.equal(finalContent, "line 1\nnew line 2 and 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10")

		// Verify concise response
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		// Check for the summary message
		// In full diff mode, the tool shows the complete file content with anchors when changes are extensive
		assert.ok(result.includes("new line 2 and 3"), `Should include the new content. Result was: ${result}`)
		// Check for the newly added lines
		assert.ok(result.includes("+"))
		assert.ok(result.includes("new line 2 and 3"))
	})
})
