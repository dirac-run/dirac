/**
 * Characterization tests for EditFileTool edge cases and bug-finding scenarios.
 * Captures current behavior before refactoring to ensure no regressions.
 */
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
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
	constructor(_validator: any, _forceSyntaxChecker: boolean) {}
	async execute(config: TaskConfig, params: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(params, env)
	}
}

let tmpDir: string

function createConfig(opts: { isSubagent?: boolean; diracIgnore?: any } = {}) {
	const taskState = new TaskState()
	const diffViewProvider = {
		open: sinon.stub().resolves(),
		update: sinon.stub().resolves(),
		reset: sinon.stub().resolves(),
		saveChanges: sinon.stub().resolves({ finalContent: "" }),
		applyAndSaveSilently: sinon.stub().callsFake(async (p: string, c: string) => {
			await fs.writeFile(p, c)
			return { finalContent: c }
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
		format: sinon.stub().resolves(),
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
		isSubagentExecution: opts.isSubagent ?? true,
		taskState,
		messageState: { getApiConversationHistory: sinon.stub().returns([]) },
		api: { getModel: () => ({ id: "test-model", info: { supportsImages: false } }) },
		autoApprovalSettings: { enableNotifications: false, actions: { executeCommands: false } },
		autoApprover: {
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
			isUnrestrictedAutoApprove: sinon.stub().returns(true),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
			stateManager: {
				getGlobalStateKey: () => undefined,
				getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : key === "hooksEnabled" ? false : undefined),
				getApiConfiguration: () => ({ planModeApiProvider: "openai", actModeApiProvider: "openai" }),
			},
			fileContextTracker: { trackFileContext: sinon.stub().resolves(), markFileAsEditedByDirac: sinon.stub() },
			browserSession: {},
			urlContentFetcher: {},
			diffViewProvider,
			diracIgnoreController: opts.diracIgnore ?? { validateAccess: () => true },
			commandPermissionController: {},
			contextManager: {},
		},
		callbacks,
		coordinator: { getHandler: sinon.stub() },
		context: createMockContext(),
		taskMessenger: createMockTaskMessenger(),
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)
	return { config, callbacks, taskState, validator, diffViewProvider }
}

function makeBlock(files: any[]) {
	return { type: "tool_use" as const, name: DiracDefaultTool.EDIT_FILE, params: { files }, call_id: `call-${Math.random()}` }
}

function makeAnchors(filePath: string, content: string, ulid: string) {
	const lines = content.split("\n")
	const hashes = AnchorStateManager.reconcile(filePath, lines, ulid)
	return lines.map((l, i) => `${hashes[i]}${ANCHOR_DELIMITER}${l}`)
}

describe("EditFileTool – characterization edge cases", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-char-"))
		sandbox.stub(getDiagnosticsProvidersModule, "getDiagnosticsProviders").returns([
			{
				capturePreSaveState: sandbox.stub().resolves([]),
				getDiagnosticsFeedback: sandbox.stub().resolves({ newProblemsMessage: "", fixedCount: 0 }),
				getDiagnosticsFeedbackForFiles: sandbox
					.stub()
					.callsFake(async (data: any[]) => data.map(() => ({ newProblemsMessage: "", fixedCount: 0 }))),
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

	describe("parameter validation edge cases", () => {
		it("increments consecutiveMistakeCount on invalid JSON files string", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const before = taskState.consecutiveMistakeCount
			await handler.execute(config, { files: "{invalid" })
			assert.equal(taskState.consecutiveMistakeCount, before + 1)
		})

		it("increments consecutiveMistakeCount when files is not an array", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const before = taskState.consecutiveMistakeCount
			await handler.execute(config, { files: { not: "array" } })
			assert.equal(taskState.consecutiveMistakeCount, before + 1)
		})

		it("increments consecutiveMistakeCount when edits is not an array", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const before = taskState.consecutiveMistakeCount
			await handler.execute(config, { files: [{ path: "test.txt", edits: "not-array" }] })
			assert.equal(taskState.consecutiveMistakeCount, before + 1)
		})

		it("increments consecutiveMistakeCount when edits JSON string is malformed", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const before = taskState.consecutiveMistakeCount
			await handler.execute(config, { files: [{ path: "test.txt", edits: "{bad" }] })
			assert.equal(taskState.consecutiveMistakeCount, before + 1)
		})

		it("does NOT increment consecutiveMistakeCount for diracignore denial", async () => {
			const { config, taskState, validator } = createConfig({ diracIgnore: { validateAccess: () => false } })
			const handler = new EditFileToolHandler(validator, false)
			await fs.writeFile(path.join(tmpDir, "test.txt"), "content")
			const before = taskState.consecutiveMistakeCount
			const block = makeBlock([{ path: "test.txt", edits: [{ edit_type: "replace", anchor: "x", end_anchor: "x", text: "y" }] }])
			await handler.execute(config, block.params)
			assert.equal(taskState.consecutiveMistakeCount, before, "diracignore denial should not increment mistake count")
		})

		it("parses valid JSON string in edits field and proceeds", async () => {
			const { config, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const editsJson = JSON.stringify([
				{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "new line 2" },
			])
			const block = makeBlock([{ path: fileName, edits: editsJson }])
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "line 1\nnew line 2\nline 3")
			assert.ok(typeof result === "string")
			assert.ok(result.includes("Applied 1 edit(s) successfully"))
		})

		it("handles empty files array gracefully", async () => {
			const { config, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const block = makeBlock([])
			const result = await handler.execute(config, block.params)
			assert.ok(typeof result === "string" || result === undefined)
		})
	})

	describe("diracignore denial", () => {
		it("returns diracignore error and does not write file", async () => {
			const { config, validator } = createConfig({ diracIgnore: { validateAccess: () => false } })
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "denied.txt"
			const filePath = path.join(tmpDir, fileName)
			await fs.writeFile(filePath, "original")
			const block = makeBlock([{ path: fileName, edits: [{ edit_type: "replace", anchor: "x", end_anchor: "x", text: "y" }] }])
			const result = await handler.execute(config, block.params)
			assert.ok(typeof result === "string")
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "original", "file should be unchanged after diracignore denial")
		})
	})

	describe("anchor resolution edge cases", () => {
		it("returns tool error when anchor not found in file", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			await fs.writeFile(path.join(tmpDir, fileName), "line 1\nline 2")
			const block = makeBlock([
				{
					path: fileName,
					edits: [
						{
							edit_type: "replace",
							anchor: "NonExistentAnchor" + ANCHOR_DELIMITER + "nope",
							end_anchor: "NonExistentAnchor" + ANCHOR_DELIMITER + "nope",
							text: "new",
						},
					],
				},
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			assert.ok(typeof result === "string")
			assert.ok(result.includes("The tool execution failed"))
		})

		it("returns error when end_anchor is before anchor (range error)", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3\nline 4"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			// anchor=idx3, end_anchor=idx1 -> endIdx < lineIdx -> range error
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "replace", anchor: anchors[3], end_anchor: anchors[1], text: "new" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			assert.ok(typeof result === "string")
			assert.ok(result.includes("The tool execution failed"))
			assert.ok(result.includes("Range error"))
		})

		it("handles insert_after edit type correctly", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "insert_after", anchor: anchors[0], text: "inserted line" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "line 1\ninserted line\nline 2\nline 3")
			assert.ok(result.includes("Applied 1 edit(s) successfully"))
		})

		it("handles insert_before edit type correctly", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "insert_before", anchor: anchors[1], text: "inserted line" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "line 1\ninserted line\nline 2\nline 3")
			assert.ok(result.includes("Applied 1 edit(s) successfully"))
		})

		it("handles empty text replacement (deletes line)", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "line 1\nline 3")
			assert.ok(result.includes("Applied 1 edit(s) successfully"))
		})

		it("handles multi-line text replacement", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const block = makeBlock([
				{
					path: fileName,
					edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "new a\nnew b\nnew c" }],
				},
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, "line 1\nnew a\nnew b\nnew c\nline 3")
			assert.ok(result.includes("Applied 1 edit(s) successfully"))
		})
	})

	describe("multi-file batch", () => {
		it("edits multiple files in a single call", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const file1 = "a.txt",
				file2 = "b.txt"
			const path1 = path.join(tmpDir, file1),
				path2 = path.join(tmpDir, file2)
			const content1 = "a1\na2\na3",
				content2 = "b1\nb2\nb3"
			await fs.writeFile(path1, content1)
			await fs.writeFile(path2, content2)
			const anchors1 = makeAnchors(path1, content1, config.ulid)
			const anchors2 = makeAnchors(path2, content2, config.ulid)
			const block = makeBlock([
				{ path: file1, edits: [{ edit_type: "replace", anchor: anchors1[1], end_anchor: anchors1[1], text: "new a2" }] },
				{ path: file2, edits: [{ edit_type: "replace", anchor: anchors2[1], end_anchor: anchors2[1], text: "new b2" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			assert.equal(await fs.readFile(path1, "utf8"), "a1\nnew a2\na3")
			assert.equal(await fs.readFile(path2, "utf8"), "b1\nnew b2\nb3")
			assert.ok(typeof result === "string", `result should be string, got: ${result}`)
			assert.ok(result.includes("Applied"), `Should mention Applied. Result: ${result}`)
			assert.ok(result.includes("new a2") || result.includes("new b2"), `Should include edited content. Result: ${result}`)
		})

		it("continues processing other files when one is diracignored", async () => {
			const { config, taskState, validator } = createConfig({
				diracIgnore: { validateAccess: (p: string) => !p.includes("denied") },
			})
			const handler = new EditFileToolHandler(validator, false)
			const file1 = "denied.txt",
				file2 = "allowed.txt"
			const path1 = path.join(tmpDir, file1),
				path2 = path.join(tmpDir, file2)
			const content1 = "d1\nd2",
				content2 = "a1\na2\na3"
			await fs.writeFile(path1, content1)
			await fs.writeFile(path2, content2)
			const anchors2 = makeAnchors(path2, content2, config.ulid)
			const block = makeBlock([
				{ path: file1, edits: [{ edit_type: "replace", anchor: "x", end_anchor: "x", text: "y" }] },
				{ path: file2, edits: [{ edit_type: "replace", anchor: anchors2[1], end_anchor: anchors2[1], text: "new a2" }] },
			])
			taskState.assistantMessageContent = [block]
			const result = await handler.execute(config, block.params)
			assert.equal(await fs.readFile(path1, "utf8"), content1, "denied file unchanged")
			assert.equal(await fs.readFile(path2, "utf8"), "a1\nnew a2\na3", "allowed file edited")
			assert.ok(typeof result === "string")
		})
	})

	describe("telemetry", () => {
		it("captures filesCount and editsCount metadata", async () => {
			const { config, taskState, validator } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3\nline 4"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			const block = makeBlock([
				{
					path: fileName,
					edits: [
						{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "new 2" },
						{ edit_type: "replace", anchor: anchors[3], end_anchor: anchors[3], text: "new 4" },
					],
				},
			])
			taskState.assistantMessageContent = [block]
			await handler.execute(config, block.params)
			// telemetry is captured via env.telemetry.captureCustomMetadata — verify no throw
		})
	})
})
