import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { AutoApprove } from "../../autoApprove"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { ExecuteCommandTool } from "../execute_command/ExecuteCommandTool"

function createMocks() {
	const diracIgnoreController = {
		validateCommand: sinon.stub().returns(undefined),
	}
	const commandPermissionController = {
		validateCommand: sinon.stub().returns({ allowed: true, reason: "no_config" }),
		validateTool: sinon.stub().returns({ allowed: true, reason: "no_config" }),
	}
	const autoApprover = {
		shouldAutoApproveTool: sinon.stub().returns(true),
		isCommandAutoApproved: sinon.stub().returns(true),
		isUnrestrictedAutoApprove: sinon.stub().returns(false),
	}
	const workspaceManager = {}
	const isMultiRootEnabled = false

	const tool = new ExecuteCommandTool(
		diracIgnoreController,
		commandPermissionController,
		autoApprover,
		workspaceManager,
		isMultiRootEnabled,
	)

	const mockCard = {
		update: sinon.stub().resolves(),
		appendBody: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: "approve" }),
	}

	const callbacks = {
		createCard: sinon.stub().resolves(mockCard),
		executeCommand: sinon.stub().resolves({ userRejected: false, output: "ok", exitCode: 0, completed: true }),
	}

	const env = {
		ui: {
			createCard: callbacks.createCard,
			upsertText: sinon.stub().resolves(),
		},
		interaction: {
			askPermission: sinon.stub().resolves({ approved: true }),
		},
		system: {
			executeCommand: callbacks.executeCommand,
		},
		config: { cwd: "/test", isSubagentExecution: false },
		context: {
			task: { get: sinon.stub(), set: sinon.stub() },
			workspace: { get: sinon.stub(), set: sinon.stub() },
			global: { get: sinon.stub(), set: sinon.stub() },
		},
		telemetry: { captureCustomMetadata: sinon.stub() },
	}

	return { tool, callbacks, env, diracIgnoreController, commandPermissionController, autoApprover, mockCard }
}

describe("ExecuteCommandTool", () => {
	it("blocks path arguments exceeding 255 bytes in processCall()", async () => {
		const { tool, env } = createMocks()
		const longPath = "/tmp/" + "a".repeat(300)

		await assert.rejects(() => tool.processCall({ commands: [`cat ${longPath}`] }, env as any), {
			message: /Path argument exceeds maximum allowed length/,
		})
	})

	it("allows normal-length path arguments in processCall()", async () => {
		const { tool, env } = createMocks()
		const normalPath = "/tmp/test.txt"

		await tool.processCall({ commands: [`cat ${normalPath}`] }, env as any)
		assert.ok((env.system.executeCommand as sinon.SinonStub).calledOnce)
	})

	it("blocks commands ignored by diracignore in processCall()", async () => {
		const { tool, env, diracIgnoreController } = createMocks()
		diracIgnoreController.validateCommand.returns("File is ignored")

		await assert.rejects(() => tool.processCall({ commands: ["cat ignored.txt"] }, env as any), {
			message: "Diracignore error: File is ignored",
		})
	})

	it("requires approval for unsafe commands", async () => {
		const { tool, env, autoApprover, commandPermissionController, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)
		// isSafeCommand will return false for commands with redirection
		const args = { commands: ["ls > out.txt"] }

		await tool.processCall(args, env as any)

		assert.ok(mockCard.waitForInteraction.calledOnce)
		assert.equal((env.ui.createCard as sinon.SinonStub).firstCall.args[0].permissionRequestKind, undefined)
		sinon.assert.calledOnce(commandPermissionController.validateCommand)
		sinon.assert.notCalled(commandPermissionController.validateTool)
	})

	it("preserves unrestricted command approval before legacy restrictions", async () => {
		const { tool, env, commandPermissionController, autoApprover, mockCard } = createMocks()
		autoApprover.isUnrestrictedAutoApprove.returns(true)
		commandPermissionController.validateCommand.returns({ allowed: false, reason: "denied" })

		await tool.processCall({ commands: ["curl https://example.com"] }, env as any)

		sinon.assert.notCalled(commandPermissionController.validateCommand)
		sinon.assert.notCalled(commandPermissionController.validateTool)
		sinon.assert.notCalled(mockCard.waitForInteraction)
		sinon.assert.calledOnce(env.system.executeCommand as sinon.SinonStub)
	})

	it("preserves non-interactive subagent denial when Utility handling is disabled", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		env.config.isSubagentExecution = true
		autoApprover.isCommandAutoApproved.returns(false)

		const result = await tool.processCall({ commands: ["curl https://example.com"] }, env as any)

		assert.equal(result, "The user denied this operation.")
		sinon.assert.notCalled(mockCard.waitForInteraction)
		sinon.assert.notCalled(env.system.executeCommand as sinon.SinonStub)
	})

	it("does not let Utility bypass a deterministic command restriction", async () => {
		const { tool, env, commandPermissionController, mockCard } = createMocks()
		;(env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, configurationRevision: 1 }
		commandPermissionController.validateTool.returns({ allowed: false, reason: "denied" })

		await tool.processCall({ commands: ["curl https://example.com"] }, env as any)

		assert.ok(mockCard.waitForInteraction.calledOnce)
		const cardParams = (env.ui.createCard as sinon.SinonStub).firstCall.args[0]
		assert.equal(cardParams.permissionRequestKind, "manual_tool")
	})

	it("auto-approves commands matched by a static whitelist before Utility", async () => {
		const { tool, env, commandPermissionController, autoApprover, mockCard } = createMocks()
		;(env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, configurationRevision: 1 }
		autoApprover.isCommandAutoApproved.returns(false)
		commandPermissionController.validateTool.returns({
			allowed: true,
			reason: "allowed",
			matchedPattern: "npm test*",
		})

		await tool.processCall({ commands: ["npm test -- --runInBand"] }, env as any)

		sinon.assert.notCalled(mockCard.waitForInteraction)
		sinon.assert.calledOnce(env.system.executeCommand as sinon.SinonStub)
	})

	it("keeps deterministic command restrictions manual-only in subagent execution", async () => {
		const { tool, env, commandPermissionController, autoApprover, mockCard } = createMocks()
		;(env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, configurationRevision: 1 }
		env.config.isSubagentExecution = true
		autoApprover.isCommandAutoApproved.returns(false)
		commandPermissionController.validateTool.returns({ allowed: false, reason: "denied" })

		await tool.processCall({ commands: ["curl https://example.com"] }, env as any)

		sinon.assert.calledOnce(commandPermissionController.validateTool)
		sinon.assert.calledOnce(mockCard.waitForInteraction)
		const cardParams = (env.ui.createCard as sinon.SinonStub).firstCall.args[0]
		assert.equal(cardParams.permissionRequestKind, "manual_tool")
		sinon.assert.calledOnce(env.system.executeCommand as sinon.SinonStub)
	})

	it("routes residual subagent commands through Utility-eligible approval", async () => {
		const { tool, env, commandPermissionController, autoApprover, mockCard } = createMocks()
		;(env.config as any).permissionDecisionBinding = { service: { decide: sinon.stub() }, configurationRevision: 1 }
		env.config.isSubagentExecution = true
		autoApprover.isCommandAutoApproved.returns(false)
		commandPermissionController.validateTool.returns({ allowed: true, reason: "no_config" })

		await tool.processCall({ commands: ["curl https://example.com"] }, env as any)

		sinon.assert.calledWithMatch(env.ui.createCard as sinon.SinonStub, { permissionRequestKind: "tool" })
		sinon.assert.calledOnce(mockCard.waitForInteraction)
		sinon.assert.calledOnce(env.system.executeCommand as sinon.SinonStub)
	})

	it("does not require approval for a user-approved command with stderr redirected to stdout", async () => {
		const { env, diracIgnoreController, commandPermissionController, mockCard } = createMocks()
		const stateManager = {
			getGlobalSettingsKey: sinon.stub().callsFake((key: string) => {
				switch (key) {
					case "userApprovedCommands":
						return [{ command: "uv run pytest", match: "prefix" }]
					case "autoApprovalSettings":
						return { actions: { executeCommands: false } }
					case "yoloModeToggled":
					case "autoApproveAllToggled":
						return false
					default:
						throw new Error(`Unexpected global setting: ${key}`)
				}
			}),
		}
		const autoApprover = new AutoApprove(
			commandPermissionController as any,
			{
				...structuredClone(SETTINGS_DEFAULTS),
				userApprovedCommands: [{ command: "uv run pytest", match: "prefix" }],
			} as Settings,
			false,
		)
		const tool = new ExecuteCommandTool(
			diracIgnoreController as any,
			commandPermissionController as any,
			autoApprover,
			{},
			false,
		)

		await tool.processCall({ commands: ["uv run pytest -v 2>&1"] }, env as any)

		assert.ok(mockCard.waitForInteraction.notCalled)
		assert.ok((env.system.executeCommand as sinon.SinonStub).calledOnce)
	})

	it("does not require approval for safe commands when auto-approve is enabled", async () => {
		const { tool, env } = createMocks()
		const args = { commands: ["ls -la"] }

		await tool.processCall(args, env as any)

		assert.ok((env.interaction.askPermission as sinon.SinonStub).notCalled)
	})

	it("executes commands and returns results", async () => {
		const { tool, env } = createMocks()
		const args = { commands: ["ls -la"] }

		const result = await tool.processCall(args, env as any)

		assert.ok(result.includes("--- Output for 'ls -la' ---"))
		assert.ok(result.includes("ok"))
		assert.ok((env.ui.createCard as sinon.SinonStub).calledOnce)
		assert.ok((env.system.executeCommand as sinon.SinonStub).calledOnce)
	})

	it("records structured command input and output on its card", async () => {
		const { tool, env, mockCard } = createMocks()
		;(env.system.executeCommand as sinon.SinonStub).resolves({
			userRejected: false,
			output: "Command executed successfully (exit code 0).\nOutput:\nok",
			exitCode: 0,
			completed: true,
		})

		await tool.processCall({ commands: ["echo ok"] }, env as any)

		assert.ok(
			(env.ui.createCard as sinon.SinonStub).calledWithMatch({
				rawInput: { command: "echo ok", displayName: "echo ok", language: "bash" },
			}),
		)
		assert.ok(
			mockCard.update.calledWithMatch({ rawOutput: { output: sinon.match.string, exitCode: 0, userRejected: false } }),
		)
	})
	it("does not infer failure from command-controlled output text", async () => {
		const { tool, env, mockCard } = createMocks()
		;(env.system.executeCommand as sinon.SinonStub).resolves({
			userRejected: false,
			output: "the documentation says exit code 99",
			exitCode: 0,
			completed: true,
		})

		await tool.processCall({ commands: ["echo status"] }, env as any)

		assert.ok(mockCard.finalize.calledWith("success"))
	})

	it("publishes bounded output once without streaming into the card", async () => {
		const { tool, env, mockCard } = createMocks()
		;(env.system.executeCommand as sinon.SinonStub).resolves({
			userRejected: false,
			output: "start\n" + "x".repeat(20 * 1024) + "\nend",
			exitCode: 0,
			completed: true,
		})

		await tool.processCall({ commands: ["echo large-output"] }, env as any)

		assert.equal(mockCard.appendBody.callCount, 0)
		assert.equal(mockCard.update.callCount, 1)
		const body = mockCard.update.firstCall.args[0].body as string
		assert.ok(body.includes("start"))
		assert.ok(body.includes("end"))
		assert.ok(body.includes("Output truncated"))
		assert.ok(Buffer.byteLength(body, "utf8") < 11 * 1024)
	})

	it("labels and collapses an approved permission card", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)

		await tool.processCall({ commands: ["git add ."] }, env as any)

		assert.ok(mockCard.update.calledWithMatch({ header: "Approved: git add .", collapsed: true }))
		assert.ok(mockCard.finalize.calledWith(CardStatus.SUCCESS))
	})

	it("labels and collapses a rejected permission card", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)
		mockCard.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })

		await tool.processCall({ commands: ["git add ."] }, env as any)

		assert.ok(
			mockCard.update.calledWithMatch({
				header: "Rejected: git add .",
				body: "Execution denied by user.",
				collapsed: true,
			}),
		)
		assert.ok(mockCard.finalize.calledWith(CardStatus.CANCELLED))
		assert.equal((env.system.executeCommand as sinon.SinonStub).callCount, 0)
	})

	it("labels and collapses a permission card skipped by a user message", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)
		const skipped = new ToolSkippedByUserMessage("Do something else")
		mockCard.waitForInteraction.rejects(skipped)

		await assert.rejects(() => tool.processCall({ commands: ["git add ."] }, env as any), skipped)

		assert.ok(
			mockCard.update.calledWithMatch({
				header: "Skipped: git add .",
				body: "↩ Skipped by user",
				collapsed: true,
			}),
		)
		assert.ok(mockCard.finalize.calledWith(CardStatus.SKIPPED))
	})

	it("labels and collapses a cancelled permission card when interaction is interrupted", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)
		const interruption = new Error("interaction interrupted")
		mockCard.waitForInteraction.rejects(interruption)

		await assert.rejects(() => tool.processCall({ commands: ["git add ."] }, env as any), interruption)

		assert.ok(mockCard.update.calledWithMatch({ header: "Cancelled: git add .", collapsed: true }))
		assert.ok(mockCard.finalize.calledWith(CardStatus.CANCELLED))
	})

	it("uses an aggregate outcome label for multiple approved commands", async () => {
		const { tool, env, autoApprover, mockCard } = createMocks()
		autoApprover.isCommandAutoApproved.returns(false)

		await tool.processCall({ commands: ["git add .", "git commit -m test"] }, env as any)

		assert.ok(mockCard.update.calledWithMatch({ header: "Approved: 2 commands", collapsed: true }))
	})

	it("strips workspace hint when checking command permissions", async () => {
		const { tool, env, commandPermissionController } = createMocks()

		await tool.processCall({ commands: ["@frontend:npm run build"] }, env as any)

		sinon.assert.calledWith(commandPermissionController.validateCommand, "npm run build")
	})

	it("normalizes and executes a script with wrapped interpreter command", async () => {
		const { tool, env } = createMocks()

		await tool.processCall({ script: "print('hello')", language: "python" }, env as any)

		sinon.assert.calledOnce(env.system.executeCommand as sinon.SinonStub)
		const executed = (env.system.executeCommand as sinon.SinonStub).firstCall.args[0] as string
		assert.ok(executed.startsWith("python3 << 'EOF_DIRAC_SCRIPT_"))
		assert.ok(executed.includes("print('hello')"))
	})
})
