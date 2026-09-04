/**
 * Characterization tests for EditFileTool edge cases and bug-finding scenarios.
 * Captures current behavior before refactoring to ensure no regressions.
 */
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { MAX_ANCHORED_FILE_LINES } from "@shared/anchor-limits"
import { CardStatus } from "@shared/ExtensionMessage"
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
import { EditFileApplier } from "../EditFileApplier"

class EditFileToolHandler {
	private tool = new EditFileTool()
	constructor(_validator: any, _forceSyntaxChecker: boolean) { }
	async execute(config: TaskConfig, params: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(params, env)
	}
}

let tmpDir: string

function createConfig(opts: { isSubagent?: boolean; diracIgnore?: any } = {}) {
	const taskState = new TaskState()
	const diffViewProvider = {
		readText: sinon.stub().callsFake(async (filePath: string) => await fs.readFile(filePath, "utf8")),
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
		assertMutationAuthorized: sinon.stub(),
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
	}
	const taskMessenger = createMockTaskMessenger()

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
		model: { id: "test-model", info: { supportsImages: false } },
		supportsNativeWebSearch: false,
		autoApprovalSettings: { enableNotifications: false, actions: { executeCommands: false } },
		autoApprover: {
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
			isUnrestrictedAutoApprove: sinon.stub().returns(true),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
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
		taskMessenger,
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)
	return { config, callbacks, taskState, validator, diffViewProvider, taskMessenger }
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
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
	})

	it("rejects every edit for a file above the hash-anchoring line limit", async () => {
		const { config, validator, diffViewProvider } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		const fileName = "oversized.log"
		const filePath = path.join(tmpDir, fileName)
		const content = Array.from({ length: MAX_ANCHORED_FILE_LINES + 1 }, (_, index) => `line ${index + 1}`).join("\n")
		await fs.writeFile(filePath, content)

		const result = await handler.execute(config, {
			files: [{
				path: fileName,
				edits: [{ edit_type: "replace", anchor: "Apple§line 1", end_anchor: "Apple§line 1", text: "changed" }],
			}],
		})

		assert.ok(typeof result === "string")
		assert.ok(result.includes(`${MAX_ANCHORED_FILE_LINES + 1} lines`))
		assert.ok(result.includes("use execute_command"))
		assert.equal(await fs.readFile(filePath, "utf8"), content)
		sinon.assert.notCalled(diffViewProvider.readText)
		sinon.assert.notCalled(diffViewProvider.applyAndSaveBatchSilently)
	})

	it("counts the saved editor buffer before rejecting an oversized disk file", async () => {
		const { config, validator } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		const fileName = "dirty-buffer.txt"
		const filePath = path.join(tmpDir, fileName)
		const editorContent = "current line 1\ncurrent line 2"
		await fs.writeFile(
			filePath,
			Array.from({ length: MAX_ANCHORED_FILE_LINES + 1 }, (_, index) => `stale ${index}`).join("\n"),
		)
		const saveDirtyDocument = sandbox.stub().callsFake(async () => {
			await fs.writeFile(filePath, editorContent)
			return { wasSaved: true }
		})
		setVscodeHostProviderMock({
			hostBridgeClient: {
				workspaceClient: {
					getDiagnostics: sandbox.stub().resolves({ fileDiagnostics: [] }),
					prepareDiagnostics: sandbox.stub().resolves({}),
					getWorkspacePaths: sandbox.stub().resolves({ paths: [tmpDir] }),
					saveOpenDocumentIfDirty: saveDirtyDocument,
				},
			} as any,
		})
		const anchors = makeAnchors(filePath, editorContent, config.ulid)

		const result = await handler.execute(config, {
			files: [{
				path: fileName,
				edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "updated line 2" }],
			}],
		})

		sinon.assert.called(saveDirtyDocument)
		assert.equal(await fs.readFile(filePath, "utf8"), "current line 1\nupdated line 2")
		assert.ok(typeof result === "string" && result.includes("Applied 1 edit(s) successfully"))
	})

	it("rejects oversized approval-time content before writing", async () => {
		const { config, diffViewProvider } = createConfig()
		const fileName = "manual-review.txt"
		const filePath = path.join(tmpDir, fileName)
		await fs.writeFile(filePath, "original")
		const env = new SurfaceAdapter(config)
		const applier = new EditFileApplier({} as any)
		const oversizedContent = Array.from(
			{ length: MAX_ANCHORED_FILE_LINES + 1 },
			(_, index) => `user line ${index}`,
		).join("\n")

		await assert.rejects(
			applier.applyAndSave(
				env,
				[{ absolutePath: filePath, displayPath: fileName, blocks: [], prepared: { finalContent: "model edit" } as any }],
				{},
				{ [fileName]: oversizedContent },
			),
			/Cannot save manual-review\.txt.*hash-anchoring limit/,
		)

		assert.equal(await fs.readFile(filePath, "utf8"), "original")
		sinon.assert.notCalled(diffViewProvider.applyAndSaveBatchSilently)
	})

	it("keeps formatter-expanded oversized output saved and clears its anchors", async () => {
		const { config, validator, diffViewProvider } = createConfig()
		const handler = new EditFileToolHandler(validator, false)
		const fileName = "formatter-expanded.txt"
		const filePath = path.join(tmpDir, fileName)
		const content = "line 1\nline 2"
		await fs.writeFile(filePath, content)
		const anchors = makeAnchors(filePath, content, config.ulid)
		const formattedContent = Array.from(
			{ length: MAX_ANCHORED_FILE_LINES + 1 },
			(_, index) => `formatted ${index}`,
		).join("\n")
		diffViewProvider.format.callsFake(async () => {
			await fs.writeFile(filePath, formattedContent)
			return formattedContent
		})

		const result = await handler.execute(config, {
			files: [{
				path: fileName,
				edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "changed" }],
			}],
		})

		assert.equal(await fs.readFile(filePath, "utf8"), formattedContent)
		assert.equal(AnchorStateManager.isTracking(filePath, config.ulid), false)
		assert.ok(typeof result === "string" && result.includes("Warning after saving"))
		assert.ok(typeof result === "string" && result.includes("use execute_command"))
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
			const block = makeBlock([
				{ path: "test.txt", edits: [{ edit_type: "replace", anchor: "x", end_anchor: "x", text: "y" }] },
			])
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

		it("does not apply a prepared edit when mutation consent is revoked after approval", async () => {
			const { config, callbacks, validator, diffViewProvider } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "revoked.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2"
			await fs.writeFile(filePath, content)
			const anchors = makeAnchors(filePath, content, config.ulid)
			callbacks.assertMutationAuthorized.throws(new Error("Plan Mode revoked mutation"))

			await assert.rejects(
				handler.execute(config, {
					files: [
						{
							path: fileName,
							edits: [
								{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "changed" },
							],
						},
					],
				}),
				/Plan Mode revoked mutation/,
			)

			assert.equal(await fs.readFile(filePath, "utf8"), content)
			sinon.assert.calledOnceWithExactly(callbacks.assertMutationAuthorized, "edit_file")
			sinon.assert.notCalled(diffViewProvider.applyAndSaveBatchSilently)
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
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "replace", anchor: "x", end_anchor: "x", text: "y" }] },
			])
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

		it("returns current disk anchors after formatting changes surrounding context", async () => {
			const { config, validator, diffViewProvider } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "test.txt"
			const filePath = path.join(tmpDir, fileName)
			const content = "line 1\nline 2\nline 3"
			await fs.writeFile(filePath, content)
			const initialAnchors = makeAnchors(filePath, content, config.ulid)
			const formattedContent = "formatted line 1\nnew line 2\nline 3"
			diffViewProvider.format.callsFake(async (formattedPath: string) => {
				await fs.writeFile(formattedPath, formattedContent)
				return formattedContent
			})

			const block = makeBlock([
				{
					path: fileName,
					edits: [
						{ edit_type: "replace", anchor: initialAnchors[1], end_anchor: initialAnchors[1], text: "new line 2" },
					],
				},
			])
			const result = await handler.execute(config, block.params)
			const finalContent = await fs.readFile(filePath, "utf8")
			assert.equal(finalContent, formattedContent)
			assert.ok(result.includes("formatted line 1"), "formatted context should reflect final disk content")
			assert.ok(result.includes("new line 2"), "edited line should reflect final disk content")
			assert.ok(!/^[A-Z][a-zA-Z]*§/m.test(result), "edit results should not expose reusable coordinates")
			assert.ok(result.includes("(unanchored):"), "result should label plain content without reusable coordinates")
			assert.ok(!result.includes("reread"), "successful edits should not repeat tool instructions")
			assert.ok(!/auto-formatting/i.test(result), "formatter changes should not add model-facing noise")
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

		it("finalizes every progress card when a batch save fails", async () => {
			const { config, taskState, validator, diffViewProvider, taskMessenger } = createConfig({ isSubagent: false })
			const handler = new EditFileToolHandler(validator, false)
			const files = ["failed-a.txt", "failed-b.txt"]
			const blocks = []
			for (const [index, file] of files.entries()) {
				const filePath = path.join(tmpDir, file)
				const content = `line ${index}\noriginal`
				await fs.writeFile(filePath, content)
				const anchors = makeAnchors(filePath, content, config.ulid)
				blocks.push({
					path: file,
					edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "changed" }],
				})
			}
			const block = makeBlock(blocks)
			taskState.assistantMessageContent = [block]
				; (diffViewProvider.applyAndSaveBatchSilently as sinon.SinonStub).rejects(new Error("batch save failed"))

			await assert.rejects(handler.execute(config, block.params), /batch save failed/)

			assert.equal(taskMessenger.createCard.callCount, 2)
			const protocolCard = await taskMessenger.createCard.firstCall.returnValue
			assert.equal(protocolCard.finalize.callCount, 2)
			sinon.assert.alwaysCalledWith(protocolCard.finalize, CardStatus.ERROR)
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

		it("resolves anchors against the editor transport's authoritative content", async () => {
			const { config, taskState, validator, diffViewProvider } = createConfig()
			const handler = new EditFileToolHandler(validator, false)
			const fileName = "authoritative.txt"
			const filePath = path.join(tmpDir, fileName)
			const localContent = "stale 1\nstale 2"
			const authoritativeContent = "current 1\ncurrent 2"
			await fs.writeFile(filePath, localContent)
				; (diffViewProvider.readText as sinon.SinonStub).resolves(authoritativeContent)
			const anchors = makeAnchors(filePath, authoritativeContent, config.ulid)
			const block = makeBlock([
				{ path: fileName, edits: [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "updated 2" }] },
			])
			taskState.assistantMessageContent = [block]

			const result = await handler.execute(config, block.params)

			sinon.assert.calledWith(diffViewProvider.readText as sinon.SinonStub, filePath)
			assert.equal(await fs.readFile(filePath, "utf8"), "current 1\nupdated 2")
			assert.ok(typeof result === "string" && result.includes("Applied 1 edit(s) successfully"))
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
