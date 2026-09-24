import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as iconv from "iconv-lite"
import { readTextFileWindow } from "@integrations/misc/read-text-file-window"
import { DiracDefaultTool } from "@shared/tools"
import { MAX_ANCHORED_FILE_LINES } from "@shared/anchor-limits"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "../../../../TaskState"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { ReadFileTool } from "../ReadFileTool"

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
	constructor(_validator: any) { }
	async execute(config: TaskConfig, block: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(block.params, env)
	}
}

function createConfig(supportsImages = false) {
	const taskState = new TaskState()

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
		model: { id: "test-model", info: { supportsImages } },
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

function makeBlock(relPath?: string, params: Record<string, unknown> = {}) {
	return {
		type: "tool_use" as const,
		name: DiracDefaultTool.FILE_READ,
		params: relPath !== undefined ? { paths: [relPath], ...params } : params,
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
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
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

describe("ReadFileToolHandler.execute – include_anchors visibility and cache", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-read-cache-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		AnchorStateManager.reset("ulid-1")
	})

	afterEach(async () => {
		AnchorStateManager.reset("ulid-1")
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
	})

	function makeReadBlock(relPath: string, includeAnchors?: boolean) {
		return {
			type: "tool_use" as const,
			name: DiracDefaultTool.FILE_READ,
			params: includeAnchors === undefined ? { paths: [relPath] } : { paths: [relPath], include_anchors: includeAnchors },
		}
	}

	it("defaults to plain output while allowing a later anchored read of unchanged content", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "cache-mode.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "first line\nsecond line")

		const plainResult = (await handler.execute(config, makeReadBlock(realFile))) as string
		assert.ok(plainResult.includes("first line\nsecond line"))
		assert.ok(!/^[A-Z][a-zA-Z]*§first line/m.test(plainResult))

		const anchoredResult = (await handler.execute(config, makeReadBlock(realFile, true))) as string
		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(anchoredResult))
		assert.ok(/^[A-Z][a-zA-Z]*§second line/m.test(anchoredResult))

		const repeatedAnchoredResult = (await handler.execute(config, makeReadBlock(realFile, true))) as string
		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(repeatedAnchoredResult))
		assert.ok(/^[A-Z][a-zA-Z]*§second line/m.test(repeatedAnchoredResult))
		assert.ok(!repeatedAnchoredResult.includes("no changes have been made"))
	})

	it("re-emits anchored content when the persisted file hash outlives anchor state", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "lost-anchor-state.txt"
		const absolutePath = path.join(tmpDir, realFile)
		await fs.writeFile(absolutePath, "first line\nsecond line")

		const firstRead = (await handler.execute(config, makeReadBlock(realFile, true))) as string
		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(firstRead))

		AnchorStateManager.reset(config.ulid)
		const refreshedRead = (await handler.execute(config, makeReadBlock(realFile, true))) as string

		assert.ok(!refreshedRead.includes("no changes have been made"))
		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(refreshedRead))
		assert.ok(AnchorStateManager.isTracking(absolutePath, config.ulid))
	})

	it("re-emits a restored anchored mapping so its coordinates remain available", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "restored-anchor-state.txt"
		const absolutePath = path.join(tmpDir, realFile)
		await fs.writeFile(absolutePath, "first line\nsecond line")

		await handler.execute(config, makeReadBlock(realFile, true))
		const persisted = AnchorStateManager.exportState(config.ulid)
		const fingerprint = AnchorStateManager.getDocumentFingerprint(absolutePath, config.ulid)

		AnchorStateManager.reset(config.ulid)
		AnchorStateManager.hydrate(config.ulid, persisted)
		const repeatedRead = (await handler.execute(config, makeReadBlock(realFile, true))) as string

		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(repeatedRead))
		assert.ok(/^[A-Z][a-zA-Z]*§second line/m.test(repeatedRead))
		assert.ok(!repeatedRead.includes("no changes have been made"))
		assert.equal(AnchorStateManager.getDocumentFingerprint(absolutePath, config.ulid), fingerprint)
	})

	it("never suppresses a fresh mapping seeded after the emitted mapping was lost", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "failed-edit-seeded-state.txt"
		const absolutePath = path.join(tmpDir, realFile)
		const lines = ["first line", "second line"]
		await fs.writeFile(absolutePath, lines.join("\n"))
		const randomStub = sandbox.stub(Math, "random").returns(0)

		await handler.execute(config, makeReadBlock(realFile, true))
		const emittedFingerprint = AnchorStateManager.getDocumentFingerprint(absolutePath, config.ulid)

		AnchorStateManager.reset(config.ulid)
		randomStub.returns(0.999999)
		AnchorStateManager.reconcile(absolutePath, lines, config.ulid)
		const neverEmittedFingerprint = AnchorStateManager.getDocumentFingerprint(absolutePath, config.ulid)
		assert.notEqual(neverEmittedFingerprint, emittedFingerprint)

		const reread = (await handler.execute(config, makeReadBlock(realFile, true))) as string
		assert.ok(!reread.includes("no changes have been made"))
		assert.ok(/^[A-Z][a-zA-Z]*§first line/m.test(reread))
	})

	it("does not let a partial read suppress a later full read", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "partial-then-full.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "first line\nsecond line\nthird line")

		const partialResult = (await handler.execute(config, {
			type: "tool_use",
			name: DiracDefaultTool.FILE_READ,
			params: { paths: [realFile], start_line: 1, end_line: 1 },
		})) as string
		assert.ok(partialResult.includes("first line"))
		assert.ok(!partialResult.includes("second line"))

		const fullResult = (await handler.execute(config, makeReadBlock(realFile))) as string
		assert.ok(fullResult.includes("first line\nsecond line\nthird line"))
		assert.ok(!fullResult.includes("no changes have been made"))
	})

	it("enforces the text byte limit after selecting lines", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "large-lines.txt"
		await fs.writeFile(path.join(tmpDir, realFile), `${"x".repeat(51 * 1024)}\nsmall`)

		const oversizedLineResult = (await handler.execute(config, {
			type: "tool_use",
			name: DiracDefaultTool.FILE_READ,
			params: { paths: [realFile], start_line: 1, end_line: 1 },
		})) as string
		assert.ok(oversizedLineResult.includes("exceeds the 51200-byte read limit"))

		const smallRangeResult = (await handler.execute(config, {
			type: "tool_use",
			name: DiracDefaultTool.FILE_READ,
			params: { paths: [realFile], start_line: 2, end_line: 2 },
		})) as string
		assert.ok(smallRangeResult.includes("small"))
	})

	it("rejects zero and fractional line numbers", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "invalid-range.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "content")

		await assert.rejects(
			handler.execute(config, {
				type: "tool_use",
				name: DiracDefaultTool.FILE_READ,
				params: { paths: [realFile], start_line: 0 },
			}),
			/start_line: must be an integer >= 1/,
		)
		await assert.rejects(
			handler.execute(config, {
				type: "tool_use",
				name: DiracDefaultTool.FILE_READ,
				params: { paths: [realFile], end_line: 1.5 },
			}),
			/end_line: must be an integer >= 1/,
		)
	})

	it("supports start-only, end-only, and end-past-EOF ranges", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "range-shapes.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo\nthree\nfour")

		const startOnly = (await handler.execute(config, makeBlock(realFile, { start_line: 3 }))) as string
		assert.ok(startOnly.includes("three\nfour"))
		assert.ok(!startOnly.includes("one\ntwo"))
		assert.ok(startOnly.includes("[Lines: 3-4 of 4]\nthree\nfour"))

		const endOnly = (await handler.execute(config, makeBlock(realFile, { end_line: 2 }))) as string
		assert.ok(endOnly.includes("one\ntwo"))
		assert.ok(!endOnly.includes("three"))
		assert.ok(endOnly.includes("[Lines: 1-2 of 4]\none\ntwo"))

		const pastEof = (await handler.execute(config, makeBlock(realFile, { start_line: 3, end_line: 99 }))) as string
		assert.ok(pastEof.includes("three\nfour"))
		assert.ok(pastEof.includes("[Lines: 3-4 of 4]\nthree\nfour"))
	})

	it("rejects negative, nonnumeric, reversed, and past-EOF ranges", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "more-invalid-ranges.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo")

		await assert.rejects(handler.execute(config, makeBlock(realFile, { start_line: -1 })), /start_line/)
		await assert.rejects(handler.execute(config, makeBlock(realFile, { start_line: "nope" })), /start_line/)
		await assert.rejects(
			handler.execute(config, makeBlock(realFile, { start_line: 2, end_line: 1 })),
			/start_line 2 cannot be greater than end_line 1/,
		)

		const pastEof = (await handler.execute(config, makeBlock(realFile, { start_line: 3 }))) as string
		assert.ok(pastEof.includes("start_line 3 exceeds file length"))
	})

	it("enforces the limit for full and unbounded reads", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "large-full-read.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "x".repeat(50 * 1024 + 1))

		const fullResult = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(fullResult.includes("exceeds the 51200-byte read limit"))

		const startOnlyResult = (await handler.execute(config, makeBlock(realFile, { start_line: 1 }))) as string
		assert.ok(startOnlyResult.includes("exceeds the 51200-byte read limit"))
	})

	it("enforces the limit across multiple selected lines", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "combined-large-range.txt"
		await fs.writeFile(path.join(tmpDir, realFile), `${"a".repeat(30 * 1024)}\n${"b".repeat(21 * 1024)}`)

		const result = (await handler.execute(config, makeBlock(realFile, { start_line: 1, end_line: 2 }))) as string
		assert.ok(result.includes("exceeds the 51200-byte read limit"))
	})

	it("accepts exactly 50 KiB and counts UTF-8 bytes", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const exactFile = "exact-limit.txt"
		const multibyteFile = "multibyte-limit.txt"
		await fs.writeFile(path.join(tmpDir, exactFile), "x".repeat(50 * 1024))
		await fs.writeFile(path.join(tmpDir, multibyteFile), "é".repeat(25 * 1024 + 1))

		const exactResult = (await handler.execute(config, makeBlock(exactFile))) as string
		assert.ok(exactResult.includes("x".repeat(100)))
		assert.ok(!exactResult.includes("exceeds the 51200-byte read limit"))

		const multibyteResult = (await handler.execute(config, makeBlock(multibyteFile))) as string
		assert.ok(multibyteResult.includes("exceeds the 51200-byte read limit"))
	})

	it("does not cache a read that failed the text-size guard", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "failed-size-cache.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "x".repeat(50 * 1024 + 1))

		const failed = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(failed.includes("exceeds the 51200-byte read limit"))

		await fs.writeFile(path.join(tmpDir, realFile), "now small")
		const successful = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(successful.includes("now small"))
		assert.ok(!successful.includes("no changes have been made"))
	})

	it("never suppresses partial reads even when a full read is cached", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "full-then-partial.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo\nthree")

		await handler.execute(config, makeBlock(realFile))
		const firstPartial = (await handler.execute(config, makeBlock(realFile, { start_line: 2, end_line: 2 }))) as string
		const repeatedPartial = (await handler.execute(config, makeBlock(realFile, { start_line: 2, end_line: 2 }))) as string

		assert.ok(firstPartial.includes("two"))
		assert.ok(repeatedPartial.includes("two"))
		assert.ok(!firstPartial.includes("no changes have been made"))
		assert.ok(!repeatedPartial.includes("no changes have been made"))
	})

	it("does not cache an explicit range even when it covers the whole file", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "explicit-complete-range.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo")

		const ranged = (await handler.execute(config, makeBlock(realFile, { start_line: 1, end_line: 99 }))) as string
		assert.ok(ranged.includes("one\ntwo"))

		const firstFull = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(firstFull.includes("one\ntwo"))
		assert.ok(!firstFull.includes("no changes have been made"))

		const repeatedFull = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(repeatedFull.includes("no changes have been made"))
	})

	it("returns changed full-file content instead of the cached response", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "changed-file.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "before")
		await handler.execute(config, makeBlock(realFile))

		await fs.writeFile(path.join(tmpDir, realFile), "after")
		const changed = (await handler.execute(config, makeBlock(realFile))) as string
		assert.ok(changed.includes("after"))
		assert.ok(!changed.includes("no changes have been made"))
	})

	it("shares cache identity across relative aliases of the same file", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "aliased-file.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "same file")

		await handler.execute(config, makeBlock(realFile))
		const aliasedRead = (await handler.execute(config, makeBlock(`./${realFile}`))) as string
		assert.ok(aliasedRead.includes("no changes have been made"))
	})

	it("anchors only the selected lines in a ranged read", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "anchored-range.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "first\nsecond\nthird")

		const result = (await handler.execute(
			config,
			makeBlock(realFile, { start_line: 2, end_line: 2, include_anchors: true }),
		)) as string
		assert.ok(result.includes("[Lines: 2-2 of 3]\n"))
		assert.ok(/^[A-Z][a-zA-Z]*§second$/m.test(result))
		assert.ok(!/§first$/m.test(result))
		assert.ok(!/§third$/m.test(result))
	})

	it("decodes streamed non-UTF-8 text", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const cases = [
			{ file: "windows-1252.txt", encoding: "windows-1252", text: "Price €100 — “yes” ".repeat(50) },
			{ file: "utf-16.txt", encoding: "utf16", text: "first UTF-16 line\nsecond UTF-16 line" },
		]

		for (const testCase of cases) {
			await fs.writeFile(path.join(tmpDir, testCase.file), iconv.encode(testCase.text, testCase.encoding))
			const result = (await handler.execute(config, makeBlock(testCase.file))) as string
			assert.ok(result.includes(testCase.text))
		}
	})

	it("keeps decoding when non-ASCII UTF-8 appears after an ASCII-only stream chunk", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "late-utf8.txt"
		await fs.writeFile(path.join(tmpDir, realFile), `${"a".repeat(70 * 1024)}\nlate café`)

		const result = (await handler.execute(
			config,
			makeBlock(realFile, { start_line: 2, end_line: 2 }),
		)) as string

		assert.ok(result.includes("late café"))
	})

	it("discards a complete snapshot above the retained-byte cap", async () => {
		const realFile = path.join(tmpDir, "retained-byte-cap.txt")
		await fs.writeFile(realFile, "x".repeat(100))

		const result = await readTextFileWindow(realFile, {
			startLine: 1,
			maxSelectedBytes: 1024,
			maxRetainedLines: 10,
			maxRetainedBytes: 32,
		})

		assert.equal(result.completeText, undefined)
		assert.deepEqual(result.selectedLines, ["x".repeat(100)])
	})

	it("rejects binary data routed through the raw text reader", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "binary-data.bin"
		await fs.writeFile(
			path.join(tmpDir, realFile),
			Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)),
		)

		const result = (await handler.execute(config, makeBlock(realFile))) as string

		assert.ok(result.includes("Cannot read binary content as text"))
	})

	it("uses one streaming pass for anchored ranges below the line limit", async () => {
		const { config } = createConfig()
		const realFile = "single-pass.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "first\nsecond\nthird")
		const env = new SurfaceAdapter(config)
		const readWindow = sinon.spy(env.workspace, "readTextFileWindow")

		await new ReadFileTool().processCall(
			{ paths: [realFile], start_line: 2, end_line: 2, include_anchors: true },
			env,
		)

		sinon.assert.calledOnce(readWindow)
	})

	it("invalidates a cached extracted read when content grows above the line limit", async () => {
		const { config } = createConfig()
		const realFile = "oversized.ipynb"
		const absolutePath = path.join(tmpDir, realFile)
		await fs.writeFile(absolutePath, "{}")
		const env = new SurfaceAdapter(config)
		const extractedRead = sinon.stub(env.workspace, "readRichFile")
		extractedRead.onFirstCall().resolves({ text: "small extracted content" })
		extractedRead.onSecondCall().resolves({
			text: Array.from({ length: MAX_ANCHORED_FILE_LINES + 1 }, () => "").join("\n"),
		})
		const tool = new ReadFileTool()

		await tool.processCall({ paths: [realFile] }, env)
		assert.equal(Object.keys((await config.context.task.get("fileHashes")) ?? {}).length, 1)

		await tool.processCall({ paths: [realFile], start_line: 1, end_line: 2 }, env)
		assert.deepEqual((await config.context.task.get("fileHashes")) ?? {}, {})
	})

	it("streams late ranges from oversized files without anchors or read caching", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "oversized.log"
		const lines = Array.from(
			{ length: MAX_ANCHORED_FILE_LINES + 1 },
			(_, index) => `record ${index + 1}: ${"x".repeat(410)}`,
		)
		const absolutePath = path.join(tmpDir, realFile)
		await fs.writeFile(absolutePath, "small\nfile")
		await handler.execute(config, makeBlock(realFile))
		await handler.execute(config, makeBlock(realFile, { start_line: 1, end_line: 2, include_anchors: true }))
		assert.equal(AnchorStateManager.isTracking(absolutePath, config.ulid), true)
		assert.equal(Object.keys((await config.context.task.get("fileHashes")) ?? {}).length, 2)

		await fs.writeFile(absolutePath, lines.join("\n"))

		const oversizedSelection = (await handler.execute(config, makeBlock(realFile, {
			start_line: 1,
			end_line: 200,
			include_anchors: true,
		}))) as string
		assert.ok(oversizedSelection.includes("exceeds the 51200-byte read limit"))
		assert.equal(AnchorStateManager.isTracking(absolutePath, config.ulid), false)
		assert.deepEqual((await config.context.task.get("fileHashes")) ?? {}, {})

		const params = {
			start_line: MAX_ANCHORED_FILE_LINES,
			end_line: MAX_ANCHORED_FILE_LINES + 1,
			include_anchors: true,
		}
		const first = (await handler.execute(config, makeBlock(realFile, params))) as string
		const repeated = (await handler.execute(config, makeBlock(realFile, params))) as string

		assert.ok(first.includes(`record ${MAX_ANCHORED_FILE_LINES}:`))
		assert.ok(first.includes(`record ${MAX_ANCHORED_FILE_LINES + 1}:`))
		assert.ok(first.includes(`[Lines: ${MAX_ANCHORED_FILE_LINES}-${MAX_ANCHORED_FILE_LINES + 1} of ${MAX_ANCHORED_FILE_LINES + 1}]`))
		assert.ok(first.includes("Hash anchoring unavailable"))
		assert.ok(first.includes("use execute_command"))
		assert.ok(!/^[A-Z][a-zA-Z]*§record/m.test(first))
		assert.ok(!first.includes("File Hash"))
		assert.ok(!repeated.includes("no changes have been made"))
		assert.equal(AnchorStateManager.isTracking(absolutePath, config.ulid), false)
		assert.deepEqual((await config.context.task.get("fileHashes")) ?? {}, {})
	})


	it("returns images without applying ranges, text limits, or text hashing", async () => {
		const { config, validator } = createConfig(true)
		const handler = new ReadFileToolHandler(validator)
		const realFile = "pixel.png"
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		)
		await fs.writeFile(path.join(tmpDir, realFile), png)

		const first = (await handler.execute(config, makeBlock(realFile, { start_line: 999 }))) as any[]
		const repeated = (await handler.execute(config, makeBlock(realFile))) as any[]
		assert.equal(first[1].type, "image")
		assert.equal(repeated[1].type, "image")
		assert.ok(!first[0].text.includes("no changes have been made"))
		assert.ok(!repeated[0].text.includes("no changes have been made"))

		await fs.writeFile(path.join(tmpDir, realFile), Buffer.concat([png, Buffer.from([0])]))
		const changed = (await handler.execute(config, makeBlock(realFile))) as any[]
		assert.equal(changed[1].type, "image")
		assert.notEqual(changed[1].source.data, repeated[1].source.data)
	})

	it("continues processing other files when one selected text is too large", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const largeFile = "multi-large.txt"
		const smallFile = "multi-small.txt"
		await fs.writeFile(path.join(tmpDir, largeFile), "x".repeat(50 * 1024 + 1))
		await fs.writeFile(path.join(tmpDir, smallFile), "small succeeds")

		const result = (await handler.execute(config, {
			type: "tool_use",
			name: DiracDefaultTool.FILE_READ,
			params: { paths: [largeFile, smallFile] },
		})) as string
		assert.ok(result.includes(`--- ${largeFile} ---`))
		assert.ok(result.includes("exceeds the 51200-byte read limit"))
		assert.ok(result.includes(`--- ${smallFile} ---`))
		assert.ok(result.includes("small succeeds"))
	})

	it("gives each card its own location when reading several files", async () => {
		const { config, validator } = createConfig()
		const uiConfig = { ...config, isSubagentExecution: false } as TaskConfig
		const handler = new ReadFileToolHandler(validator)
		const a = "multi-loc-a.md"
		const b = "multi-loc-b.md"
		await fs.writeFile(path.join(tmpDir, a), "alpha\n")
		await fs.writeFile(path.join(tmpDir, b), "beta\n")

		const created: Array<{ header: string; locations?: Array<{ path: string; line?: number }> }> = []
		sandbox.stub(SurfaceAdapter.prototype, "createCard").callsFake(async (params: any) => {
			created.push(params)
			return { finalize: async () => { }, setBody: async () => { }, update: async () => { } } as any
		})

		await handler.execute(uiConfig, {
			type: "tool_use",
			name: DiracDefaultTool.FILE_READ,
			params: { paths: [a, b] },
		})

		assert.equal(created.length, 2)
		assert.equal(created[0].locations?.[0]?.path, a)
		assert.equal(created[1].locations?.[0]?.path, b)
	})

	it("includes the requested start line in the card location", async () => {
		const { config, validator } = createConfig()
		const uiConfig = { ...config, isSubagentExecution: false } as TaskConfig
		const handler = new ReadFileToolHandler(validator)
		const realFile = "multi-loc-range.md"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo\nthree\n")

		const created: Array<{ locations?: Array<{ path: string; line?: number }> }> = []
		sandbox.stub(SurfaceAdapter.prototype, "createCard").callsFake(async (params: any) => {
			created.push(params)
			return { finalize: async () => { }, setBody: async () => { }, update: async () => { } } as any
		})

		await handler.execute(uiConfig, makeBlock(realFile, { start_line: 2, end_line: 3 }))

		assert.equal(created.length, 1)
		assert.equal(created[0].locations?.[0]?.path, realFile)
		assert.equal(created[0].locations?.[0]?.line, 2)
	})
})
