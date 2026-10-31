import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import type { DiracStorageMessage } from "@shared/messages/content"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import * as HookExecutor from "../hook-executor"
import {
	executePreCompactHookWithCleanup,
	HookCancellationError,
	type PreCompactHookParams,
	writePreCompactContextFiles,
} from "../precompact-executor"

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

function history(text: string): DiracStorageMessage[] {
	return [{ role: "user", content: [{ type: "text", text }] }]
}

function hookParams(taskId: string, storageAddress?: TaskStorageAddress): PreCompactHookParams {
	return {
		taskId,
		storageAddress,
		ulid: "telemetry-id",
		modelContext: { provider: "test", slug: "test-model" },
		apiConversationHistory: history("active context"),
		diracMessages: [],
		contextManager: { getTruncatedMessages: (messages: DiracStorageMessage[]) => messages },
		compactionStrategy: "test",
		hooksEnabled: true,
		cancelTaskOnCancellation: false,
	} as unknown as PreCompactHookParams
}

describe("PreCompact storage addresses", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-precompact-address-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("writes distinct root and sibling artifacts at the same timestamp", async () => {
		sinon.stub(Date, "now").returns(12345)
		const addresses = [rootTaskId, firstTasklet, secondTasklet]
		const files = await Promise.all(
			addresses.map((address, index) => writePreCompactContextFiles(address, history(`context-${index}`))),
		)
		for (const [index, address] of addresses.entries()) {
			const result = files[index]
			assert.equal(result.hookTimestamp, 12345)
			assert.equal(result.contextJsonPath, path.join(getTaskDirectoryPath(address), "conversation_history_12345.json"))
			assert.equal(result.contextRawPath, path.join(getTaskDirectoryPath(address), "conversation_history_12345.txt"))
			assert.deepEqual(JSON.parse(await fs.readFile(result.contextJsonPath, "utf8")), history(`context-${index}`))
			assert.match(await fs.readFile(result.contextRawPath, "utf8"), new RegExp(`context-${index}`))
		}
		const rootAlias = await writePreCompactContextFiles({ kind: "task", taskId: rootTaskId }, history("root alias"))
		assert.equal(rootAlias.contextJsonPath, files[0].contextJsonPath)
		assert.deepEqual(JSON.parse(await fs.readFile(files[1].contextJsonPath, "utf8")), history("context-1"))
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})

	for (const address of [undefined, firstTasklet, secondTasklet]) {
		it(`keeps hook identity separate from ${address?.taskletId ?? "default root"} artifact paths`, async () => {
			const taskId = address ? "logical-hook-owner" : rootTaskId
			const params = hookParams(taskId, address)
			let artifactPaths: string[] = []
			const execute = sinon.stub(HookExecutor, "executeHook").callsFake(async (options) => {
				const payload = (options as HookExecutor.HookExecutionOptions<"PreCompact">).hookInput.preCompact
				assert.equal(options.taskId, taskId)
				assert.equal(payload.taskId, taskId)
				assert.equal(payload.ulid, params.ulid)
				assert.equal(payload.contextSize, 1)
				artifactPaths = [payload.contextJsonPath, payload.contextRawPath]
				for (const artifactPath of artifactPaths) {
					assert.equal(path.dirname(artifactPath), getTaskDirectoryPath(address ?? rootTaskId))
					assert.match(await fs.readFile(artifactPath, "utf8"), /active context/)
				}
				assert.deepEqual(JSON.parse(await fs.readFile(payload.contextJsonPath, "utf8")), params.apiConversationHistory)
				return { wasCancelled: false, contextModification: "hook result" }
			})
			assert.deepEqual(await executePreCompactHookWithCleanup(params), { contextModification: "hook result" })
			assert.equal(execute.callCount, 1)
			for (const artifactPath of artifactPaths) await assert.rejects(fs.access(artifactPath), { code: "ENOENT" })
			assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
		})
	}

	for (const outcome of ["failure", "cancellation"] as const) {
		it(`cleans only addressed artifacts after hook ${outcome}`, async () => {
			const rootFiles = await writePreCompactContextFiles(rootTaskId, history("root retained"))
			const siblingFiles = await writePreCompactContextFiles(secondTasklet, history("sibling retained"))
			const error = new Error("hook failure")
			const execute = sinon.stub(HookExecutor, "executeHook")
			if (outcome === "failure") execute.rejects(error)
			else execute.resolves({ wasCancelled: true, cancel: true })
			await assert.rejects(
				executePreCompactHookWithCleanup(hookParams("logical-hook-owner", firstTasklet)),
				(caught: unknown) => (outcome === "failure" ? caught === error : caught instanceof HookCancellationError),
			)
			assert.deepEqual(await fs.readdir(getTaskDirectoryPath(firstTasklet)), [])
			for (const files of [rootFiles, siblingFiles]) {
				await fs.access(files.contextJsonPath)
				await fs.access(files.contextRawPath)
			}
		})
	}
})
