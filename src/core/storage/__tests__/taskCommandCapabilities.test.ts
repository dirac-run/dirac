import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskCommandCapabilities } from "@core/task/TaskCommandCapabilities"
import { DEFAULT_COMMAND_CAPABILITIES } from "@core/task/tools/utils/CommandSafetyChecker"
import { getTaskDirectoryPath } from "../taskDirectory"
import { loadTaskCommandCapabilities, saveTaskCommandCapabilities } from "../taskStorage"

describe("root task command capability storage", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "task-command-capabilities-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
	})
	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	const authority = (root: string) => new TaskCommandCapabilities(
		() => loadTaskCommandCapabilities(root),
		(snapshot) => saveTaskCommandCapabilities(root, snapshot),
	)

	it("restores durable grants for the same root and leaves other roots fresh", async () => {
		const root = authority("root")
		assert.equal(await loadTaskCommandCapabilities("root"), undefined)
		await (await root.offerApproval(7)).approve("allow-filesystem-7")
		const resumed = authority("root")
		await resumed.ready()
		assert.equal(resumed.current() & 7, 7)
		const unrelated = authority("another-root")
		await unrelated.ready()
		assert.equal(unrelated.current(), DEFAULT_COMMAND_CAPABILITIES)
	})

	it("does not copy permission authority when task files are copied to a new root", async () => {
		await (await authority("root").offerApproval(7)).approve("allow-filesystem-7")
		await fs.cp(getTaskDirectoryPath("root"), getTaskDirectoryPath("fork"), { recursive: true })
		assert.equal(await loadTaskCommandCapabilities("fork"), undefined)
		const copied = authority("fork")
		await copied.ready()
		assert.equal(copied.current(), DEFAULT_COMMAND_CAPABILITIES)
		await (await copied.offerApproval(1 << 3)).approve("allow-network-1")
		const reloaded = authority("fork")
		await reloaded.ready()
		assert.equal(reloaded.current() & 7, 3)
		assert.equal((reloaded.current() >>> 3) & 7, 1)
		assert.equal((await loadTaskCommandCapabilities("root"))!.capabilities & 7, 7)
	})

	it("fails closed on malformed records rather than discarding read or parse failures", async () => {
		await saveTaskCommandCapabilities("root", { version: 1, capabilities: DEFAULT_COMMAND_CAPABILITIES })
		const file = path.join(getTaskDirectoryPath("root"), "command-capabilities.json")
		for (const value of ["not JSON", "null", JSON.stringify({ rootTaskId: "root", version: 1, capabilities: -1 }), JSON.stringify({ version: 1, capabilities: 0 })]) {
			await fs.writeFile(file, value)
			await assert.rejects(loadTaskCommandCapabilities("root"))
		}
	})
})
