import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import {
	cleanupConversationHistoryFile,
	writeConversationHistoryJson,
	writeConversationHistoryText,
} from "../conversationHistoryFiles"
import { GlobalFileNames } from "../fileNames"
import { getTaskDirectoryPath, type TaskStorageAddress } from "../taskDirectory"
import {
	getTaskMetadata,
	readTaskSettingsFromStorage,
	saveTaskMetadata,
	updateTaskMetadata,
	writeTaskSettingsToStorage,
} from "../taskStorage"

const rootTaskId = "1700000000000"
const rootAddress: TaskStorageAddress = { kind: "task", taskId: rootTaskId }
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

function metadata(label?: string): TaskMetadata {
	return {
		files_in_context: [],
		model_usage: [],
		environment_history: [],
		...(label === undefined ? {} : { active_skill_ids: [label] }),
	}
}

function alias(address: string | TaskStorageAddress): TaskStorageAddress {
	return typeof address === "string" ? { kind: "task", taskId: address } : { ...address }
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("tasklet execution artifacts", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-tasklet-artifacts-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("saves and reads root and two siblings without fallback or top-level tasklet files", async () => {
		await saveTaskMetadata(rootAddress, metadata("root"))
		assert.deepEqual(await getTaskMetadata(rootTaskId), metadata("root"))
		assert.deepEqual(await getTaskMetadata(firstTasklet), metadata())
		await writeTaskSettingsToStorage(rootTaskId, { preferredLanguage: "root" })
		assert.deepEqual(await readTaskSettingsFromStorage(firstTasklet), {})
		await Promise.all(
			addresses.map(async (address, index) => {
				for (let round = 0; round < 3; round++) {
					const label = `${index}:${round}`
					await Promise.all([
						saveTaskMetadata(address, metadata(label)),
						writeTaskSettingsToStorage(address, { preferredLanguage: label }),
					])
					assert.deepEqual(await getTaskMetadata(alias(address)), metadata(label))
					assert.deepEqual(await readTaskSettingsFromStorage(alias(address)), { preferredLanguage: label })
				}
				const directory = getTaskDirectoryPath(address)
				assert.deepEqual(
					JSON.parse(await fs.readFile(path.join(directory, GlobalFileNames.taskMetadata), "utf8")),
					metadata(`${index}:2`),
				)
				assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8")), {
					preferredLanguage: `${index}:2`,
				})
			}),
		)
		assert.deepEqual(await fs.readdir(path.join(storageDirectory, "tasks")), [rootTaskId])
	})

	it("serializes metadata updates across root string/object aliases and fresh tasklet address objects", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				await saveTaskMetadata(address, metadata())
				await Promise.all(
					Array.from({ length: 12 }, (_, updateIndex) =>
						updateTaskMetadata(updateIndex % 2 ? alias(address) : address, async (value) => {
							await delay(1)
							value.active_skill_ids = [...(value.active_skill_ids ?? []), `${index}:${updateIndex}`]
						}),
					),
				)
				assert.deepEqual(
					(await getTaskMetadata(address)).active_skill_ids?.sort(),
					Array.from({ length: 12 }, (_, updateIndex) => `${index}:${updateIndex}`).sort(),
				)
			}),
		)
	})

	it("uses the same metadata lock for best-effort saves and updates", async () => {
		for (const address of addresses) {
			const entered = deferred()
			const release = deferred()
			const updating = updateTaskMetadata(address, async (value) => {
				entered.resolve()
				await release.promise
				value.active_skill_ids = ["update"]
			})
			await entered.promise
			let saved = false
			const saving = saveTaskMetadata(alias(address), metadata("save")).then(() => {
				saved = true
			})
			try {
				await delay(20)
				assert.equal(saved, false)
			} finally {
				release.resolve()
				await Promise.all([updating, saving])
			}
			assert.deepEqual(await getTaskMetadata(address), metadata("save"))
		}
	})

	it("does not block siblings or the same tasklet ID under a different root", async () => {
		const otherRoot: TaskStorageAddress = { ...firstTasklet, rootTaskId: "1700000000001" }
		const entered = deferred()
		const release = deferred()
		const updating = updateTaskMetadata(firstTasklet, async (value) => {
			entered.resolve()
			await release.promise
			value.active_skill_ids = ["held"]
		})
		await entered.promise
		const others = Promise.all(
			[rootTaskId, secondTasklet, otherRoot].map((address) =>
				updateTaskMetadata(address, (value) => {
					value.active_skill_ids = ["independent"]
				}),
			),
		)
		const controller = new AbortController()
		try {
			await Promise.race([
				others,
				delay(1000, undefined, { signal: controller.signal }).then(() => {
					assert.fail("An unrelated execution was blocked by a metadata lock")
				}),
			])
		} finally {
			controller.abort()
			release.resolve()
			await Promise.all([updating, others])
		}
		assert.deepEqual(await getTaskMetadata(firstTasklet), metadata("held"))
		assert.deepEqual(await getTaskMetadata(otherRoot), metadata("independent"))
	})

	it("merges concurrent settings patches across equivalent addresses without losing fields", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				await Promise.all([
					writeTaskSettingsToStorage(address, { preferredLanguage: `language-${index}` }),
					writeTaskSettingsToStorage(alias(address), { mode: "plan" }),
					writeTaskSettingsToStorage(alias(address), { planModeReasoningEffort: `plan-${index}` }),
					writeTaskSettingsToStorage(alias(address), { actModeReasoningEffort: `act-${index}` }),
				])
				await writeTaskSettingsToStorage(address, { mode: "act" })
				assert.deepEqual(await readTaskSettingsFromStorage(alias(address)), {
					preferredLanguage: `language-${index}`,
					mode: "act",
					planModeReasoningEffort: `plan-${index}`,
					actModeReasoningEffort: `act-${index}`,
				})
			}),
		)
	})

	it("isolates same-timestamp JSON/text hook outputs and cleans up only the supplied path", async () => {
		const timestamp = 12345
		const outputs = await Promise.all(
			addresses.map(async (address, index) => {
				const history = [{ role: "user" as const, content: `execution-${index}` }]
				const [json, text] = await Promise.all([
					writeConversationHistoryJson(address, history, timestamp),
					writeConversationHistoryText(alias(address), history, timestamp),
				])
				assert.equal(json, path.join(getTaskDirectoryPath(address), `conversation_history_${timestamp}.json`))
				assert.equal(text, path.join(getTaskDirectoryPath(address), `conversation_history_${timestamp}.txt`))
				assert.deepEqual(JSON.parse(await fs.readFile(json, "utf8")), history)
				assert.equal(
					await fs.readFile(text, "utf8"),
					`=== CONVERSATION HISTORY ===\n\n--- Message 1 (USER) ---\nexecution-${index}\n=== END OF CONTEXT ===\n`,
				)
				return [json, text]
			}),
		)
		assert.equal(new Set(outputs.flat()).size, 6)
		await cleanupConversationHistoryFile(outputs[1][0])
		await cleanupConversationHistoryFile(outputs[1][0])
		await assert.rejects(fs.access(outputs[1][0]), { code: "ENOENT" })
		for (const file of outputs.flat().filter((file) => file !== outputs[1][0])) await fs.access(file)
		await Promise.all(outputs.flat().map(cleanupConversationHistoryFile))
		for (const address of addresses) {
			assert.equal(
				(await fs.readdir(getTaskDirectoryPath(address))).some((file) => file.startsWith("conversation_history_")),
				false,
			)
		}
	})

	it("preserves corrupt metadata fallback and settings rejection without affecting root or sibling", async () => {
		expectLoggerErrors()
		await Promise.all(addresses.map((address) => saveTaskMetadata(address, metadata("original"))))
		await Promise.all(addresses.map((address) => writeTaskSettingsToStorage(address, { mode: "act" })))
		const directory = getTaskDirectoryPath(firstTasklet)
		await fs.writeFile(path.join(directory, GlobalFileNames.taskMetadata), "{broken")
		await fs.writeFile(path.join(directory, "settings.json"), "{broken")
		assert.deepEqual(await getTaskMetadata(firstTasklet), metadata())
		await assert.rejects(readTaskSettingsFromStorage(firstTasklet), SyntaxError)
		await assert.rejects(writeTaskSettingsToStorage(firstTasklet, { mode: "plan" }), SyntaxError)
		assert.equal(await fs.readFile(path.join(directory, "settings.json"), "utf8"), "{broken")
		await updateTaskMetadata(firstTasklet, (value) => {
			value.active_skill_ids = ["recovered-default"]
		})
		assert.deepEqual(await getTaskMetadata(firstTasklet), metadata("recovered-default"))
		for (const address of [rootTaskId, secondTasklet]) {
			assert.deepEqual(await getTaskMetadata(address), metadata("original"))
			assert.deepEqual(await readTaskSettingsFromStorage(address), { mode: "act" })
		}
	})

	it("isolates real filesystem write failures and retains legacy save/cleanup swallowing", async () => {
		expectLoggerErrors()
		await saveTaskMetadata(firstTasklet, metadata())
		const directory = getTaskDirectoryPath(firstTasklet)
		const metadataFile = path.join(directory, GlobalFileNames.taskMetadata)
		await fs.rm(metadataFile)
		await Promise.all(
			[
				metadataFile,
				path.join(directory, "settings.json"),
				path.join(directory, "conversation_history_99.json"),
				path.join(directory, "conversation_history_99.txt"),
			].map((file) => fs.mkdir(file)),
		)
		await saveTaskMetadata(firstTasklet, metadata("cannot-save"))
		await assert.rejects(updateTaskMetadata(firstTasklet, () => { }))
		await assert.rejects(readTaskSettingsFromStorage(firstTasklet))
		await assert.rejects(writeTaskSettingsToStorage(firstTasklet, { mode: "plan" }))
		await assert.rejects(writeConversationHistoryJson(firstTasklet, [], 99))
		await assert.rejects(writeConversationHistoryText(firstTasklet, [], 99))
		await cleanupConversationHistoryFile(path.join(directory, "conversation_history_99.json"))
		assert.equal((await fs.stat(path.join(directory, "conversation_history_99.json"))).isDirectory(), true)
		for (const address of [rootTaskId, secondTasklet]) {
			await saveTaskMetadata(address, metadata("unaffected"))
			await writeTaskSettingsToStorage(address, { mode: "act" })
			await writeConversationHistoryJson(address, [], 99)
			await writeConversationHistoryText(address, [], 99)
			assert.deepEqual(await getTaskMetadata(address), metadata("unaffected"))
			assert.deepEqual(await readTaskSettingsFromStorage(address), { mode: "act" })
		}
		await fs.rm(metadataFile, { recursive: true })
		await updateTaskMetadata(firstTasklet, (value) => {
			value.active_skill_ids = ["lock-released"]
		})
		assert.deepEqual(await getTaskMetadata(firstTasklet), metadata("lock-released"))
	})

	it("accepts arbitrary safe opaque child IDs for root-contained execution artifacts", async () => {
		const address: TaskStorageAddress = { ...firstTasklet, taskletId: "ordinary-task" }
		assert.equal(getTaskDirectoryPath(address), path.join(getTaskDirectoryPath(rootTaskId), "tasklets", "ordinary-task"))
		await saveTaskMetadata(address, metadata("safe opaque identity"))
		await writeTaskSettingsToStorage(address, { preferredLanguage: "opaque child" })
		assert.deepEqual(await getTaskMetadata(address), metadata("safe opaque identity"))
		assert.deepEqual(await readTaskSettingsFromStorage(address), { preferredLanguage: "opaque child" })
	})

	it("rejects invalid addresses before creating any directory, preserving best-effort metadata saves", async () => {
		expectLoggerErrors()
		const invalidAddresses: (string | TaskStorageAddress)[] = [
			firstTasklet.taskletId,
			{ kind: "task", taskId: firstTasklet.taskletId },
			{ ...firstTasklet, rootTaskId: "../escape" },
			{ ...firstTasklet, taskletId: "../escape" },
			{ ...firstTasklet, taskletId: "ordinary/task" },
		]
		for (const address of invalidAddresses) {
			await saveTaskMetadata(address, metadata("invalid"))
			await assert.rejects(getTaskMetadata(address), /Invalid .* directory identity/)
			await assert.rejects(
				updateTaskMetadata(address, () => assert.fail("Invalid address reached updater")),
				/Invalid .* directory identity/,
			)
			await assert.rejects(readTaskSettingsFromStorage(address), /Invalid .* directory identity/)
			await assert.rejects(writeTaskSettingsToStorage(address, { mode: "act" }), /Invalid .* directory identity/)
			await assert.rejects(writeConversationHistoryJson(address, [], 1), /Invalid .* directory identity/)
			await assert.rejects(writeConversationHistoryText(address, [], 1), /Invalid .* directory identity/)
		}
		assert.deepEqual(await fs.readdir(storageDirectory), [])
	})
})
