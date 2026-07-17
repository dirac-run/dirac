import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, it } from "mocha"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { buildToolWithRepairs } from "../subagent-builder"
import { buildScaffoldedToolSource, writeTestHarness } from "../scaffold-generator"
import {
    commitToolPromotion,
    createToolStagingDirectory,
    promoteStagedTool,
    rollbackToolPromotion,
} from "../tool-lifecycle"
import { TOOL_IMPLEMENTATION_SENTINEL } from "../constants"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("upsert_tool support", () => {
	it("uses one exact implementation sentinel without legacy marker comments", () => {
		const source = buildScaffoldedToolSource("example_tool", "Example tool", [])
		assert.strictEqual(source.split(TOOL_IMPLEMENTATION_SENTINEL).length - 1, 1)
		assert.doesNotMatch(source, /REPLACE THIS BLOCK|END REPLACE/)
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

	it("feeds parent validation failures into a bounded repair attempt", async () => {
		const prompts: string[] = []
		let validationCalls = 0
		const env = {
			orchestration: {
				runSubagent: async (prompt: string) => {
					prompts.push(prompt)
					return { status: "completed", result: "", stats: {} }
				},
			},
		} as unknown as IToolEnvironment

		const result = await buildToolWithRepairs(
			env,
			{
				name: "example_tool",
				scope: "workspace",
				description: "Example tool",
				parameters: [],
				requirements: "Return an example result.",
				toolDir: "/tmp/example-tool-build",
			},
			async () => ++validationCalls === 1 ? "smoke test failed" : undefined,
			async () => {},
		)

		assert.strictEqual(result, undefined)
		assert.strictEqual(prompts.length, 2)
		assert.match(prompts[1], /smoke test failed/)
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
