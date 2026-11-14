import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import type { DiracToolSpec } from "@shared/tools"
import { getRootTaskId } from "@shared/taskletId"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import { resolveTaskToolDir } from "../../modules/upsert_tool/constants"
import { refreshTaskTools } from "../refreshToolRegistry"
import { ToolRegistry } from "../ToolRegistry"

const rootTaskId = "1700000000000"
const firstTasklet: TaskStorageAddress = {
	kind: "tasklet",
	rootTaskId,
	taskletId: "tasklet_00000000-0000-4000-8000-000000000001",
}
const secondTasklet: TaskStorageAddress = {
	kind: "tasklet",
	rootTaskId,
	taskletId: "tasklet_00000000-0000-4000-8000-000000000002",
}
const addresses = [rootTaskId, { kind: "task" as const, taskId: rootTaskId }, firstTasklet, secondTasklet]

describe("task tool storage addresses", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-task-tool-address-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
		ToolRegistry.resetInstance()
		// Keep directory discovery and registry reconciliation real; compilation is outside this API's scope.
		sinon.stub(UserToolLoader, "load").callsFake(async (toolDir, source) => {
			const label = await fs.readFile(path.join(toolDir, "tool.ts"), "utf8")
			const spec = { id: "same_tool", name: "same_tool", description: label } as DiracToolSpec
			return {
				id: "same_tool",
				name: "same_tool",
				source,
				exposure: { kind: "configurable" },
				spec,
				factory: () => ({ spec: () => spec, supportedSurfaces: () => ["all"], processCall: async () => label }),
				modulePath: path.join(toolDir, "tool.ts"),
				sourceHash: label,
			}
		})
	})

	afterEach(async () => {
		sinon.restore()
		ToolRegistry.resetInstance()
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	async function writeTool(address: string | TaskStorageAddress, label: string): Promise<string> {
		const toolDir = await resolveTaskToolDir("same_tool", address)
		await fs.mkdir(toolDir, { recursive: true })
		await fs.writeFile(path.join(toolDir, "dirac-tool.json"), "{}")
		await fs.writeFile(path.join(toolDir, "tool.ts"), label)
		return toolDir
	}

	it("resolves root strings, root objects and siblings to one root tool directory without creating child storage", async () => {
		const expected = path.join(storageDirectory, "tasks", rootTaskId, "tools", "same_tool")
		for (const address of addresses) {
			assert.equal(getRootTaskId(address), rootTaskId)
			assert.equal(await resolveTaskToolDir("same_tool", address), expected)
		}
		assert.ok((await fs.stat(getTaskDirectoryPath(rootTaskId))).isDirectory())
		await assert.rejects(fs.access(path.join(getTaskDirectoryPath(rootTaskId), "tasklets")), { code: "ENOENT" })
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})

	it("reconciles root and sibling updates under one owner while isolating an unrelated root with a copied child ID", async () => {
		const otherRootId = "1700000000001"
		const copiedTasklet: TaskStorageAddress = { ...firstTasklet, rootTaskId: otherRootId }
		const toolDir = await writeTool(rootTaskId, "root version")
		const otherToolDir = await writeTool(copiedTasklet, "other root version")
		assert.notEqual(toolDir, otherToolDir)
		assert.equal(getRootTaskId(copiedTasklet), otherRootId)
		assert.deepEqual(await refreshTaskTools(rootTaskId), ["same_tool"])
		assert.deepEqual(await refreshTaskTools(copiedTasklet.taskletId, copiedTasklet), ["same_tool"])
		const registry = ToolRegistry.getInstance()
		const assertOwner = (owner: string, description: string, directory: string) => {
			const tools = registry.getAllTools(owner)
			assert.equal(tools.length, 1)
			assert.equal(tools[0].ownerTaskId, owner)
			assert.equal(tools[0].spec.description, description)
			assert.equal(tools[0].modulePath, path.join(directory, "tool.ts"))
		}
		assertOwner(rootTaskId, "root version", toolDir)
		assertOwner(otherRootId, "other root version", otherToolDir)
		for (const [index, child] of [firstTasklet, secondTasklet].entries()) {
			assert.equal(await writeTool(child, `child update ${index}`), toolDir)
			assert.deepEqual(await refreshTaskTools(child.taskletId, child), ["same_tool"])
			assertOwner(rootTaskId, `child update ${index}`, toolDir)
			assertOwner(otherRootId, "other root version", otherToolDir)
			assert.deepEqual(registry.getAllTools(child.taskletId), [])
		}
		assert.deepEqual(registry.getAllTools(), [])
		await fs.rm(toolDir, { recursive: true })
		assert.deepEqual(await refreshTaskTools(secondTasklet.taskletId, secondTasklet), [])
		assert.deepEqual(registry.getAllTools(rootTaskId), [])
		assertOwner(otherRootId, "other root version", otherToolDir)
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId, otherRootId])
	})

	it("uses the explicit root storage address as owner instead of a logical execution ID", async () => {
		const toolDir = await writeTool(rootTaskId, "root version")
		for (const address of [rootTaskId, { kind: "task" as const, taskId: rootTaskId }]) {
			assert.deepEqual(await refreshTaskTools("logical-owner", address), ["same_tool"])
			const registry = ToolRegistry.getInstance()
			assert.deepEqual(registry.getAllTools("logical-owner"), [])
			assert.equal(registry.getAllTools(rootTaskId)[0].ownerTaskId, rootTaskId)
			assert.equal(registry.getAllTools(rootTaskId)[0].modulePath, path.join(toolDir, "tool.ts"))
		}
	})

	it("does not discover legacy child-local tool storage", async () => {
		const legacyToolDir = path.join(getTaskDirectoryPath(firstTasklet), "tools", "same_tool")
		await fs.mkdir(legacyToolDir, { recursive: true })
		await fs.writeFile(path.join(legacyToolDir, "dirac-tool.json"), "{}")
		await fs.writeFile(path.join(legacyToolDir, "tool.ts"), "legacy child version")
		assert.deepEqual(await refreshTaskTools(firstTasklet.taskletId, firstTasklet), [])
		assert.deepEqual(ToolRegistry.getInstance().getAllTools(rootTaskId), [])
		await writeTool(rootTaskId, "root version")
		assert.deepEqual(await refreshTaskTools(firstTasklet.taskletId, firstTasklet), ["same_tool"])
		assert.equal(ToolRegistry.getInstance().getAllTools(rootTaskId)[0].spec.description, "root version")
		assert.equal(await fs.readFile(path.join(legacyToolDir, "tool.ts"), "utf8"), "legacy child version")
	})
})
