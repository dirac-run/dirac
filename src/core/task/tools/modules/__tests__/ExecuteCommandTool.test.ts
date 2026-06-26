import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ExecuteCommandTool } from "../execute_command/ExecuteCommandTool"
import sinon from "sinon"

function createMocks() {
	const diracIgnoreController = {
		validateCommand: sinon.stub().returns(undefined),
	}
	const commandPermissionController = {
		validateCommand: sinon.stub().returns({ allowed: true }),
	}
	const autoApprover = {
		shouldAutoApproveTool: sinon.stub().returns(true),
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
		executeCommand: sinon.stub().resolves([false, "ok"]),
	}

	const env = {
		ui: {
			createCard: callbacks.createCard,
		},
		interaction: {
			askPermission: sinon.stub().resolves({ approved: true }),
		},
		system: {
			executeCommand: callbacks.executeCommand,
		},
		config: { cwd: "/test" },
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
		const { tool, env, autoApprover, mockCard } = createMocks()
		// isSafeCommand will return false for commands with redirection
		const args = { commands: ["ls > out.txt"] }

		await tool.processCall(args, env as any)

		assert.ok(mockCard.waitForInteraction.calledOnce)
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
})
