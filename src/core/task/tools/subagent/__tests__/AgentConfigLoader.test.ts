import { strict as assert } from "node:assert"
import fs from "fs/promises"
import { afterEach, describe, it } from "mocha"
import os from "os"
import * as path from "path"
import * as sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { DiracDefaultTool, getToolUseNames } from "@/shared/tools"
import {
	AgentConfigLoader,
	getAgentsConfigPath,
	getLegacyAgentsConfigPath,
	parseAgentConfigFromYaml,
	readAgentConfigsFromDisk,
} from "../AgentConfigLoader"

async function createTempHomeDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "agent-config-loader-"))
}

describe("AgentConfigLoader", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		await AgentConfigLoader.resetInstanceForTests()
		await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
		tempDirs.length = 0
	})

	it("parses an Agents.yaml frontmatter config and system prompt body", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: read_file, list_files, search_files
modelId: sonnet
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		assert.equal(parsed.name, "code-reviewer")
		assert.equal(parsed.description, "Reviews code for quality and best practices")
		assert.equal(parsed.modelId, "sonnet")
		assert.deepEqual(parsed.tools, [DiracDefaultTool.FILE_READ, DiracDefaultTool.LIST_FILES, DiracDefaultTool.SEARCH])
		assert.equal(parsed.systemPrompt, "You are a code reviewer.")
	})

	it("supports raw Dirac tool ids in tools", () => {
		const content = `---
name: cli-agent
description: Uses internal ids
tools:
  - read_file
  - list_files
modelId: sonnet
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)
		assert.deepEqual(parsed.tools, [DiracDefaultTool.FILE_READ, DiracDefaultTool.LIST_FILES])
	})

	it("throws for unknown tools", () => {
		const content = `---
name: bad-agent
description: bad
tools: Read, NotARealTool
modelId: sonnet
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)
		assert.deepEqual(parsed.tools, ["Read", "NotARealTool"])
	})

	it("returns an empty config map when the agents directory does not exist", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const result = await readAgentConfigsFromDisk(tempHome)
		assert.equal(result.size, 0)
	})

	it("loads all yaml/yml files from homeDir/.dirac/data/agents", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = getAgentsConfigPath(tempHome)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "local-agent.yaml"),
			`---
name: local-agent
description: local agent
tools: read_file
modelId: sonnet
---

Prompt body`,
			"utf8",
		)
		await fs.writeFile(
			path.join(directoryPath, "reviewer.yml"),
			`---
name: reviewer
description: reviewer agent
tools: list_files
modelId: sonnet
---

Reviewer prompt`,
			"utf8",
		)
		await fs.writeFile(path.join(directoryPath, "ignored.txt"), "not yaml", "utf8")

		const loader = AgentConfigLoader.getInstance(tempHome)
		await loader.load()

		const localAgent = loader.getCachedConfig("local-agent")
		const reviewer = loader.getCachedConfig("reviewer")
		assert.equal(localAgent?.name, "local-agent")
		assert.deepEqual(localAgent?.tools, [DiracDefaultTool.FILE_READ])
		assert.equal(localAgent?.systemPrompt, "Prompt body")
		assert.equal(reviewer?.name, "reviewer")
		assert.deepEqual(reviewer?.tools, [DiracDefaultTool.LIST_FILES])
		assert.equal(loader.getAllCachedConfigs().size, 2)
	})

	it("creates dynamic subagent tool mappings after loading configs", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = getAgentsConfigPath(tempHome)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "code-reviewer.yaml"),
			`---
name: code reviewer
description: reviewer agent
tools: read_file
modelId: sonnet
---

Reviewer prompt`,
			"utf8",
		)

		const loader = AgentConfigLoader.getInstance(tempHome)
		await loader.load()

		const withToolNames = loader.getAllCachedConfigsWithToolNames()
		assert.equal(withToolNames.length, 1)
		assert.equal(withToolNames[0].config.name, "code reviewer")
		assert.equal(loader.resolveSubagentNameForTool(withToolNames[0].toolName), "code reviewer")
		assert.equal(loader.isDynamicSubagentTool(withToolNames[0].toolName), true)
		assert.ok(getToolUseNames().includes(withToolNames[0].toolName))
	})
	it("does not restart watching after disposal", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)
		const loader = AgentConfigLoader.getInstance(tempHome)
		await loader.ready()

		await loader.dispose()
		await loader.watch()

		assert.equal((loader as unknown as { watcher?: unknown }).watcher, undefined)
	})

	describe("Path resolution & legacy migration (ERR-1)", () => {
		it("resolves agents directory inside ~/.dirac/Agents", () => {
			const fakeHome = "/custom/home"
			assert.strictEqual(getAgentsConfigPath(fakeHome), path.join(fakeHome, ".dirac", "Agents"))
			assert.strictEqual(getLegacyAgentsConfigPath(fakeHome), path.join(fakeHome, "Documents", "Dirac", "Agents"))
		})

		it("migrates legacy agent configs from ~/Documents/Dirac/Agents to ~/.dirac/Agents", async () => {
			const tempHome = await createTempHomeDir()
			tempDirs.push(tempHome)

			const legacyDir = getLegacyAgentsConfigPath(tempHome)
			const newDir = getAgentsConfigPath(tempHome)
			await fs.mkdir(legacyDir, { recursive: true })

			await fs.writeFile(
				path.join(legacyDir, "legacy-agent.yaml"),
				`---
name: legacy-agent
description: migrated agent
tools: read_file
modelId: sonnet
---

Legacy prompt`,
				"utf8",
			)

			const configs = await readAgentConfigsFromDisk(tempHome)
			assert.strictEqual(configs.has("legacy-agent"), true)

			// Verify file was migrated to new ~/.dirac/Agents directory
			const migratedFile = path.join(newDir, "legacy-agent.yaml")
			const exists = await fs.access(migratedFile).then(
				() => true,
				() => false,
			)
			assert.strictEqual(exists, true)
		})

		it("logs a warning instead of error when watcher encounters EPERM/EACCES", async () => {
			const tempHome = await createTempHomeDir()
			tempDirs.push(tempHome)

			const loader = AgentConfigLoader.getInstance(tempHome)
			const warnSpy = sinon.spy(Logger, "warn")
			const errorSpy = sinon.spy(Logger, "error")

			try {
				await loader.ready()
				const watcher = (loader as any).watcher
				if (watcher) {
					const epermError = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
					watcher.emit("error", epermError)
				}

				sinon.assert.called(warnSpy)
				sinon.assert.notCalled(errorSpy)
			} finally {
				warnSpy.restore()
				errorSpy.restore()
				await loader.dispose()
			}
		})
	})
})
