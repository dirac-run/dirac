import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as getDiagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { LinterFeedbackProvider } from "@/integrations/diagnostics/LinterFeedbackProvider"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
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
		wrap: sinon.stub().resolves(),
		hideReview: sinon.stub().resolves(),
		perfect: sinon.stub().resolves(),
		scholar: sinon.stub().resolves(),
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
		sent: sinon.stub().resolves({}),
		runUserPromptSubmitHook: sinon.stub().resolves({}),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		nobody: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		trigger: sinon.stub().resolves(),
		updateFCListFromToolResponse: sinon.stub().resolves(),
		small: sinon.stub().returns([true, true]),
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
		isSubagentExecution: true,
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
			institution: {},
			diffViewProvider,
			diracIgnoreController: { validateAccess: () => true },
			commandPermissionController: {},
			father: {},
			requests: {},
		},
		callbacks,
		coordinator: { getHandler: sinon.stub() },
		context: createMockContext(),

		taskMessenger: createMockTaskMessenger(),
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator }
}

describe("EditFileTool.diagnostics", () => {
	let sandbox: sinon.SinonSandbox
	let getDiagnosticsStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-diag-test-"))
		getDiagnosticsStub = sandbox.stub().resolves({ fileDiagnostics: [] })

		// Mock getDiagnosticsProviders to return a provider with short timeouts
		sandbox.stub(getDiagnosticsProvidersModule, "getDiagnosticsProviders").callsFake((useLinter) => {
			if (useLinter) {
				return [getDiagnosticsProvidersModule.getDiagnosticsProviders(true)[0]]
			}
			return [new LinterFeedbackProvider(200, 50)]
		})

		setVscodeHostProviderMock({
			hostBridgeClient: {
				workspaceClient: {
					getDiagnostics: getDiagnosticsStub,
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

	it("reports reduction in linter errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "test.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)
		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// Mock pre-diagnostics with 2 errors
		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [
				{
					filePath,
					diagnostics: [
						{ severity: DiagnosticSeverity.DIAGNOSTIC_ERROR, message: "Error 1" },
						{ severity: DiagnosticSeverity.DIAGNOSTIC_ERROR, message: "Error 2" },
					],
				},
			],
		})

		// Mock post-diagnostics with 1 error
		getDiagnosticsStub.onCall(1).resolves({
			fileDiagnostics: [
				{
					filePath,
					diagnostics: [{ severity: DiagnosticSeverity.DIAGNOSTIC_ERROR, message: "Error 1" }],
				},
			],
		})

		const block = {
			type: "tool_use" as const,
			name: DiracDefaultTool.EDIT_FILE,
			params: {
				files: [
					{
						path: fileName,
						edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "fixed line 2" }],
					},
				],
			},

			call_id: "call-1",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		assert.ok(result.includes("New problems detected after saving the file"))
	})

	it("reports new linter errors with anchored context", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "test.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)
		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// Mock post-diagnostics with 1 new error
		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [
				{
					filePath,
					diagnostics: [
						{
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							message: "New Syntax Error",
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
						},
					],
				},
			],
		})

		const block = {
			type: "tool_use" as const,
			name: DiracDefaultTool.EDIT_FILE,
			params: {
				files: [
					{
						path: fileName,
						edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "bad line 2" }],
					},
				],
			},

			call_id: "call-2",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		assert.ok(result.includes("Found 1 problems"))

		const finalLines = ["line 1", "bad line 2", "line 3"]
		const finalAnchors = AnchorStateManager.reconcile(filePath, finalLines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${finalLines[i]}`,
		)
		assert.ok(result.includes(finalAnchors[1]))
	})

	it("limits new linter errors to 5", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "test.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)

		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)
		// Mock post-diagnostics with 6 new errors
		const diagnostics = []
		for (let i = 1; i <= 6; i++) {
			diagnostics.push({
				severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
				message: `Error ${i}`,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			})
		}

		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [{ filePath, diagnostics }],
		})

		const block = {
			type: "tool_use" as const,
			name: DiracDefaultTool.EDIT_FILE,
			params: {
				files: [
					{
						path: fileName,
						edits: [{ edit_type: "replace", anchor: anchors[0], end_anchor: anchors[0], text: "changed" }],
					},
				],
			},

			call_id: "call-3",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		assert.ok(result.includes("Found 6 problems"))
		assert.ok(result.includes("New problems detected after saving the file"))
	})

	it("reports both fixed and new errors", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "test.txt"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "line 1\nline 2\nline 3"
		await fs.writeFile(filePath, originalContent)

		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// 1 error after edit
		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [
				{
					filePath,
					diagnostics: [
						{
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							message: "New Error",
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						},
					],
				},
			],
		})

		const block = {
			type: "tool_use" as const,
			name: DiracDefaultTool.EDIT_FILE,
			params: {
				files: [
					{
						path: fileName,
						edits: [{ edit_type: "replace", anchor: anchors[0], end_anchor: anchors[0], text: "mixed" }],
					},
				],
			},

			call_id: "call-4",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("New problems detected after saving the file"))
		assert.ok(result.includes("Found 1 problems"))
	})

	it("proceeds normally if diagnostics time out", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)

		const fileName = "timeout.txt"
		const filePath = path.join(tmpDir, fileName)
		await fs.writeFile(filePath, "line 1")

		const lines = ["line 1"]
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// Mock a slow diagnostic response (exceeds our mocked provider's 200ms timeout)
		getDiagnosticsStub.callsFake(
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve({ fileDiagnostics: [] }), 400)
				}),
		)

		const block = {
			type: "tool_use" as const,
			name: DiracDefaultTool.EDIT_FILE,
			params: {
				files: [
					{
						path: fileName,
						edits: [{ edit_type: "replace", anchor: anchors[0], end_anchor: anchors[0], text: "new line 1" }],
					},
				],
			},

			call_id: "call-5",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)

		// Verify edit still succeeded
		const finalContent = await fs.readFile(filePath, "utf8")
		assert.equal(finalContent, "new line 1")

		// Verify tool response indicates success (but no diagnostic info because of timeout)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		assert.ok(!result.includes("linter error"))
	})
})
