import "should"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { expect } from "chai"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { SurfaceAdapter } from "../SurfaceAdapter"

// Characterization tests for SurfaceAdapter — verifies that each trait method
// correctly delegates to the underlying config service/callback.
// SurfaceAdapter is a pure wiring class, so tests focus on delegation behavior.
describe("SurfaceAdapter", () => {
	let config: any
	let adapter: SurfaceAdapter

	beforeEach(() => {
		config = createMockConfig()
		adapter = new SurfaceAdapter(config, "test-tool")
	})

	afterEach(() => sinon.restore())

	describe("constructor", () => {
		it("stores config and toolName", () => {
			adapter.config.should.equal(config)
			adapter.toolName.should.equal("test-tool")
		})

		it("defaults toolName to empty string", () => {
			const a = new SurfaceAdapter(config)
			a.toolName.should.equal("")
		})

		it("exposes all required traits", () => {
			const traits = [
				"ui",
				"interaction",
				"system",
				"orchestration",
				"telemetry",
				"workspace",
				"ast",
				"diagnostics",
				"editor",
				"symbol",
				"browser",
				"skills",
				"logging",
				"context",
			]
			for (const t of traits) {
				expect((adapter as any)[t]).to.not.be.undefined
			}
		})
	})

	describe("logging trait", () => {
		it("delegates error to Logger.error", () => {
			const stub = sinon.stub(Logger, "error")
			adapter.logging.error("test-msg", 1, 2)
			sinon.assert.calledWith(stub, "test-msg", 1, 2)
			stub.restore()
		})

		it("delegates warn to Logger.warn", () => {
			const stub = sinon.stub(Logger, "warn")
			adapter.logging.warn("test-msg")
			sinon.assert.calledWith(stub, "test-msg")
			stub.restore()
		})

		it("delegates info to Logger.info", () => {
			const stub = sinon.stub(Logger, "info")
			adapter.logging.info("test-msg")
			sinon.assert.calledWith(stub, "test-msg")
			stub.restore()
		})

		it("delegates debug to Logger.debug", () => {
			const stub = sinon.stub(Logger, "debug")
			adapter.logging.debug("test-msg")
			sinon.assert.calledWith(stub, "test-msg")
			stub.restore()
		})
	})

	describe("ui trait", () => {
		it("createCard delegates to taskMessenger.createCard and wraps in CardHandle", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: "approve" }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(fakeHandle)
			const handle = await adapter.ui.createCard({ header: "Test" })
			handle.id.should.equal("card-1")
			sinon.assert.calledOnce(config.taskMessenger.createCard)
		})

		it("upsertText delegates to taskMessenger.upsertText", async () => {
			config.taskMessenger.upsertText = sinon.stub().resolves()
			await adapter.ui.upsertText("hello", true, "assistant")
			sinon.assert.calledWith(config.taskMessenger.upsertText, "hello", true, undefined, undefined, "assistant")
		})

		it("streamText delegates to taskMessenger.streamText", async () => {
			config.taskMessenger.streamText = sinon.stub().resolves({ write: sinon.stub(), close: sinon.stub() })
			await adapter.ui.streamText("markdown")
			sinon.assert.calledWith(config.taskMessenger.streamText, "markdown")
		})
	})

	describe("interaction trait", () => {
		it("askPermission creates a card and waits for interaction", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon
					.stub()
					.resolves({
						action: DiracAskResponse.APPROVE,
						value: "v",
						text: "t",
						images: ["img"],
						files: ["f"],
						userEdits: {},
					}),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(fakeHandle)
			const result = await adapter.interaction.askPermission("May I?")
			result.approved.should.equal(true)
			result.action.should.equal(DiracAskResponse.APPROVE)
			result.value!.should.equal("v")
			result.text!.should.equal("t")
			result.images!.should.deepEqual(["img"])
			result.files!.should.deepEqual(["f"])
		})

		it("askPermission returns rejected when action is not APPROVE", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(fakeHandle)
			const result = await adapter.interaction.askPermission("May I?")
			result.approved.should.equal(false)
		})
	})

	describe("browser trait", () => {
		it("launch applies browser settings and navigates", async () => {
			const session = { launchBrowser: sinon.stub().resolves(), navigateToUrl: sinon.stub().resolves("ok") }
			config.callbacks.applyLatestBrowserSettings = sinon.stub().resolves(session)
			const result = await adapter.browser.launch("http://example.com")
			sinon.assert.calledOnce(session.launchBrowser)
			sinon.assert.calledWith(session.navigateToUrl, "http://example.com")
			result.should.equal("ok")
		})

		it("click delegates to browserSession.click", async () => {
			config.services.browserSession.click = sinon.stub().resolves("clicked")
			await adapter.browser.click("100,200")
			sinon.assert.calledWith(config.services.browserSession.click, "100,200")
		})

		it("type delegates to browserSession.type", async () => {
			config.services.browserSession.type = sinon.stub().resolves()
			await adapter.browser.type("hello")
			sinon.assert.calledWith(config.services.browserSession.type, "hello")
		})

		it("scroll up delegates to scrollUp", async () => {
			config.services.browserSession.scrollUp = sinon.stub().resolves()
			await adapter.browser.scroll("up")
			sinon.assert.calledOnce(config.services.browserSession.scrollUp)
		})

		it("scroll down delegates to scrollDown", async () => {
			config.services.browserSession.scrollDown = sinon.stub().resolves()
			await adapter.browser.scroll("down")
			sinon.assert.calledOnce(config.services.browserSession.scrollDown)
		})

		it("close delegates to closeBrowser", async () => {
			config.services.browserSession.closeBrowser = sinon.stub().resolves()
			await adapter.browser.close()
			sinon.assert.calledOnce(config.services.browserSession.closeBrowser)
		})
	})

	describe("system trait", () => {
		it("executeCommand delegates to callbacks.executeCommandTool with suppress flags", async () => {
			config.callbacks.executeCommandTool = sinon.stub().resolves([true, "output"])
			const [success, output] = (await adapter.system.executeCommand("ls", { timeout: 5000, onOutput: () => {} })) as [
				boolean,
				any,
			]
			success.should.equal(true)
			output.should.equal("output")
			const callArgs = config.callbacks.executeCommandTool.getCall(0).args
			callArgs[0].should.equal("ls")
			callArgs[1].should.equal(5000)
			callArgs[2].suppressUserInteraction.should.equal(true)
			callArgs[2].useBackgroundExecution.should.equal(true)
		})

		it("searchFiles delegates to regexSearchFiles with config params", async () => {
			const regexStub = sinon.stub().resolves({ results: [], truncated: false })
			const module = require("@services/ripgrep")
			sinon.stub(module, "regexSearchFiles").callsFake(regexStub)
			await adapter.system.searchFiles("src", "TODO", { filePattern: "*.ts", contextLines: 3 })
			sinon.assert.calledOnce(regexStub)
			const args = regexStub.getCall(0).args
			args[1].should.equal("src")
			args[2].should.equal("TODO")
			args[3].should.equal("*.ts")
		})

		it("getSystemInfo returns OS, version, host, and provider info", async () => {
			stubHostProvider({ getHostVersion: sinon.stub().resolves({ platform: "test", version: "1.0" }) })
			const info = await adapter.system.getSystemInfo()
			info.should.have.property("operatingSystem")
			info.should.have.property("diracVersion")
			info.should.have.property("hostInfo")
			info.should.have.property("systemInfo")
			info.should.have.property("providerAndModel")
		})

		it("openUrl delegates to openUrlInBrowser", async () => {
			const stub = sinon.stub().resolves()
			const module = require("@utils/github-url-utils")
			sinon.stub(module, "openUrlInBrowser").callsFake(stub)
			await adapter.system.openUrl("https://example.com")
			sinon.assert.calledWith(stub, "https://example.com")
		})
	})

	describe("telemetry trait", () => {
		it("captureCustomMetadata merges into customMetadata", () => {
			adapter.telemetry.captureCustomMetadata({ a: 1 })
			adapter.telemetry.captureCustomMetadata({ b: 2 })
			const meta = adapter.getCustomMetadata()
			meta.should.deepEqual({ a: 1, b: 2 })
		})
	})

	describe("workspace trait", () => {
		it("readFile delegates to fs.readFile", async () => {
			const fs = require("fs/promises")
			sinon.stub(fs, "readFile").resolves("content")
			const result = await adapter.workspace.readFile("/path/to/file")
			result.should.equal("content")
		})

		it("getFileInfo returns exists:true for valid path", async () => {
			const fs = require("fs/promises")
			sinon.stub(fs, "stat").resolves({ size: 100, isFile: () => true })
			const info = await adapter.workspace.getFileInfo("/path")
			info.exists.should.equal(true)
			info.size.should.equal(100)
			info.isFile.should.equal(true)
		})

		it("getFileInfo returns exists:false for missing path", async () => {
			const fs = require("fs/promises")
			sinon.stub(fs, "stat").rejects(new Error("ENOENT"))
			const info = await adapter.workspace.getFileInfo("/missing")
			info.exists.should.equal(false)
		})

		it("writeFile delegates to fs.writeFile", async () => {
			const fs = require("fs/promises")
			const stub = sinon.stub(fs, "writeFile").resolves()
			await adapter.workspace.writeFile("/path", "content")
			sinon.assert.calledWith(stub, "/path", "content", "utf8")
		})

		it("listFiles delegates to listFiles service", async () => {
			const stub = sinon.stub().resolves({ items: [], truncated: false })
			const module = require("@services/glob/list-files")
			sinon.stub(module, "listFiles").callsFake(stub)
			await adapter.workspace.listFiles("/path", true, 200)
			sinon.assert.calledWith(stub, "/path", true, 200)
		})

		it("saveOpenDocumentIfDirty delegates to HostProvider", async () => {
			stubHostProvider({ saveOpenDocumentIfDirty: sinon.stub().resolves() })
			await adapter.workspace.saveOpenDocumentIfDirty({ filePath: "/path" })
		})
	})

	describe("editor trait", () => {
		it("showReview delegates to diffViewProvider.showReview", async () => {
			config.services.diffViewProvider.showReview = sinon.stub().resolves()
			await adapter.editor.showReview([{ path: "file1.ts", content: "" }] as any)
			sinon.assert.calledOnce(config.services.diffViewProvider.showReview)
		})

		it("saveChanges maps result to SaveResult format", async () => {
			config.services.diffViewProvider.saveChanges = sinon
				.stub()
				.resolves({ finalContent: "new", userEdits: true, autoFormattingEdits: false })
			const result = await adapter.editor.saveChanges({})
			result.content.should.equal("new")
			result.userEdits.should.equal(true)
			result.autoFormatting.should.equal(false)
		})

		it("saveChanges defaults to empty string when finalContent is falsy", async () => {
			config.services.diffViewProvider.saveChanges = sinon.stub().resolves({})
			const result = await adapter.editor.saveChanges({})
			result.content.should.equal("")
			result.userEdits.should.equal(false)
		})

		it("applyAndSaveBatchSilently maps results to Map of SaveResult", async () => {
			const rawResults = new Map([["a.ts", { finalContent: "x", userEdits: false, autoFormattingEdits: true }]])
			config.services.diffViewProvider.applyAndSaveBatchSilently = sinon.stub().resolves(rawResults)
			const results = await adapter.editor.applyAndSaveBatchSilently([{ path: "a.ts", content: "x" }] as any)
			results.get("a.ts")!.content.should.equal("x")
			results.get("a.ts")!.userEdits.should.equal(false)
			results.get("a.ts")!.autoFormatting.should.equal(true)
		})
	})

	describe("symbol trait", () => {
		it("getDefinitions delegates to SymbolIndexService", async () => {
			const svc = require("@/services/symbol-index/SymbolIndexService").SymbolIndexService
			sinon.stub(svc, "getInstance").returns({ getDefinitions: sinon.stub().resolves(["loc1"]) })
			const result = await adapter.symbol.getDefinitions({ name: "foo" } as any)
			result.should.deepEqual(["loc1"])
		})
	})

	describe("orchestration trait", () => {
		it("switchToActMode delegates to callbacks.switchToActMode", async () => {
			config.callbacks.switchToActMode = sinon.stub().resolves(true)
			await adapter.orchestration.switchToActMode()
			sinon.assert.calledOnce(config.callbacks.switchToActMode)
		})

		it("getHistory delegates to messageState.getDiracMessages", () => {
			config.messageState.getDiracMessages = sinon.stub().returns(["msg1"])
			const result = adapter.orchestration.getHistory()
			sinon.assert.calledOnce(config.messageState.getDiracMessages)
			result.should.deepEqual(["msg1"])
		})

		it("setTruncationRange sets conversationHistoryDeletedRange", () => {
			adapter.orchestration.setTruncationRange({ start: 0, end: 10 } as any)
			config.taskState.conversationHistoryDeletedRange.should.deepEqual({ start: 0, end: 10 })
		})

		it("getTaskState returns value from taskState", () => {
			config.taskState.someKey = "someValue"
			adapter.orchestration.getTaskState("someKey" as any).should.equal("someValue")
		})

		it("setTaskState sets value on taskState", () => {
			adapter.orchestration.setTaskState("newKey" as any, "newValue" as any)
			config.taskState.newKey.should.equal("newValue")
		})
	})

	describe("createCard", () => {
		it("tracks created cards", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: "approve" }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(fakeHandle)
			await adapter.createCard({ header: "Test 1" })
			await adapter.createCard({ header: "Test 2" })
			adapter.getCreatedCards().should.have.length(2)
		})
	})
})

// Stubs HostProvider static getters with the given workspace/env methods.
function stubHostProvider(workspaceMethods: any) {
	const hostModule = require("@/hosts/host-provider")
	const fakeInstance = {
		hostBridge: {
			workspaceClient: workspaceMethods,
			envClient: { getHostVersion: sinon.stub().resolves({ platform: "test", version: "1.0" }) },
		},
	}
	sinon.stub(hostModule.HostProvider, "get").returns(fakeInstance)
}

// Creates a minimal mock TaskConfig with stubbed services and callbacks.
function createMockConfig(): any {
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/test",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		backgroundEditEnabled: false,
		taskState: { conversationHistoryDeletedRange: undefined },
		messageState: { getDiracMessages: () => [], getApiConversationHistory: () => [] },
		api: { getModel: () => ({ id: "test-model", info: { supportsImages: false, supportsPromptCache: false } }) },
		services: {
			browserSession: {
				launchBrowser: sinon.stub(),
				navigateToUrl: sinon.stub(),
				click: sinon.stub(),
				type: sinon.stub(),
				scrollUp: sinon.stub(),
				scrollDown: sinon.stub(),
				closeBrowser: sinon.stub(),
			},
			urlContentFetcher: {},
			diffViewProvider: {
				showReview: sinon.stub(),
				hideReview: sinon.stub(),
				open: sinon.stub(),
				update: sinon.stub(),
				saveChanges: sinon.stub(),
				applyAndSaveSilently: sinon.stub(),
				applyAndSaveBatchSilently: sinon.stub(),
				revertChanges: sinon.stub(),
				reset: sinon.stub(),
				scrollToFirstDiff: sinon.stub(),
				undoUserEdits: sinon.stub(),
				format: sinon.stub(),
			},
			fileContextTracker: {},
			diracIgnoreController: {},
			commandPermissionController: {},
			contextManager: { getNextTruncationRange: sinon.stub() },
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getWorkspaceStateKey: () => undefined,
				getApiConfiguration: () => ({ planModeApiProvider: "test", actModeApiProvider: "test" }),
			},
		},
		autoApprovalSettings: {},
		autoApprover: {},
		browserSettings: {},
		callbacks: {
			saveCheckpoint: sinon.stub(),
			executeCommandTool: sinon.stub(),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub(),
			shouldAutoApproveTool: sinon.stub(),
			shouldAutoApproveToolWithPath: sinon.stub(),
			postStateToWebview: sinon.stub(),
			cancelTask: sinon.stub(),
			getDiracMessages: sinon.stub(),
			updateDiracMessage: sinon.stub(),
			applyLatestBrowserSettings: sinon.stub(),
			switchToActMode: sinon.stub(),
			setActiveHookExecution: sinon.stub(),
			clearActiveHookExecution: sinon.stub(),
			getActiveHookExecution: sinon.stub(),
			runUserPromptSubmitHook: sinon.stub(),
			resetTransientState: sinon.stub(),
		},
		coordinator: {},
		taskMessenger: { createCard: sinon.stub(), upsertText: sinon.stub(), streamText: sinon.stub() },
		context: {},
	}
}
