import "should"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
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
				"sourceAst",
				"anchors",
				"diagnostics",
				"editor",
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
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))
			const handle = await adapter.ui.createCard({ header: "Test" })
			handle.id.should.equal("card-1")
			sinon.assert.calledOnce(config.taskMessenger.createCard)
			sinon.assert.calledWithMatch(config.taskMessenger.createCard, { toolName: "test-tool" })
		})

		it("auto-approves approval cards without waiting for protocol interaction", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
			}
			config.yoloModeToggled = true
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const handle = await adapter.ui.createCard({
				header: "Permission",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
			})
			const result = await handle.waitForInteraction()

			sinon.assert.calledWithMatch(config.taskMessenger.createCard, {
				status: CardStatus.RUNNING,
				requireApproval: false,
				actions: undefined,
			})
			sinon.assert.notCalled(fakeHandle.waitForInteraction)
			result.action.should.equal(DiracAskResponse.APPROVE)
			result.response.should.equal(DiracAskResponse.APPROVE)
			result.value!.should.equal(DiracAskResponse.APPROVE)
		})

		it("requires a real user response for manual interactions even when every auto-approval path is enabled", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({
					action: DiracAskResponse.REJECT,
					response: DiracAskResponse.REJECT,
				}),
			}
			const decide = sinon.stub().resolves({ decision: "approve", reason: "Allowed by policy." })
			config.yoloModeToggled = true
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)
			config.permissionDecisionBinding = { service: { decide }, configurationRevision: 1 }
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const card = await adapter.ui.createManualInteractionCard({
				header: "Contained Task approval",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			const result = await card.waitForInteraction()

			sinon.assert.notCalled(decide)
			sinon.assert.calledWithMatch(config.taskMessenger.createCard, {
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
			})
			sinon.assert.calledOnce(fakeHandle.waitForInteraction)
			result.response.should.equal(DiracAskResponse.REJECT)
		})

		it("uses the primary custom action for an auto-approved card", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub(),
			}
			config.yoloModeToggled = true
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const handle = await adapter.ui.createCard({
				header: "New Task",
				requireApproval: true,
				requireFeedback: true,
				actions: [{ label: "Approve New Task", value: "new_task", primary: true }],
			})
			const result = await handle.waitForInteraction()

			sinon.assert.calledWithMatch(config.taskMessenger.createCard, {
				requireApproval: false,
				requireFeedback: false,
				actions: undefined,
			})
			sinon.assert.notCalled(fakeHandle.waitForInteraction)
			result.action.should.equal("new_task")
			result.response.should.equal(DiracAskResponse.APPROVE)
			result.value!.should.equal("new_task")
		})

		it("publishes a completed audit card for a permission-agent approval", async () => {
			const auditCardHandle = {
				id: "approval-card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub(),
			}
			const decide = sinon.stub().resolves({ decision: "approve", reason: "Allowed by policy." })
			config.permissionDecisionBinding = { service: { decide }, configurationRevision: 1 }
			config.toolUse = { name: "write_to_file", params: { path: "src/index.ts", content: "export {}\n" } }
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(auditCardHandle))

			const handle = await adapter.ui.createCard({
				header: "Permission",
				requireApproval: true,
				permissionRequestKind: "tool",
				rawInput: { path: "src/index.ts" },
			})
			const result = await handle.waitForInteraction()

			sinon.assert.calledWithMatch(decide, {
				toolCall: {
					name: "write_to_file",
					arguments: { path: "src/index.ts", content: "export {}\n" },
				},
				permission: { header: "Permission" },
				runtime: { cwd: "/test", mode: "act", isSubagent: false },
			})
			sinon.assert.calledOnceWithExactly(config.taskMessenger.createCard, {
				header: "Auto Approved · Permission",
				toolName: "permission_approval",
				icon: DiracIcon.PERMISSION_APPROVAL,
				status: CardStatus.SUCCESS,
				renderType: "markdown",
				body: "**Result:** Auto Approved by permission agent\n\n**Reason:** Allowed by policy.",
				rawInput: { tool: "write_to_file" },
				rawOutput: { decision: "approve", reason: "Allowed by policy.", approvedTool: "write_to_file" },
				locations: undefined,
				collapsed: true,
			})
			sinon.assert.notCalled(auditCardHandle.waitForInteraction)
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("uses the displayed card path for a Utility escalation", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
			}
			config.permissionDecisionBinding = {
				service: { decide: sinon.stub().resolves({ decision: "escalate", reason: "User choice." }) },
				configurationRevision: 1,
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const handle = await adapter.ui.createCard({
				header: "Permission",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			await handle.waitForInteraction()

			sinon.assert.calledWithExactly(config.taskMessenger.createCard, {
				header: "Permission",
				toolName: "test-tool",
				locations: undefined,
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
				isAutoApproved: sinon.match.func,
			})
			sinon.assert.calledOnce(fakeHandle.waitForInteraction)
		})

		it("uses the displayed card path when Utility permission handling is disabled", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const handle = await adapter.ui.createCard({
				header: "Permission",
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			await handle.waitForInteraction()

			sinon.assert.calledOnce(config.taskMessenger.createCard)
			sinon.assert.calledOnce(fakeHandle.waitForInteraction)
		})

		it("preserves legacy YOLO approval when Utility permission handling is disabled", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
			}
			config.yoloModeToggled = true
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const result = await (
				await adapter.ui.createCard({
					header: "Legacy permission",
					requireApproval: true,
					permissionRequestKind: "manual_tool",
				})
			).waitForInteraction()

			sinon.assert.calledWithMatch(config.taskMessenger.createCard, { requireApproval: false })
			sinon.assert.notCalled(fakeHandle.waitForInteraction)
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("auto-approves a manual-only tool permission in an unrestricted mode", async () => {
			config.yoloModeToggled = true
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)
			config.permissionDecisionBinding = {
				service: { decide: sinon.stub().resolves({ decision: "escalate", reason: "User decision required." }) },
				configurationRevision: 1,
			}

			const result = await (
				await adapter.ui.createCard({
					header: "External write",
					requireApproval: true,
					permissionRequestKind: "manual_tool",
				})
			).waitForInteraction()

			sinon.assert.notCalled(config.permissionDecisionBinding.service.decide)
			sinon.assert.notCalled(config.taskMessenger.createCard)
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("resolves unrestricted auto-approval before Utility", async () => {
			const decide = sinon.stub().resolves({ decision: "escalate", reason: "Escalate." })
			config.permissionDecisionBinding = { service: { decide }, configurationRevision: 1 }
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)

			const handle = await adapter.ui.createCard({
				header: "Permission",
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			const result = await handle.waitForInteraction()

			sinon.assert.notCalled(decide)
			sinon.assert.notCalled(config.taskMessenger.createCard)
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("routes subagent permissions through the permission agent and publishes their approval", async () => {
			const auditCardHandle = {
				id: "approval-card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub(),
			}
			const decide = sinon.stub().resolves({ decision: "approve", reason: "Allowed." })
			config.permissionDecisionBinding = { service: { decide }, configurationRevision: 1 }
			config.isSubagentExecution = true
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(auditCardHandle))

			const result = await (
				await adapter.ui.createCard({
					header: "Permission",
					requireApproval: true,
					permissionRequestKind: "tool",
				})
			).waitForInteraction()

			sinon.assert.calledWithMatch(decide, { runtime: { cwd: "/test", mode: "act", isSubagent: true } })
			sinon.assert.calledWithMatch(config.taskMessenger.createCard, {
				header: "Auto Approved · Permission",
				toolName: "permission_approval",
				status: CardStatus.SUCCESS,
			})
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("discards an in-flight Utility approval after its configuration changes", async () => {
			let resolveDecision!: (decision: { decision: "approve"; reason: string }) => void
			const decide = sinon.stub().returns(
				new Promise((resolve) => {
					resolveDecision = resolve
				}),
			)
			let binding: any = { service: { decide }, configurationRevision: 1 }
			Object.defineProperty(config, "permissionDecisionBinding", {
				configurable: true,
				get: () => binding,
			})
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const pendingHandle = adapter.ui.createCard({
				header: "Permission",
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			await Promise.resolve()
			binding = undefined
			resolveDecision({ decision: "approve", reason: "Stale approval." })
			const result = await (await pendingHandle).waitForInteraction()

			sinon.assert.calledOnce(config.taskMessenger.createCard)
			result.action.should.equal(DiracAskResponse.REJECT)
		})

		it("honors auto-approval enabled during an in-flight Utility decision", async () => {
			let resolveDecision!: (decision: { decision: "escalate"; reason: string }) => void
			const decide = sinon.stub().returns(
				new Promise((resolve) => {
					resolveDecision = resolve
				}),
			)
			config.permissionDecisionBinding = { service: { decide }, configurationRevision: 1 }

			const pendingHandle = adapter.ui.createCard({
				header: "Permission",
				requireApproval: true,
				permissionRequestKind: "tool",
			})
			await Promise.resolve()
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)
			resolveDecision({ decision: "escalate", reason: "Superseded escalation." })
			const result = await (await pendingHandle).waitForInteraction()

			sinon.assert.notCalled(config.taskMessenger.createCard)
			result.action.should.equal(DiracAskResponse.APPROVE)
		})

		it("never routes an unmarked control-flow approval through Utility or Auto-Approve All", async () => {
			const decide = sinon.stub().resolves({ decision: "approve", reason: "Must not be called." })
			const readBinding = sinon.stub().returns({ service: { decide }, configurationRevision: 1 })
			Object.defineProperty(config, "permissionDecisionBinding", { configurable: true, get: readBinding })
			config.autoApprover.isUnrestrictedAutoApprove.returns(true)
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			const handle = await adapter.ui.createCard({ header: "New Task", requireApproval: true })
			await handle.waitForInteraction()

			sinon.assert.notCalled(readBinding)
			sinon.assert.notCalled(decide)
			sinon.assert.calledWithMatch(config.taskMessenger.createCard, { requireApproval: true })
			sinon.assert.calledOnce(fakeHandle.waitForInteraction)
		})

		it("upsertText delegates to taskMessenger.upsertText", async () => {
			config.taskMessenger.upsertText = sinon.stub().resolves()
			await adapter.ui.upsertText("hello", true, "assistant")
			sinon.assert.calledWith(config.taskMessenger.upsertText, "hello", true, undefined, undefined, "assistant", undefined)
		})

		it("prefixes subagent text with its display name", async () => {
			config.agentIdentity = { id: 2, name: "Feynman" }
			config.taskMessenger.upsertText = sinon.stub().resolves()
			adapter = new SurfaceAdapter(config, "test_tool")

			await adapter.ui.upsertText("Working on it.", false, "assistant")

			sinon.assert.calledWith(
				config.taskMessenger.upsertText,
				"**Feynman:** Working on it.",
				false,
				undefined,
				undefined,
				"assistant",
				{ id: 2, name: "Feynman" },
			)
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
				waitForInteraction: sinon.stub().resolves({
					action: DiracAskResponse.APPROVE,
					value: "v",
					text: "t",
					images: ["img"],
					files: ["f"],
					userEdits: {},
				}),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))
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
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))
			const result = await adapter.interaction.askPermission("May I?")
			result.approved.should.equal(false)
		})

		// ToolExecutorCoordinator throws "left nonterminal card(s)" on any card still
		// WAITING_FOR_INPUT when the tool returns. Custom tools call askPermission and return a
		// string; none of them knows about that contract, so the trait has to close the card.
		const finalizeCases = [
			{ action: DiracAskResponse.APPROVE, expected: CardStatus.SUCCESS },
			{ action: DiracAskResponse.REJECT, expected: CardStatus.CANCELLED },
			{ action: DiracAskResponse.MESSAGE, expected: CardStatus.SKIPPED },
		]
		for (const { action, expected } of finalizeCases) {
			it(`askPermission finalizes the card as ${expected} after ${action}`, async () => {
				const fakeHandle = {
					id: "card-1",
					update: sinon.stub().resolves(),
					appendBody: sinon.stub().resolves(),
					finalize: sinon.stub().resolves(),
					waitForInteraction: sinon.stub().resolves({ action }),
				}
				config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

				await adapter.interaction.askPermission("May I?")

				sinon.assert.calledOnceWithExactly(fakeHandle.finalize, expected, undefined)
			})
		}

		it("attaches an effect preview diff and raw input to permission cards", async () => {
			const fakeHandle = {
				id: "card-1",
				update: sinon.stub().resolves(),
				appendBody: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
			}
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))

			await adapter.interaction.askPermission("May I?", {
				diffs: [{ path: "new.ts", oldText: "", newText: "export {}\n" }],
				rawInput: { path: "new.ts", content: "export {}\n" },
			})

			sinon.assert.calledWithMatch(config.taskMessenger.createCard, {
				header: "Permission Request",
				renderType: "diff",
				diffs: [{ path: "new.ts", oldText: "", newText: "export {}\n" }],
				rawInput: { path: "new.ts", content: "export {}\n" },
			})
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
			config.callbacks.executeCommandTool = sinon
				.stub()
				.resolves([true, "output", { completed: true, exitCode: 2, signal: null, logFilePath: "/tmp/output.log" }])
			const result = await adapter.system.executeCommand("ls", { timeout: 5000 })
			expect(result).to.deep.equal({
				userRejected: true,
				output: "output",
				completed: true,
				exitCode: 2,
				signal: null,
				logFilePath: "/tmp/output.log",
			})
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
		it("readText delegates to the diff view provider's authoritative transport", async () => {
			config.services.diffViewProvider.readText.resolves("content")
			const result = await adapter.editor.readText("/path/to/file")
			result.should.equal("content")
			sinon.assert.calledWith(config.services.diffViewProvider.readText, "/path/to/file")
		})

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
			config.taskMessenger.createCard = sinon.stub().resolves(attachCardState(fakeHandle))
			await adapter.createCard({ header: "Test 1" })
			await adapter.createCard({ header: "Test 2" })
			adapter.getCreatedCards().should.have.length(2)
		})
	})
})

function attachCardState<T extends { id: string }>(handle: T): T & { getCard: () => any } {
	const card = {
		id: handle.id,
		header: "Test card",
		status: CardStatus.RUNNING,
		renderType: "text" as const,
	}
	return Object.assign(handle, { getCard: () => card })
}

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
		providerId: "test",
		model: { id: "test-model", info: { supportsImages: false, supportsPromptCache: false } },
		supportsNativeWebSearch: false,
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
				readText: sinon.stub(),
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
		},
		autoApprovalSettings: {},
		autoApprover: { isUnrestrictedAutoApprove: sinon.stub().returns(false) },
		browserSettings: {},
		callbacks: {
			assertMutationAuthorized: sinon.stub(),
			withMutationAuthorization: async (_toolName: string, mutation: () => Promise<unknown>) => await mutation(),
			saveCheckpoint: sinon.stub(),
			executeCommandTool: sinon.stub(),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub(),
			shouldAutoApproveTool: sinon.stub(),
			shouldAutoApproveToolWithPath: sinon.stub(),
			resolveToolPathPermission: sinon.stub().resolves("auto_approve"),
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
