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
	constructor(_validator: any) { }
	async execute(config: TaskConfig, block: any) {
		const env = new SurfaceAdapter(config)
		return this.tool.processCall(block.params, env)
	}
}

function createConfig(supportsImages = false) {
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
			getModel: () => ({ id: "test-model", info: { supportsImages } }),
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
	})

	afterEach(async () => {
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
		assert.ok(repeatedAnchoredResult.includes("no changes have been made to the file since your last read"))
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

		const endOnly = (await handler.execute(config, makeBlock(realFile, { end_line: 2 }))) as string
		assert.ok(endOnly.includes("one\ntwo"))
		assert.ok(!endOnly.includes("three"))

		const pastEof = (await handler.execute(config, makeBlock(realFile, { start_line: 3, end_line: 99 }))) as string
		assert.ok(pastEof.includes("three\nfour"))
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

	it("caches an explicit range that covers the whole file", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		const realFile = "explicit-complete-range.txt"
		await fs.writeFile(path.join(tmpDir, realFile), "one\ntwo")

		const ranged = (await handler.execute(config, makeBlock(realFile, { start_line: 1, end_line: 99 }))) as string
		assert.ok(ranged.includes("one\ntwo"))

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
		assert.ok(/^[A-Z][a-zA-Z]*§second$/m.test(result))
		assert.ok(!/§first$/m.test(result))
		assert.ok(!/§third$/m.test(result))
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


})
