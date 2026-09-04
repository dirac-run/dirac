import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { ANCHOR_DELIMITER } from "@shared/utils/line-hashing"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { DiracContext } from "../../../context/DiracContext"
import { ReadFileTool } from "../../read_file/ReadFileTool"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as getDiagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskState } from "../../../../TaskState"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { EditFileTool } from "../EditFileTool"

class EditFileToolHandler {
	private tool = new EditFileTool()
	public diagnosticsTimeoutMs = 0
	constructor(_validator: any, _forceSyntaxChecker: boolean) { }
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
		readText: sinon.stub().callsFake(async (filePath: string) => await fs.readFile(filePath, "utf8")),
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
		resolveToolPathPermission: sinon.stub().resolves("auto_approve"),
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
		createUtilityModelRunner: sinon.stub(),
		createSubagentRuntime: sinon.stub(),
		assertMutationAuthorized: sinon.stub(),
		commitAttemptCompletion: sinon.stub().resolves({ committed: true }),
		getDiracMessages: sinon.stub().returns([]),
		updateDiracMessage: sinon.stub().resolves(),
		resetTransientState: sinon.stub().resolves(),
		notifyContextCompacted: sinon.stub(),
	}

	const persistenceStateManager = { flushPendingState: sinon.stub().resolves() }

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
		model: { id: "test-model", info: { supportsImages: false } },
		supportsNativeWebSearch: false,
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

	return { config, callbacks, taskState, validator, persistenceStateManager }
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
		AnchorStateManager.reset("ulid-1")

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
		AnchorStateManager.reset("ulid-1")
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
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
			result.includes("Partial success: 2 of 3 edits were applied; 1 failed") &&
			result.includes("Do not retry the 2 applied edits"),
			"Should include an explicit partial-success summary",
		)
		assert.equal(result.match(/Do not retry/g)?.length, 1, "Retry guidance should appear once per batch")
		assert.ok(
			result.includes('files[0].edits[1] (anchor: "123missing", end_anchor: "123missing") failed. Diagnostics:'),
			"Should identify the failed edit by its original index",
		)
		assert.ok(result.includes("must be one complete anchored source line"), "Should explain the complete-coordinate requirement")
		assert.ok(!result.includes("The tool execution failed with the following error"), "Partial success is not total failure")
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
		assert.ok(result.includes('files[0].edits[0] (anchor: "123badone", end_anchor: "123badone") failed. Diagnostics:'))
		assert.ok(result.includes('files[0].edits[1] (anchor: "123badtwo", end_anchor: "123badtwo") failed. Diagnostics:'))
		assert.ok(result.match(/must be one complete anchored source line/g)?.length === 4)
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

	it("does not suppress the fresh mapping seeded by a failed edit with old anchors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		const fileName = "failed-edit-seeded-state.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2"
		await fs.writeFile(filePath, originalContent)
		const randomStub = sandbox.stub(Math, "random").returns(0)

		const readTool = new ReadFileTool()
		const firstRead = (await readTool.processCall(
			{ paths: [fileName], include_anchors: true },
			new SurfaceAdapter(config),
		)) as string
		const oldAnchor = firstRead.match(/^([A-Z][a-zA-Z]*§line 2)$/m)?.[1]
		assert.ok(oldAnchor)
		const emittedFingerprint = AnchorStateManager.getDocumentFingerprint(filePath, config.ulid)

		AnchorStateManager.reset(config.ulid)
		randomStub.returns(0.999)
		const block = makeMultiEditBlock(fileName, [
			{ edit_type: "replace", anchor: oldAnchor, end_anchor: oldAnchor, text: "should not apply" },
		])
		taskState.assistantMessageContent = [block]
		const failedEdit = await handler.execute(config, block)

		assert.ok(typeof failedEdit === "string" && failedEdit.includes("was not found"))
		assert.equal(await fs.readFile(filePath, "utf8"), originalContent)
		assert.notEqual(AnchorStateManager.getDocumentFingerprint(filePath, config.ulid), emittedFingerprint)

		const reread = (await readTool.processCall(
			{ paths: [fileName], include_anchors: true },
			new SurfaceAdapter(config),
		)) as string
		assert.ok(!reread.includes("no changes have been made"))
		assert.ok(/^[A-Z][a-zA-Z]*§line 2$/m.test(reread))
	})


	it("restores persisted anchors before editing after task reconstruction", async () => {
		const { config, taskState, validator, persistenceStateManager } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		const fileName = "reconstructed-anchor-edit.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)

		const originalDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = path.join(tmpDir, "dirac-home")
		try {
			config.taskId = "anchor-reconstruction"
			const firstContext = new DiracContext(config.taskId, persistenceStateManager as any, config.ulid)
			config.context = firstContext
			await firstContext.load()

			const readResult = (await new ReadFileTool().processCall(
				{ paths: [fileName], include_anchors: true },
				new SurfaceAdapter(config),
			)) as string
			const oldAnchor = readResult.match(/^([A-Z][a-zA-Z]*§line 2)$/m)?.[1]
			assert.ok(oldAnchor)
			const emittedFingerprint = AnchorStateManager.getDocumentFingerprint(filePath, config.ulid)
			await firstContext.save()

			AnchorStateManager.reset(config.ulid)
			const reconstructedContext = new DiracContext(config.taskId, persistenceStateManager as any, config.ulid)
			await reconstructedContext.ensureAnchorState()
			config.context = reconstructedContext
			assert.equal(AnchorStateManager.getDocumentFingerprint(filePath, config.ulid), emittedFingerprint)

			const repeatedRead = (await new ReadFileTool().processCall(
				{ paths: [fileName], include_anchors: true },
				new SurfaceAdapter(config),
			)) as string
			assert.ok(repeatedRead.includes(oldAnchor))
			assert.ok(!repeatedRead.includes("no changes have been made"))

			const block = makeMultiEditBlock(fileName, [
				{ edit_type: "replace", anchor: oldAnchor, end_anchor: oldAnchor, text: "restored line 2" },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block)

			assert.ok(typeof result === "string" && result.includes("Applied 1 edit(s) successfully"))
			assert.equal(await fs.readFile(filePath, "utf8"), "line 1\nrestored line 2\nline 3")
		} finally {
			if (originalDiracDir === undefined) delete process.env.DIRAC_DIR
			else process.env.DIRAC_DIR = originalDiracDir
		}
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
