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
import { SearchFilesTool } from ".."
import { createMockTaskConfig } from "../../../__tests__/helpers/mockTaskConfig"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { HostProvider } from "@/hosts/host-provider"

let tmpDir: string

function createConfig() {
	const { config, taskState } = createMockTaskConfig({ cwd: tmpDir })
	return { config, taskState }
}

describe("SearchFilesTool.execute – error recovery", () => {
	let sandbox: sinon.SinonSandbox
	let searchStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-search-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		AnchorStateManager.reset("ulid-1")

		setVscodeHostProviderMock()

		// Default stub: regexSearchFiles returns a successful empty search
		const ripgrepModule = await import("@services/ripgrep")
		searchStub = sandbox.stub(ripgrepModule, "regexSearchFiles")
		searchStub.resolves("Found 0 results.")
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	function makeBlock(relPaths?: string | string[], regex?: string, filePattern?: string) {
		const params: Record<string, any> = {}
		if (relPaths !== undefined) {
			if (Array.isArray(relPaths)) {
				params.paths = relPaths
			} else {
				params.paths = [relPaths]
			}
		}
		if (regex !== undefined) params.regex = regex
		if (filePattern !== undefined) params.file_pattern = filePattern
		return {
			type: "tool_use" as const,
			name: DiracDefaultTool.SEARCH,
			params,
		}
	}

	it("returns a tool result (not a thrown exception) for a non-existent directory", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("no-such-dir", "needle"))

		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("increments consecutiveMistakeCount when path parameter is missing", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock())

		assert.ok((result as string).includes("Missing required parameter"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("increments consecutiveMistakeCount when regex parameter is missing", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("some-dir"))

		assert.ok((result as string).includes("Missing required parameter"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("repeated missing-param failures accumulate", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("resets consecutiveMistakeCount to 0 after a successful search", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock())
		await coordinator.execute(config, makeBlock())
		assert.equal(taskState.consecutiveMistakeCount, 2)

		// Create a real file to search
		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "needle content")

		// Override stub to return results
		searchStub.resolves("Found 1 results.\nfile.txt:1:needle content\n")

		const result = await coordinator.execute(config, makeBlock(dirName, "needle"))
		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("catches a thrown exception from regexSearchFiles and returns a tool error", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		// Create dir so existence check passes
		await fs.mkdir(path.join(tmpDir, "some-dir"))
		searchStub.rejects(new Error("cwd must be a directory"))

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("some-dir", "needle"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("failed"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("accumulates failures when regexSearchFiles throws repeatedly", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		// Create dirs so existence check passes
		await fs.mkdir(path.join(tmpDir, "dir-1"))
		await fs.mkdir(path.join(tmpDir, "dir-2"))
		await fs.mkdir(path.join(tmpDir, "dir-3"))
		searchStub.rejects(new Error("boom"))

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock("dir-1", "needle"))
		await coordinator.execute(config, makeBlock("dir-2", "needle"))
		await coordinator.execute(config, makeBlock("dir-3", "needle"))
		assert.equal(taskState.consecutiveMistakeCount, 3)
	})

	it("increments consecutiveMistakeCount when regexSearchFiles throws", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		// Create dir so existence check passes
		await fs.mkdir(path.join(tmpDir, "some-dir"))
		searchStub.rejects(new Error("ripgrep error"))

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock("some-dir", "needle"))

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("failed"))
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("resets consecutiveMistakeCount after regexSearchFiles failure is followed by success", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		// Create dirs so existence check passes
		await fs.mkdir(path.join(tmpDir, "dir-1"))
		await fs.mkdir(path.join(tmpDir, "search-root"))

		// First call fails, subsequent calls succeed
		searchStub.onFirstCall().rejects(new Error("boom"))
		// Default behavior (resolves with "Found 0 results.") applies to subsequent calls

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		await coordinator.execute(config, makeBlock("dir-1", "needle"))
		assert.equal(taskState.consecutiveMistakeCount, 1)

		await coordinator.execute(config, makeBlock("search-root", "needle"))
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("resets consecutiveMistakeCount if at least one path succeeds in a multi-path call", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const diracIgnoreController = {
			validateAccess: (p: string) => !p.includes("blocked"),
			filterPaths: (paths: string[]) => paths.filter((p) => !p.includes("blocked")),
		}
		config.services.diracIgnoreController = diracIgnoreController as any

		taskState.consecutiveMistakeCount = 2

		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "needle content")
		// "blocked-dir" does not exist on disk – existence check handles it gracefully

		// Override stub to return results for the real dir search
		searchStub.resolves("Found 1 results.\nfile.txt:1:needle content\n")

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock(["blocked-dir", dirName], "needle"))

		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})

	it("correctly handles an array passed to the 'path' parameter (bug fix)", async () => {
		const { config, taskState } = createConfig()
		const handler = new SearchFilesTool()

		const dirName = "real-dir"
		await fs.mkdir(path.join(tmpDir, dirName))
		await fs.writeFile(path.join(tmpDir, dirName, "file.txt"), "needle content")

		// Override stub to return results
		searchStub.resolves("Found 1 results.\nfile.txt:1:needle content\n")

		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(handler)
		const result = await coordinator.execute(config, makeBlock([dirName], "needle"))

		assert.equal(typeof result, "string")
		assert.equal(taskState.consecutiveMistakeCount, 0)
	})
})
