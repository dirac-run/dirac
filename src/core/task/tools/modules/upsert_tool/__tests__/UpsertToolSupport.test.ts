import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, it } from "mocha"
import type { DiracToolSpecParameter } from "@shared/tools"
import { buildToolSource, writeTestHarness } from "../scaffold-generator"
import { commitToolPromotion, createToolStagingDirectory, promoteStagedTool, rollbackToolPromotion } from "../tool-lifecycle"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("upsert_tool support", () => {
	it("embeds the complete supplied body without changing metadata or adding a scaffold placeholder", () => {
		const parameters: DiracToolSpecParameter[] = [{ name: "text", type: "string", required: false, instruction: 'Text with "quotes"' }]
		const implementation = 'const value = args?.text ?? "usage"\nreturn `${env.config.cwd}: ${value}`'
		const source = buildToolSource("example_tool", 'Example "tool"\nwith metadata', parameters, implementation)
		assert.ok(source.includes(implementation))
		assert.match(source, /export const spec/)
		assert.match(source, /export function create\(\)/)
		assert.match(source, /async processCall\(args: any, env: any\)/)
		assert.ok(source.includes(JSON.stringify('Example "tool"\nwith metadata')))
		assert.ok(source.includes(JSON.stringify(parameters[0].instruction)))
		assert.doesNotMatch(source, /__DIRAC_TOOL_IMPLEMENTATION_REQUIRED__|REPLACE THIS BLOCK|END REPLACE/)
	})

	it("writes a harness with the current executeCommand result shape", async () => {
		const directory = await createTemporaryDirectory()
		await writeTestHarness(directory)
		const harness = await fs.readFile(path.join(directory, "test-harness.ts"), "utf8")

		assert.match(harness, /userRejected: false/)
		assert.match(harness, /completed: true/)
		assert.match(harness, /exitCode:/)
		assert.doesNotMatch(harness, /return \[false,/)
	})

	it("restores the previous live directory when promotion is rolled back", async () => {
		const root = await createTemporaryDirectory()
		const finalDir = path.join(root, "tools", "example_tool")
		await fs.mkdir(finalDir, { recursive: true })
		await fs.writeFile(path.join(finalDir, "tool.ts"), "old", "utf8")

		const stagingDir = await createToolStagingDirectory(finalDir)
		await fs.writeFile(path.join(stagingDir, "tool.ts"), "new", "utf8")
		const promotion = await promoteStagedTool(stagingDir, finalDir)
		assert.strictEqual(await fs.readFile(path.join(finalDir, "tool.ts"), "utf8"), "new")

		await rollbackToolPromotion(promotion)
		assert.strictEqual(await fs.readFile(path.join(finalDir, "tool.ts"), "utf8"), "old")
	})

	it("removes the previous live backup after promotion is committed", async () => {
		const root = await createTemporaryDirectory()
		const finalDir = path.join(root, "tools", "example_tool")
		await fs.mkdir(finalDir, { recursive: true })
		await fs.writeFile(path.join(finalDir, "tool.ts"), "old", "utf8")

		const stagingDir = await createToolStagingDirectory(finalDir)
		await fs.writeFile(path.join(stagingDir, "tool.ts"), "new", "utf8")
		const promotion = await promoteStagedTool(stagingDir, finalDir)
		await commitToolPromotion(promotion)

		assert.strictEqual(await fs.readFile(path.join(finalDir, "tool.ts"), "utf8"), "new")
		if (promotion.backupDir) {
			await assert.rejects(fs.access(promotion.backupDir))
		}
	})
})

async function createTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-upsert-tool-"))
	temporaryDirectories.push(directory)
	return directory
}
