import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import type { DiracToolSpec } from "@shared/tools"
import { getTaskScopedStateKey } from "@shared/taskletId"
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
const addresses = [rootTaskId, firstTasklet, secondTasklet]

describe("task tool storage addresses", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-task-tool-address-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
		ToolRegistry.resetInstance()
	})

	afterEach(async () => {
		sinon.restore()
		ToolRegistry.resetInstance()
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("resolves root strings, root objects and two sibling tool paths without creating top-level tasklets", async () => {
		const paths = await Promise.all(addresses.map((address) => resolveTaskToolDir("same_tool", address)))
		assert.deepEqual(paths, [
			path.join(storageDirectory, "tasks", rootTaskId, "tools", "same_tool"),
			path.join(storageDirectory, "tasks", rootTaskId, "tasklets", firstTasklet.taskletId, "tools", "same_tool"),
			path.join(storageDirectory, "tasks", rootTaskId, "tasklets", secondTasklet.taskletId, "tools", "same_tool"),
		])
		assert.equal(await resolveTaskToolDir("same_tool", { kind: "task", taskId: rootTaskId }), paths[0])
		for (const address of addresses) assert.ok((await fs.stat(getTaskDirectoryPath(address))).isDirectory())
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})

	it("discovers addressed tools and root-qualifies contained owners without cross-owner replacement or removal", async () => {
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
		const owners = [rootTaskId, "logical-owner-one", "logical-owner-two"]
		for (const [index, address] of addresses.entries()) {
			const toolDir = await resolveTaskToolDir("same_tool", address)
			await fs.mkdir(toolDir, { recursive: true })
			await fs.writeFile(path.join(toolDir, "dirac-tool.json"), "{}")
			await fs.writeFile(path.join(toolDir, "tool.ts"), `tool-${index}`)
		}
		assert.deepEqual(await refreshTaskTools(rootTaskId), ["same_tool"])
		assert.deepEqual(await refreshTaskTools(owners[1], firstTasklet), ["same_tool"])
		assert.deepEqual(await refreshTaskTools(owners[2], secondTasklet), ["same_tool"])
		const registry = ToolRegistry.getInstance()
		for (const [index, owner] of owners.entries()) {
			const ownerKey = getTaskScopedStateKey(owner, addresses[index])
			const tools = registry.getAllTools(ownerKey)
			assert.equal(tools.length, 1)
			assert.equal(tools[0].ownerTaskId, ownerKey)
			assert.equal(tools[0].spec.description, `tool-${index}`)
			assert.equal(tools[0].modulePath, path.join(getTaskDirectoryPath(addresses[index]), "tools", "same_tool", "tool.ts"))
		}
		assert.deepEqual(registry.getAllTools(), [])
		assert.deepEqual(registry.getAllTools(firstTasklet.taskletId), [])
		assert.deepEqual(registry.getAllTools(secondTasklet.taskletId), [])
		const firstTools = await resolveTaskToolDir("same_tool", firstTasklet)
		await fs.rm(firstTools, { recursive: true })
		assert.deepEqual(await refreshTaskTools(owners[1], firstTasklet), [])
		assert.deepEqual(registry.getAllTools(getTaskScopedStateKey(owners[1], firstTasklet)), [])
		assert.equal(registry.getAllTools(rootTaskId)[0].spec.description, "tool-0")
		assert.equal(registry.getAllTools(getTaskScopedStateKey(owners[2], secondTasklet))[0].spec.description, "tool-2")
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})

	it("accepts an explicit root storage address without changing the registry owner", async () => {
		const scan = sinon.stub(UserToolLoader, "load").resolves(undefined)
		assert.deepEqual(await refreshTaskTools("logical-owner", { kind: "task", taskId: rootTaskId }), [])
		assert.deepEqual(await refreshTaskTools("logical-owner", rootTaskId), [])
		assert.equal(scan.callCount, 0)
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})
})
