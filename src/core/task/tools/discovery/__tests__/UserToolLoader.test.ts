import { strict as assert } from "node:assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, it } from "mocha"
import { ToolDiscoveryService } from "../ToolDiscoveryService"
import { UserToolLoader } from "../UserToolLoader"

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-user-tool-"))
    tempDirs.push(dir)
    return dir
}

async function writeUserTool(root: string, options: {
    id?: string
    name?: string
    scope?: "global" | "workspace"
    schemaVersion?: number
    entry?: string
    createdBy?: string
    description?: string
    extraSource?: string
} = {}): Promise<string> {
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

describe("UserToolLoader", () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
    })

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
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
    })

    it("ignores directories without a sidecar manifest", async () => {
        const root = await makeTempDir()
        await fs.mkdir(path.join(root, "random"), { recursive: true })
        await fs.writeFile(path.join(root, "random", "tool.ts"), "export const spec = {}; export function create() {}", "utf8")

        const tools = await ToolDiscoveryService.scanUserToolDirectory(root, "workspace")

        assert.equal(tools.length, 0)
    })

    it("skips invalid tools without blocking valid tools", async () => {
        const root = await makeTempDir()
        await writeUserTool(root, { id: "valid_tool" })
        await writeUserTool(root, { id: "invalid_tool", schemaVersion: 999 })

        const tools = await ToolDiscoveryService.scanUserToolDirectory(root, "workspace")

        assert.deepEqual(tools.map((tool) => tool.id), ["valid_tool"])
    })
})
