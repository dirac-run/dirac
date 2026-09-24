import { strict as assert } from "node:assert"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import { ToolDiscoveryService } from "../ToolDiscoveryService"
import { UserToolLoader } from "../UserToolLoader"

const tempDirs: string[] = []
let originalDiracDir: string | undefined

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-user-tool-"))
	tempDirs.push(dir)
	return dir
}

async function writeUserTool(
	root: string,
	options: {
		id?: string
		name?: string
		scope?: "global" | "workspace"
		schemaVersion?: number
		entry?: string
		createdBy?: string
		description?: string
		extraSource?: string
	} = {},
): Promise<string> {
	const id = options.id ?? "run_tests"
	const name = options.name ?? id
	const toolDir = path.join(root, id)
	await fs.mkdir(toolDir, { recursive: true })
	await fs.writeFile(
		path.join(toolDir, "dirac-tool.json"),
		JSON.stringify({
			schemaVersion: options.schemaVersion ?? 1,
			id,
			name,
			scope: options.scope ?? "workspace",
			entry: options.entry ?? "tool.ts",
			createdBy: options.createdBy ?? "dirac",
			createdAt: "2026-05-29T00:00:00.000Z",
		}),
		"utf8",
	)
	await fs.writeFile(
		path.join(toolDir, "tool.ts"),
		`export const spec = {
    id: "${id}",
    name: "${name}",
    description: "${options.description ?? "Run tests"}",
}

export function create() {
    return {
        spec() { return spec },
        supportedSurfaces() { return ["all"] },
        async processCall() { return "ok" },
    }
}
${options.extraSource ?? ""}
`,
		"utf8",
	)
	return toolDir
}

beforeEach(async () => {
	originalDiracDir = process.env.DIRAC_DIR
	process.env.DIRAC_DIR = await makeTempDir()
})

afterEach(async () => {
	await UserToolLoader.purgeStaleCache([])
	if (originalDiracDir === undefined) {
		delete process.env.DIRAC_DIR
	} else {
		process.env.DIRAC_DIR = originalDiracDir
	}
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("UserToolLoader", () => {
	it("loads a valid manifest-backed TypeScript user tool", async () => {
		const root = await makeTempDir()
		const toolDir = await writeUserTool(root)

		const tool = await UserToolLoader.load(toolDir, "workspace")

		assert.ok(tool)
		assert.equal(tool.id, "run_tests")
		assert.equal(tool.name, "run_tests")
		assert.equal(tool.source, "workspace")
		assert.equal(tool.spec.description, "Run tests")
		assert.equal(await tool.factory().processCall({}, {} as any), "ok")
	})

	it("rejects missing dirac-tool.json", async () => {
		const root = await makeTempDir()
		const toolDir = path.join(root, "missing_manifest")
		await fs.mkdir(toolDir, { recursive: true })
		await fs.writeFile(path.join(toolDir, "tool.ts"), "export const spec = {}; export function create() {}", "utf8")

		const tool = await UserToolLoader.load(toolDir, "workspace")

		assert.equal(tool, undefined)
	})

	it("rejects a manifest that is not valid JSON", async () => {
		const root = await makeTempDir()
		const toolDir = path.join(root, "bad_manifest")
		await fs.mkdir(toolDir, { recursive: true })
		await fs.writeFile(path.join(toolDir, "dirac-tool.json"), '{"schemaVersion": 1, "id": ', "utf8")
		await fs.writeFile(path.join(toolDir, "tool.ts"), "export const spec = {}; export function create() {}", "utf8")

		const result = await UserToolLoader.loadWithDiagnostics(toolDir, "workspace")

		assert.equal(result.tool, undefined)
		assert.ok(result.error?.includes("malformed JSON"), "error should identify malformed JSON")
	})

	it("rejects a manifest with the wrong shape (missing createdBy)", async () => {
		const root = await makeTempDir()
		const toolDir = path.join(root, "wrong_shape")
		await fs.mkdir(toolDir, { recursive: true })
		await fs.writeFile(
			path.join(toolDir, "dirac-tool.json"),
			JSON.stringify({ schemaVersion: 1, id: "ok_tool", name: "ok_tool", scope: "workspace", entry: "tool.ts" }),
			"utf8",
		)
		await fs.writeFile(path.join(toolDir, "tool.ts"), "export const spec = {}; export function create() {}", "utf8")

		const result = await UserToolLoader.loadWithDiagnostics(toolDir, "workspace")

		assert.equal(result.tool, undefined)
		assert.ok(result.error?.includes("schema mismatch") || result.error?.includes("createdBy"))
	})

	it("rejects manifest/spec id mismatch", async () => {
		const root = await makeTempDir()
		const toolDir = await writeUserTool(root, { id: "manifest_id" })
		await fs.writeFile(
			path.join(toolDir, "tool.ts"),
			`export const spec = { id: "other_id", name: "manifest_id", description: "Mismatch" }
export function create() { return { spec() { return spec }, supportedSurfaces() { return ["all"] }, async processCall() {} } }
`,
			"utf8",
		)

		const tool = await UserToolLoader.load(toolDir, "workspace")

		assert.equal(tool, undefined)
	})

	it("loads edited source on the next scan", async () => {
		const root = await makeTempDir()
		const toolDir = await writeUserTool(root, { description: "Before" })

		const before = await UserToolLoader.load(toolDir, "workspace")
		assert.equal(before?.spec.description, "Before")

		await writeUserTool(root, { description: "After" })
		const after = await UserToolLoader.load(toolDir, "workspace")

		assert.equal(after?.spec.description, "After")
	})
})

describe("ToolDiscoveryService user tools", () => {
	it("ignores directories without a sidecar manifest", async () => {
		const root = await makeTempDir()
		await fs.mkdir(path.join(root, "random"), { recursive: true })
		await fs.writeFile(path.join(root, "random", "tool.ts"), "export const spec = {}; export function create() {}", "utf8")

		const tools = await ToolDiscoveryService.scanUserToolDirectory(root, "workspace")

		assert.equal(tools.length, 0)
	})

	it("discovers a disabled workspace tool without evaluating module top-level code", async () => {
		const workspace = await makeTempDir()
		const toolsDir = path.join(workspace, ".dirac", "tools")
		const marker = path.join(workspace, "unexpected-marker")
		await writeUserTool(toolsDir, {
			id: "marker_tool",
			extraSource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
		})

		const tools = await ToolDiscoveryService.scanWorkspaceTools(workspace)

		assert.equal(tools.length, 1)
		assert.equal(tools[0].id, "marker_tool")
		assert.equal(tools[0].executable, false)
		await assert.rejects(() => fs.access(marker), { code: "ENOENT" })
	})

	it("skips invalid tools without blocking valid tools", async () => {
		const root = await makeTempDir()
		await writeUserTool(root, { id: "valid_tool" })
		await writeUserTool(root, { id: "invalid_tool", schemaVersion: 0 })

		const tools = await ToolDiscoveryService.scanUserToolDirectory(root, "workspace")

		assert.deepEqual(
			tools.map((tool) => tool.id),
			["valid_tool"],
		)
	})
})
