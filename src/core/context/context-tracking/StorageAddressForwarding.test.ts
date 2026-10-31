import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as disk from "@core/storage/disk"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { activateTaskSkill } from "@core/task/activateTaskSkill"
import { TaskState } from "@core/task/TaskState"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { EnvironmentContextTracker } from "./EnvironmentContextTracker"
import { type FileContextStateStore, FileContextTracker } from "./FileContextTracker"
import { ModelContextTracker } from "./ModelContextTracker"

const rootId = "1700000000000"
const childId = "tasklet_00000000-0000-4000-8000-000000000001"
const addresses: TaskStorageAddress[] = [
	{ kind: "task", taskId: rootId },
	{ kind: "tasklet", rootTaskId: rootId, taskletId: childId },
	{ kind: "tasklet", rootTaskId: rootId, taskletId: "tasklet_00000000-0000-4000-8000-000000000002" },
	{ kind: "tasklet", rootTaskId: "1700000000001", taskletId: childId },
]

function stateStore(): FileContextStateStore {
	const entries: Record<string, unknown> = {}
	return {
		getWorkspaceStateKey: (key) => entries[key],
		setWorkspaceState: (key, value) => {
			entries[key] = value
		},
		getAllWorkspaceStateEntries: () => entries,
	}
}

function tracker(store: FileContextStateStore, address?: TaskStorageAddress) {
	return new FileContextTracker(store, address?.kind === "tasklet" ? address.taskletId : rootId, undefined, address)
}

describe("execution metadata and warning address forwarding", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-tracker-address-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		sinon.stub(disk, "collectEnvironmentMetadata").resolves({
			os_name: "test",
			os_version: "1",
			os_arch: "test",
			host_name: "test",
			host_version: "1",
			dirac_version: "1",
		})
	})
	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("persists root, sibling, and same-ID/different-root tracker metadata and skills independently", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				const logicalId = address.kind === "tasklet" ? address.taskletId : address.taskId
				const file = tracker(stateStore(), address)
				const model = new ModelContextTracker(logicalId, address)
				const environment = new EnvironmentContextTracker(logicalId, address)
				assert.equal(file.taskId, logicalId)
				assert.equal(model.taskId, logicalId)
				assert.equal(environment.taskId, logicalId)
				const taskState = new TaskState()
				await Promise.all([
					file.addFileToFileContextTracker(logicalId, `file-${index}`, "dirac_edited"),
					model.recordModelUsage("test", `model-${index}`, "act"),
					environment.recordEnvironment(),
					activateTaskSkill(address, taskState, `skill-${index}`),
				])
				await activateTaskSkill(address, taskState, `skill-${index}`)
				await environment.recordEnvironment()
				const metadata = await disk.getTaskMetadata(address)
				assert.deepEqual(
					metadata.files_in_context.map((entry) => entry.path),
					[`file-${index}`],
				)
				assert.deepEqual(
					metadata.model_usage.map((entry) => entry.model_id),
					[`model-${index}`],
				)
				assert.equal(metadata.environment_history.length, 1)
				assert.deepEqual(metadata.active_skill_ids, [`skill-${index}`])
				assert.deepEqual(taskState.activeSkillIds, [`skill-${index}`])
				assert.deepEqual(await file.detectFilesEditedAfterMessage(0, []), [`file-${index}`])
			}),
		)
		assert.deepEqual((await fs.readdir(path.join(directory, "tasks"))).sort(), [rootId, "1700000000001"])
	})

	it("retains legacy string metadata and warning destinations", async () => {
		const store = stateStore()
		const file = tracker(store)
		await file.addFileToFileContextTracker(rootId, "legacy", "read_tool")
		await new ModelContextTracker(rootId).recordModelUsage("test", "legacy", "act")
		await new EnvironmentContextTracker(rootId).recordEnvironment()
		await activateTaskSkill(rootId, new TaskState(), "legacy")
		assert.deepEqual(await disk.getTaskMetadata(rootId), await disk.getTaskMetadata(addresses[0]))
		await file.storePendingFileContextWarning(["legacy"])
		assert.deepEqual(store.getWorkspaceStateKey(`pendingFileContextWarning_${rootId}`), ["legacy"])
		assert.deepEqual(await tracker(store, addresses[0]).retrieveAndClearPendingFileContextWarning(), ["legacy"])
		assert.equal(await file.retrievePendingFileContextWarning(), undefined)
	})

	it("restores isolated warnings and preserves them through root-only history cleanup", async () => {
		const store = stateStore()
		const rootHistory = [rootId, "1700000000001"].map((id) => ({
			id,
			ts: 0,
			task: "root",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}))
		const history = sinon.stub(disk, "readTaskHistoryFromState").resolves(rootHistory)
		await Promise.all(
			addresses.map((address, index) => tracker(store, address).storePendingFileContextWarning([`file-${index}`])),
		)
		await FileContextTracker.cleanupOrphanedWarnings(store)
		for (const [index, address] of addresses.entries()) {
			assert.deepEqual(await tracker(store, address).retrievePendingFileContextWarning(), [`file-${index}`])
		}
		assert.deepEqual(await tracker(store, addresses[1]).retrieveAndClearPendingFileContextWarning(), ["file-1"])
		assert.deepEqual(await tracker(store, addresses[2]).retrievePendingFileContextWarning(), ["file-2"])
		history.resolves([rootHistory[1]])
		await FileContextTracker.cleanupOrphanedWarnings(store)
		assert.equal(await tracker(store, addresses[0]).retrievePendingFileContextWarning(), undefined)
		assert.equal(await tracker(store, addresses[2]).retrievePendingFileContextWarning(), undefined)
		assert.deepEqual(await tracker(store, addresses[3]).retrievePendingFileContextWarning(), ["file-3"])
	})
})
