import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { createTaskletId, isTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { ensureTaskDirectoryExists } from "../directoryEnsurers"
import { getTaskDirectoryPath, type TaskStorageAddress } from "../taskDirectory"

describe("task storage addressing", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-task-address-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("preserves ordinary Task paths for bare IDs and explicit root addresses", () => {
		for (const taskId of ["1710000000000", "legacy-task", "goal-child-1"]) {
			const expected = path.join(storageDirectory, "tasks", taskId)
			assert.equal(getTaskDirectoryPath(taskId), expected)
			assert.equal(getTaskDirectoryPath({ kind: "task", taskId }), expected)
		}
	})

	it("resolves root and sibling tasklets into distinct paths without creating directories", async () => {
		const rootTaskId = "root"
		const first = createTaskletId()
		const second = createTaskletId()
		const rootPath = getTaskDirectoryPath(rootTaskId)
		const firstPath = getTaskDirectoryPath({ kind: "tasklet", rootTaskId, taskletId: first })
		const secondPath = getTaskDirectoryPath({ kind: "tasklet", rootTaskId, taskletId: second })
		assert.equal(firstPath, path.join(rootPath, "tasklets", first))
		assert.equal(secondPath, path.join(rootPath, "tasklets", second))
		assert.equal(new Set([rootPath, firstPath, secondPath]).size, 3)
		assert.deepEqual(await fs.readdir(storageDirectory), [])
	})

	it("requires a root-qualified address even for a valid tasklet handle", () => {
		const taskletId = createTaskletId()
		assert.equal(isTaskletId(taskletId), true)
		assert.throws(() => getTaskDirectoryPath(taskletId), /Invalid task directory identity/)
		assert.throws(() => getTaskDirectoryPath({ kind: "task", taskId: taskletId }), /Invalid task directory identity/)
	})

	it("does not find an existing tasklet under another root just because its ID is valid", async () => {
		const taskletId = createTaskletId()
		const firstAddress: TaskStorageAddress = { kind: "tasklet", rootTaskId: "first-root", taskletId }
		const secondAddress: TaskStorageAddress = { kind: "tasklet", rootTaskId: "second-root", taskletId }
		const existing = await ensureTaskDirectoryExists(firstAddress)
		assert.equal(isTaskletId(taskletId), true)
		assert.notEqual(getTaskDirectoryPath(secondAddress), existing)
		await assert.rejects(fs.stat(getTaskDirectoryPath(secondAddress)), { code: "ENOENT" })
		assert.equal(getTaskDirectoryPath(JSON.parse(JSON.stringify(firstAddress))), existing)
	})

	it("creates root and sibling directories concurrently and idempotently", async () => {
		const addresses: TaskStorageAddress[] = [
			{ kind: "task", taskId: "root" },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
		]
		const directories = await Promise.all(addresses.map(ensureTaskDirectoryExists))
		assert.equal(new Set(directories).size, 3)
		assert.deepEqual(await Promise.all(addresses.map(ensureTaskDirectoryExists)), directories)
		for (let index = 0; index < addresses.length; index++) {
			assert.equal(directories[index], getTaskDirectoryPath(addresses[index]))
			assert.equal((await fs.stat(directories[index])).isDirectory(), true)
		}
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), ["root"])
	})

	it("propagates directory creation failure", async () => {
		const error = new Error("mkdir failed")
		sinon.stub(fs, "mkdir").rejects(error)
		await assert.rejects(
			ensureTaskDirectoryExists({ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() }),
			(thrown: unknown) => thrown === error,
		)
	})

	for (const invalidId of [
		"",
		".",
		"..",
		"../escape",
		"root/child",
		"root\\child",
		"/absolute",
		"C:\\escape",
		"bad\0id",
		"tasklet_bad",
	]) {
		it(`rejects root identity ${JSON.stringify(invalidId)} before creating any directory`, async () => {
			const addresses: (string | TaskStorageAddress)[] = [
				invalidId,
				{ kind: "task", taskId: invalidId },
				{ kind: "tasklet", rootTaskId: invalidId, taskletId: createTaskletId() },
			]
			for (const address of addresses) {
				assert.throws(() => getTaskDirectoryPath(address), /Invalid task directory identity/)
				await assert.rejects(ensureTaskDirectoryExists(address), /Invalid task directory identity/)
			}
			assert.deepEqual(await fs.readdir(storageDirectory), [])
		})
	}

	for (const invalidId of [
		"",
		".",
		"..",
		"../escape",
		"root/child",
		"root\\child",
		"/absolute",
		"C:\\escape",
		"bad\0id",
		"1710000000000",
		"tasklet_bad",
	]) {
		it(`rejects tasklet identity ${JSON.stringify(invalidId)} before creating any directory`, async () => {
			const address: TaskStorageAddress = { kind: "tasklet", rootTaskId: "root", taskletId: invalidId }
			assert.throws(() => getTaskDirectoryPath(address), /Invalid tasklet directory identity/)
			await assert.rejects(ensureTaskDirectoryExists(address), /Invalid tasklet directory identity/)
			assert.deepEqual(await fs.readdir(storageDirectory), [])
		})
	}

	it("rejects using a tasklet as the owning root", async () => {
		const address: TaskStorageAddress = { kind: "tasklet", rootTaskId: createTaskletId(), taskletId: createTaskletId() }
		assert.throws(() => getTaskDirectoryPath(address), /Invalid task directory identity/)
		await assert.rejects(ensureTaskDirectoryExists(address), /Invalid task directory identity/)
		assert.deepEqual(await fs.readdir(storageDirectory), [])
	})
})
