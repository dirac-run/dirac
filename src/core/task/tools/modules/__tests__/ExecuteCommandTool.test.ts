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
		executeCommand: sinon.stub().resolves({ userRejected: false, output: "ok", exitCode: 0, completed: true }),
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


	it("records structured command input and output on its card", async () => {
		const { tool, env, mockCard } = createMocks()
			; (env.system.executeCommand as sinon.SinonStub).resolves({
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
		assert.ok(mockCard.update.calledWithMatch({ rawOutput: { output: sinon.match.string, exitCode: 0, userRejected: false } }))
	})
	it("does not infer failure from command-controlled output text", async () => {
		const { tool, env, mockCard } = createMocks()
			; (env.system.executeCommand as sinon.SinonStub).resolves({
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
			; (env.system.executeCommand as sinon.SinonStub).resolves({
				userRejected: false,
				output: "start\n" + "x".repeat(20 * 1024) + "\nend",
				exitCode: 0,
				completed: true,
			})

		await tool.processCall({ commands: ["large-command"] }, env as any)

		assert.equal(mockCard.appendBody.callCount, 0)
		assert.equal(mockCard.update.callCount, 1)
		const body = mockCard.update.firstCall.args[0].body as string
		assert.ok(body.includes("start"))
		assert.ok(body.includes("end"))
		assert.ok(body.includes("Output truncated"))
		assert.ok(Buffer.byteLength(body, "utf8") < 11 * 1024)
	})
})
