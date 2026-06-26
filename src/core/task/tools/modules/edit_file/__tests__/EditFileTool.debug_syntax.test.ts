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
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { TaskState } from "../../../../TaskState"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { EditFileTool } from "../EditFileTool"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"

class EditFileToolHandler {
	private tool = new EditFileTool()
	public diagnosticsDelayMs: number = 0
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
		validation: sinon.stub().resolves(true),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: tmpDir,
		mode: "act",
		isSubagentExecution: true,
		taskState,
		services: {
			fileContextTracker: {
				trackFileContext: sinon.stub().resolves(),
				markFileAsEditedByDirac: sinon.stub(),
			},
			diffViewProvider,
			diracIgnoreController: { validateAccess: () => true },
			stateManager: {
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					return undefined
				},
			},
		},
		callbacks,
		context: createMockContext(),

		taskMessenger: createMockTaskMessenger(),
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator }
}

describe("EditFileTool – debug syntax", () => {
	let sandbox: sinon.SinonSandbox
	let getDiagnosticsStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-debug-syntax-"))
		getDiagnosticsStub = sandbox.stub().resolves({ fileDiagnostics: [] })

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

	it("should report syntax error in Python", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, true)
		handler.diagnosticsDelayMs = 0
		handler.diagnosticsTimeoutMs = 1000

		const fileName = "test.py"
		const filePath = path.join(tmpDir, fileName)
		const originalContent = "def hello():\n    print('hello')"
		await fs.writeFile(filePath, originalContent)

		const lines = originalContent.split("\n")
		const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
		)

		// Set up post-edit diagnostics to return a syntax error
		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [
				{
					filePath,
					diagnostics: [
						{
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							message: "Syntax error at line 2: unexpected token",
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
						edits: [
							{
								edit_type: "replace",
								anchor: anchors[1],
								end_anchor: anchors[1],
								text: "    print('missing closing paren'",
							},
						],
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
		assert.ok(result.includes("Found 1 problems"))
	})

	it("should report syntax errors for multiple files", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, true)
		handler.diagnosticsDelayMs = 0
		handler.diagnosticsTimeoutMs = 1000

		const file1 = "test1.py"
		const file2 = "test2.py"
		const path1 = path.join(tmpDir, file1)
		const path2 = path.join(tmpDir, file2)
		const content1 = "def hello():\n    print('hello')"
		const content2 = "def world():\n    print('world')"
		await fs.writeFile(path1, content1)
		await fs.writeFile(path2, content2)

		const lines1 = content1.split("\n")
		const lines2 = content2.split("\n")
		const anchors1 = AnchorStateManager.reconcile(path1, lines1, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines1[i]}`,
		)
		const anchors2 = AnchorStateManager.reconcile(path2, lines2, config.ulid).map(
			(a, i) => `${a}${ANCHOR_DELIMITER}${lines2[i]}`,
		)

		// Set up post-edit diagnostics to return syntax errors for both files
		getDiagnosticsStub.onCall(0).resolves({
			fileDiagnostics: [
				{
					filePath: path1,
					diagnostics: [
						{
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							message: "Syntax error at line 2",
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
						},
					],
				},
				{
					filePath: path2,
					diagnostics: [
						{
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							message: "Syntax error at line 2",
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
						path: file1,
						edits: [
							{ edit_type: "replace", anchor: anchors1[1], end_anchor: anchors1[1], text: "    print('error1'" },
						],
					},
					{
						path: file2,
						edits: [
							{ edit_type: "replace", anchor: anchors2[1], end_anchor: anchors2[1], text: "    print('error2'" },
						],
					},
				],
			},

			call_id: "call-multi",
		}

		taskState.assistantMessageContent = [block]

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Applied 1 edit(s) successfully"))
		assert.ok(result.includes("New problems detected after saving the file"))
		assert.ok(result.includes("Found 1 problems"))
	})
})
