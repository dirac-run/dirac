import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { ToolExecutorCoordinator } from "../../../ToolExecutorCoordinator"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import * as pathUtils from "@utils/path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ListFilesTool } from ".."
import { createMockTaskConfig } from "../../../__tests__/helpers/mockTaskConfig"

let tmpDir: string

function createConfig() {
	const { config, taskState } = createMockTaskConfig({ cwd: tmpDir })
	return { config, taskState }
}

describe("ListFilesTool.execute – error recovery", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-listfiles-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		AnchorStateManager.reset("ulid-1")
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function makeBlock(paths?: string | string[], recursive?: string) {
		const params: any = {}
		if (paths !== undefined) {
			if (Array.isArray(paths)) {
				params.paths = paths
			} else {
				params.paths = [paths]
			}
		}
		if (recursive !== undefined) params.recursive = recursive
		return {
			type: "tool_use" as const,
			name: DiracDefaultTool.LIST_FILES,
			params,
		}
	}

	it("returns a tool result (not a thrown exception) for a non-existent directory", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("no-such-dir"))

		// listFiles returns empty for non-existent directories, so the handler
		// should succeed rather than throw.
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock())

		assert.ok((result as string).includes("Missing required parameter"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("repeated missing-param failures accumulate", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("resets consecutiveMistakeCount to 0 after a successful list", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		// Accumulate failures
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Create a real directory with a file
		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "content")

		const result = await coordinator.execute(config, makeBlock(dirName))
		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("file.txt"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("catches a thrown exception from listFiles and returns a tool error", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		// Stub listFiles to throw
		const listFilesModule = await import("@services/glob/list-files")
		sandbox.stub(listFilesModule, "listFiles").rejects(new Error("cwd must be a directory"))

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("some-dir"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Error"))
		assert.ok((result as string).includes("cwd must be a directory"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("accumulates failures when listFiles throws repeatedly", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		const listFilesModule = await import("@services/glob/list-files")
		sandbox.stub(listFilesModule, "listFiles").rejects(new Error("boom"))

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock("dir-1"))
		await coordinator.execute(config, makeBlock("dir-2"))
		await coordinator.execute(config, makeBlock("dir-3"))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("does not increment consecutiveMistakeCount on diracignore denial", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()
		sandbox.stub(config.services.diracIgnoreController, "validateAccess").returns(false)

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("blocked-dir"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("diracignore"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does not accumulate diracignore denials across repeated calls", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()
		sandbox.stub(config.services.diracIgnoreController, "validateAccess").returns(false)

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock("blocked-1"))
		await coordinator.execute(config, makeBlock("blocked-2"))
		await coordinator.execute(config, makeBlock("blocked-3"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("does not increment consecutiveMistakeCount when multiple paths are blocked", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock(["blocked-1", "blocked-2"]))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("blocked-1"))
		assert.ok((result as string).includes("blocked-2"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("resets consecutiveMistakeCount if at least one path succeeds in a multi-path call", async () => {
		const { config, taskState } = createConfig()
		const handler = new ListFilesTool()

		// Mock diracIgnoreController to block one path but allow another
		const diracIgnoreController = {
			validateAccess: (p: string) => !p.includes("blocked"),
			filterPaths: (paths: string[]) => paths.filter((p) => !p.includes("blocked")),
		}
		config.services.diracIgnoreController = diracIgnoreController as any

		// Accumulate failures first
		taskState.consecutiveMistakeCount = 2

		// Create a real directory for the successful path
		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "content")

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock(["blocked-dir", dirName]))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("blocked-dir"))
		assert.ok((result as string).includes("file.txt"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})
})
