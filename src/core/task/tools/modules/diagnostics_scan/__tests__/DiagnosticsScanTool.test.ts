import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { ToolExecutorCoordinator } from "../../../ToolExecutorCoordinator"
import { createMockTaskConfig } from "../../../__tests__/helpers/mockTaskConfig"
import { DiagnosticsScanTool } from "../index"

describe("DiagnosticsScanTool", () => {
	let sandbox: sinon.SinonSandbox
	let tmpDir: string
	let prepareDiagnosticsStub: sinon.SinonStub
	let getDiagnosticsStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-diagscan-test-"))

		prepareDiagnosticsStub = sandbox.stub().resolves()
		getDiagnosticsStub = sandbox.stub().resolves({ fileDiagnostics: [] })

		setVscodeHostProviderMock({
			hostBridgeClient: {
				workspaceClient: {
					prepareDiagnostics: prepareDiagnosticsStub,
					getDiagnostics: getDiagnosticsStub,
				},
			} as any,
		})
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function createConfig(abortSignal?: AbortSignal) {
		const { config, taskState } = createMockTaskConfig({
			cwd: tmpDir,
			overrides: {
				isSubagentExecution: false,
			},
		})
		if (abortSignal) {
			Object.defineProperty(taskState, "abortSignal", {
				value: abortSignal,
				configurable: true,
			})
		}
		return { config, taskState }
	}

	function makeBlock(paths?: string[]) {
		const params: any = {}
		if (paths !== undefined) {
			params.paths = paths
		}
		return {
			type: "tool_use" as const,
			name: DiracDefaultTool.DIAGNOSTICS_SCAN,
			params,
		}
	}

	it("increments consecutiveMistakeCount when paths parameter is missing or empty", async () => {
		const { config, taskState } = createConfig()
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const result1 = await coordinator.execute(config, makeBlock())
		assert.ok(typeof result1 === "string" && result1.includes("Missing required parameter 'paths'"))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		const result2 = await coordinator.execute(config, makeBlock([]))
		assert.ok(typeof result2 === "string" && result2.includes("Missing required parameter 'paths'"))
		assert.equal(taskState.consecutiveMistakeCount, 2)
	})

	it("increments consecutiveMistakeCount and finalizes card as ERROR when all files fail (FB-43)", async () => {
		const { config, taskState } = createConfig()
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const result = await coordinator.execute(config, makeBlock(["non-existent-file.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("non-existent-file.ts"))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.ERROR)
	})

	it("handles pre-aborted scan: card is CANCELLED and prepare/getRaw are never called", async () => {
		const abortController = new AbortController()
		abortController.abort(new Error("Pre-aborted"))

		const { config } = createConfig(abortController.signal)
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Execution failed"))

		assert.equal(prepareDiagnosticsStub.called, false)
		assert.equal(getDiagnosticsStub.called, false)

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.CANCELLED)
		assert.equal(card.getCard().header, "Cancelled scanning for diagnostics")
	})

	it("handles in-flight cancellation during getRaw/polling: card is CANCELLED immediately", async () => {
		const abortController = new AbortController()
		const { config } = createConfig(abortController.signal)
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		getDiagnosticsStub.callsFake(async () => {
			abortController.abort(new Error("Aborted in-flight"))
			return { fileDiagnostics: [] }
		})

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Execution failed"))

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.CANCELLED)
		assert.equal(card.getCard().header, "Cancelled scanning for diagnostics")
	})

	it("handles in-flight cancellation during prepare: card is CANCELLED", async () => {
		const abortController = new AbortController()
		const { config } = createConfig(abortController.signal)
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		prepareDiagnosticsStub.callsFake(async () => {
			abortController.abort(new Error("Aborted during prepare"))
		})

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Execution failed"))

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.CANCELLED)
	})

	it("successful scan returns diagnostics and finalizes card as SUCCESS", async () => {
		const { config, taskState } = createConfig()
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x: number = 'error';")

		getDiagnosticsStub.resolves({
			fileDiagnostics: [
				{
					filePath: testFile,
					diagnostics: [
						{
							message: "Type 'string' is not assignable to type 'number'.",
							severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 7 },
							},
						},
					],
				},
			],
		})

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Type 'string' is not assignable to type 'number'"))
		assert.equal(taskState.consecutiveMistakeCount, 0)

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.SUCCESS)
	})

	it("polls and sleeps between iterations until diagnostics appear", async () => {
		const { config } = createConfig()
		const handler = new DiagnosticsScanTool()
		;(handler as any).diagnosticsDelayMs = 10
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		let callCount = 0
		getDiagnosticsStub.callsFake(async () => {
			callCount++
			if (callCount === 1) {
				return { fileDiagnostics: [] }
			}
			return {
				fileDiagnostics: [
					{
						filePath: testFile,
						diagnostics: [
							{
								message: "Test warning",
								severity: DiagnosticSeverity.DIAGNOSTIC_WARNING,
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							},
						],
					},
				],
			}
		})

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Test warning"))
		assert.ok(callCount >= 2)
	})

	it("handles abort during interruptible sleep", async () => {
		const abortController = new AbortController()
		const { config } = createConfig(abortController.signal)
		const handler = new DiagnosticsScanTool()
		;(handler as any).diagnosticsDelayMs = 50
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		getDiagnosticsStub.callsFake(async () => {
			// Trigger abort during the upcoming sleep
			setTimeout(() => {
				abortController.abort(new Error("Aborted while sleeping"))
			}, 10)
			return { fileDiagnostics: [] }
		})

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Execution failed"))

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.CANCELLED)
	})

	it("handles mixed valid and invalid files", async () => {
		const { config } = createConfig()
		const handler = new DiagnosticsScanTool()
		;(handler as any).baseDiagnosticsTimeoutMs = 30
		;(handler as any).diagnosticsDelayMs = 10
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const validFile = path.join(tmpDir, "valid.ts")
		await fs.writeFile(validFile, "const a = 1;")

		getDiagnosticsStub.resolves({ fileDiagnostics: [] })

		const result = await coordinator.execute(config, makeBlock(["valid.ts", "missing.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("missing.ts"))
		assert.ok((result as string).includes("valid.ts"))

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.SUCCESS)
	})

	it("handles execution in subagent mode without card", async () => {
		const { config } = createMockTaskConfig({
			cwd: tmpDir,
			overrides: { isSubagentExecution: true },
		})
		const handler = new DiagnosticsScanTool()
		;(handler as any).baseDiagnosticsTimeoutMs = 30
		;(handler as any).diagnosticsDelayMs = 10
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const a = 1;")

		getDiagnosticsStub.resolves({ fileDiagnostics: [] })

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.equal(typeof result, "string")

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 0)
	})

	it("handles ToolTimeoutError via presentToolTimeout", async () => {
		const { config } = createConfig()
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const a = 1;")

		const { ToolTimeoutError } = await import("../../../runtime/ToolExecutionDeadline")
		prepareDiagnosticsStub.rejects(new ToolTimeoutError("diagnostics_scan", "preparing diagnostics", 2000))

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("timed out"))
	})

	it("handles unexpected non-abort errors and finalizes card as ERROR", async () => {
		const { config } = createConfig()
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const a = 1;")

		prepareDiagnosticsStub.rejects(new Error("Unexpected crash"))

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Unexpected crash"))

		const createdCards = config.taskMessenger.createCard.returnValues
		assert.equal(createdCards.length, 1)
		const card = await createdCards[0]
		assert.equal(card.getCard().status, CardStatus.ERROR)
	})

	it("handles ToolTimeoutError in subagent mode without card", async () => {
		const { config } = createMockTaskConfig({
			cwd: tmpDir,
			overrides: { isSubagentExecution: true },
		})
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const a = 1;")

		const { ToolTimeoutError } = await import("../../../runtime/ToolExecutionDeadline")
		prepareDiagnosticsStub.rejects(new ToolTimeoutError("diagnostics_scan", "preparing diagnostics", 2000))

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("timed out"))
	})

	it("handles abort with default undefined reason", async () => {
		const abortController = new AbortController()
		abortController.abort()
		Object.defineProperty(abortController.signal, "reason", { value: undefined })

		const { config } = createConfig(abortController.signal)
		const handler = new DiagnosticsScanTool()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)

		const testFile = path.join(tmpDir, "test.ts")
		await fs.writeFile(testFile, "const x = 1;")

		const result = await coordinator.execute(config, makeBlock(["test.ts"]))
		assert.ok(typeof result === "string" && result.includes("Tool execution cancelled"))
	})

	it("exposes supportedSurfaces and spec correctly", () => {
		const handler = new DiagnosticsScanTool()
		assert.deepEqual(handler.supportedSurfaces(), ["all"])
		assert.equal(handler.spec().name, "diagnostics_scan")
	})
})
