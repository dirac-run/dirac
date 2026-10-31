import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ApiConversationProviderState } from "@core/api/conversation"
import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import type { DiracStorageMessage } from "@shared/messages/content"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as sync from "@/shared/services/worker/sync"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import {
	appendApiConversationOperations,
	appendPresentationOperations,
	createApiConversationBaseline,
	createPresentationBaseline,
	getPresentationHistoryAtMessage,
	getSavedApiConversationHistory,
	getSavedApiConversationProviderState,
	getSavedApiConversationState,
	getSavedDiracMessages,
	getSavedPresentationHistory,
	saveApiConversationHistory,
	saveApiConversationProviderState,
	saveDiracMessages,
} from "../conversationHistory"
import { GlobalFileNames } from "../fileNames"
import { getTaskDirectoryPath, type TaskStorageAddress } from "../taskDirectory"

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
const addresses: (string | TaskStorageAddress)[] = [rootTaskId, firstTasklet, secondTasklet]

function apiMessages(label: string): DiracStorageMessage[] {
	return [{ role: "user", content: label }]
}

function presentationMessages(label: string): DiracMessage[] {
	return [{ id: "shared-message-id", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: label } }]
}

function providerState(label: string): ApiConversationProviderState {
	return {
		checkpoint: {
			providerId: "openai-codex",
			modelId: "test-model",
			compactedThroughHistoryIndex: 0,
			input: [{ type: "compaction", encrypted_content: label }],
		},
	}
}

describe("tasklet conversation history", () => {
	let storageDirectory: string
	let sandbox: sinon.SinonSandbox
	let enqueue: sinon.SinonStub

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-tasklet-history-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
		sandbox = sinon.createSandbox()
		enqueue = sandbox.stub()
		const worker = sync.syncWorker()
		sandbox.stub(sync, "syncWorker").returns({ ...worker, enqueue })
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("concurrently saves and restores distinct root and sibling transcripts and provider state", async () => {
		for (let round = 0; round < 3; round++) {
			await Promise.all(
				addresses.map(async (address, index) => {
					const label = `${index}:${round}`
					await Promise.all([
						saveApiConversationHistory(address, apiMessages(label)),
						saveDiracMessages(address, presentationMessages(label)),
						saveApiConversationProviderState(address, providerState(label)),
					])
					assert.deepEqual(await getSavedApiConversationHistory(address), apiMessages(label))
					assert.deepEqual(await getSavedDiracMessages(address), presentationMessages(label))
					assert.deepEqual(await getSavedApiConversationProviderState(address), providerState(label))
				}),
			)
		}
		for (const [index, address] of addresses.entries()) {
			const directory = getTaskDirectoryPath(address)
			assert.deepEqual(
				JSON.parse(await fs.readFile(path.join(directory, GlobalFileNames.apiConversationHistory), "utf8")),
				apiMessages(`${index}:2`),
			)
			assert.deepEqual(
				JSON.parse(await fs.readFile(path.join(directory, GlobalFileNames.uiMessages), "utf8")),
				presentationMessages(`${index}:2`),
			)
			assert.deepEqual(
				JSON.parse(await fs.readFile(path.join(directory, GlobalFileNames.apiConversationProviderState), "utf8")),
				providerState(`${index}:2`),
			)
		}
		assert.deepEqual((await fs.readdir(path.join(storageDirectory, "tasks"))).sort(), [rootTaskId])
	})

	it("isolates baselines, operation tails, compatibility saves, and archived checkpoint replay", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				const label = `execution-${index}`
				const messages = presentationMessages(label)
				const checkpoint: DiracMessage = {
					id: "shared-checkpoint-id",
					ts: 2,
					content: { type: DiracMessageType.CHECKPOINT },
				}
				await Promise.all([
					appendApiConversationOperations(address, [
						{ offset: 0, type: "append_message", message: apiMessages(label)[0] },
						{ offset: 1, type: "append_user_content", content: { type: "text", text: `${label}-detail` } },
					]),
					appendPresentationOperations(address, [
						{ offset: 0, type: "create", message: messages[0] },
						{ offset: 1, type: "create", message: checkpoint },
						{ offset: 2, type: "append_markdown", id: messages[0].id, text: " after-checkpoint" },
					]),
					saveApiConversationProviderState(address, providerState(label)),
				])
				const apiBaseline = await getSavedApiConversationState(address)
				const presentationBaseline = await getSavedPresentationHistory(address)
				assert.deepEqual(apiBaseline, {
					lastOffset: 1,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: label },
								{ type: "text", text: `${label}-detail` },
							],
						},
					],
				})
				assert.deepEqual(presentationBaseline, {
					lastOffset: 2,
					messages: [...presentationMessages(`${label} after-checkpoint`), checkpoint],
				})
				await Promise.all([
					createApiConversationBaseline(address, apiBaseline.messages, apiBaseline.lastOffset),
					createPresentationBaseline(address, presentationBaseline.messages, presentationBaseline.lastOffset),
				])
				const apiTail: DiracStorageMessage = { role: "assistant", content: `${label}-answer` }
				await Promise.all([
					appendApiConversationOperations(
						address,
						[{ offset: 2, type: "append_message", message: apiTail }],
						[...apiBaseline.messages, apiTail],
					),
					appendPresentationOperations(address, [
						{ offset: 3, type: "append_markdown", id: messages[0].id, text: " tail" },
					]),
				])
				assert.deepEqual(await getSavedApiConversationState(address), {
					lastOffset: 2,
					messages: [...apiBaseline.messages, apiTail],
				})
				assert.deepEqual(await getSavedPresentationHistory(address), {
					lastOffset: 3,
					messages: [...presentationMessages(`${label} after-checkpoint tail`), checkpoint],
				})
				assert.deepEqual(await getPresentationHistoryAtMessage(address, checkpoint.id), [...messages, checkpoint])
				await Promise.all([
					saveApiConversationHistory(address, apiMessages(`${label}-reset`)),
					saveDiracMessages(address, presentationMessages(`${label}-reset`)),
				])
				assert.deepEqual(await getSavedApiConversationState(address), {
					lastOffset: 3,
					messages: apiMessages(`${label}-reset`),
				})
				assert.deepEqual(await getSavedPresentationHistory(address), {
					lastOffset: 4,
					messages: presentationMessages(`${label}-reset`),
				})
				assert.deepEqual(await getPresentationHistoryAtMessage(address, checkpoint.id), [...messages, checkpoint])
				assert.deepEqual(await getSavedApiConversationProviderState(address), providerState(label))
				const files = await fs.readdir(getTaskDirectoryPath(address))
				assert.ok(files.includes(`${GlobalFileNames.apiConversationHistoryOperations}.archive.1`))
				assert.ok(files.includes(`${GlobalFileNames.uiMessageOperations}.archive.2`))
			}),
		)
	})

	it("treats explicit root addresses exactly like ordinary string roots", async () => {
		const address: TaskStorageAddress = { kind: "task", taskId: rootTaskId }
		await saveApiConversationHistory(address, apiMessages("root"))
		await saveDiracMessages(address, presentationMessages("root"))
		await saveApiConversationProviderState(address, providerState("root"))
		assert.equal(getTaskDirectoryPath(address), getTaskDirectoryPath(rootTaskId))
		assert.deepEqual(await getSavedApiConversationHistory(rootTaskId), apiMessages("root"))
		assert.deepEqual(await getSavedDiracMessages(rootTaskId), presentationMessages("root"))
		assert.deepEqual(await getSavedApiConversationProviderState(rootTaskId), providerState("root"))
		assert.deepEqual(enqueue.args, [
			[rootTaskId, GlobalFileNames.apiConversationHistory, JSON.stringify(apiMessages("root"))],
			[rootTaskId, GlobalFileNames.apiConversationProviderState, JSON.stringify(providerState("root"))],
		])
	})

	it("never falls back to root or sibling data for an empty tasklet", async () => {
		await saveApiConversationHistory(rootTaskId, apiMessages("root"))
		await saveDiracMessages(rootTaskId, presentationMessages("root"))
		await saveApiConversationProviderState(secondTasklet, providerState("sibling"))
		assert.deepEqual(await getSavedApiConversationState(firstTasklet), { messages: [], lastOffset: -1 })
		assert.deepEqual(await getSavedPresentationHistory(firstTasklet), { messages: [], lastOffset: -1 })
		assert.deepEqual(await getSavedApiConversationProviderState(firstTasklet), {})
		await assert.rejects(getPresentationHistoryAtMessage(firstTasklet, "shared-message-id"), /is absent/)
	})

	it("qualifies the same tasklet ID by its owning root for local and sync storage", async () => {
		const otherRoot: TaskStorageAddress = { ...firstTasklet, rootTaskId: "1700000000001" }
		await Promise.all([
			saveApiConversationHistory(firstTasklet, apiMessages("first root")),
			saveApiConversationHistory(otherRoot, apiMessages("other root")),
		])
		assert.deepEqual(await getSavedApiConversationHistory(firstTasklet), apiMessages("first root"))
		assert.deepEqual(await getSavedApiConversationHistory(otherRoot), apiMessages("other root"))
		assert.deepEqual(
			new Set(enqueue.args.map(([taskId, key]) => `${taskId}/${key}`)),
			new Set([
				`${rootTaskId}/tasklets/${firstTasklet.taskletId}/${GlobalFileNames.apiConversationHistory}`,
				`${otherRoot.rootTaskId}/tasklets/${otherRoot.taskletId}/${GlobalFileNames.apiConversationHistory}`,
			]),
		)
	})

	it("maps legacy, incremental, and provider sync writes to distinct root-qualified keys", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				const label = `sync-${index}`
				await saveApiConversationHistory(address, apiMessages(label))
				await appendApiConversationOperations(
					address,
					[{ offset: 0, type: "reset", messages: apiMessages(`${label}-tail`) }],
					apiMessages(`${label}-tail`),
				)
				await saveApiConversationProviderState(address, providerState(label))
				await saveDiracMessages(address, presentationMessages(label))
			}),
		)
		assert.equal(enqueue.callCount, 9)
		for (const [index, address] of addresses.entries()) {
			const prefix = typeof address === "string" || address.kind === "task" ? "" : `tasklets/${address.taskletId}/`
			const label = `sync-${index}`
			const calls = enqueue.args.filter(
				([, key]) =>
					key === `${prefix}${GlobalFileNames.apiConversationHistory}` ||
					key === `${prefix}${GlobalFileNames.apiConversationProviderState}`,
			)
			assert.deepEqual(calls, [
				[rootTaskId, `${prefix}${GlobalFileNames.apiConversationHistory}`, JSON.stringify(apiMessages(label))],
				[rootTaskId, `${prefix}${GlobalFileNames.apiConversationHistory}`, JSON.stringify(apiMessages(`${label}-tail`))],
				[rootTaskId, `${prefix}${GlobalFileNames.apiConversationProviderState}`, JSON.stringify(providerState(label))],
			])
		}
	})

	for (const address of [
		"../escape",
		firstTasklet.taskletId,
		{ kind: "task", taskId: "../escape" },
		{ ...firstTasklet, rootTaskId: "../escape" },
		{ ...firstTasklet, taskletId: "../escape" },
	] satisfies (string | TaskStorageAddress)[]) {
		it(`rejects invalid identity ${JSON.stringify(address)} before any sync enqueue`, async () => {
			expectLoggerErrors()
			const operations = [
				() => getSavedApiConversationHistory(address),
				() => getSavedApiConversationState(address),
				() =>
					appendApiConversationOperations(
						address,
						[{ offset: 0, type: "reset", messages: apiMessages("invalid") }],
						apiMessages("invalid"),
					),
				() => createApiConversationBaseline(address, [], -1),
				() => getSavedApiConversationProviderState(address),
				() => saveApiConversationProviderState(address, providerState("invalid")),
				() => saveApiConversationHistory(address, apiMessages("invalid")),
				() => getSavedDiracMessages(address),
				() => getSavedPresentationHistory(address),
				() => appendPresentationOperations(address, []),
				() => createPresentationBaseline(address, [], -1),
				() => getPresentationHistoryAtMessage(address, "checkpoint"),
				() => saveDiracMessages(address, []),
			]
			for (const operation of operations) await assert.rejects(operation, /Invalid task(?:let)? directory identity/)
			assert.equal(enqueue.callCount, 0)
			assert.deepEqual(await fs.readdir(storageDirectory), [])
		})
	}

	it("surfaces a tasklet API save failure without changing its transcript or other executions", async () => {
		expectLoggerErrors()
		await Promise.all(addresses.map((address, index) => saveApiConversationHistory(address, apiMessages(`before-${index}`))))
		const failedPath = path.join(getTaskDirectoryPath(firstTasklet), GlobalFileNames.apiConversationHistory)
		const failure = new Error("injected API rename failure")
		const rename = fs.rename.bind(fs)
		sandbox.stub(fs, "rename").callsFake(async (source, destination) => {
			if (destination === failedPath) throw failure
			return rename(source, destination)
		})
		await Promise.all([
			assert.rejects(saveApiConversationHistory(firstTasklet, apiMessages("failed")), (error) => error === failure),
			saveApiConversationHistory(rootTaskId, apiMessages("root-after")),
			saveApiConversationHistory(secondTasklet, apiMessages("sibling-after")),
		])
		assert.deepEqual(await getSavedApiConversationHistory(firstTasklet), apiMessages("before-1"))
		assert.deepEqual(await getSavedApiConversationHistory(rootTaskId), apiMessages("root-after"))
		assert.deepEqual(await getSavedApiConversationHistory(secondTasklet), apiMessages("sibling-after"))
	})

	for (const kind of ["api", "presentation"] as const) {
		it(`surfaces a tasklet ${kind} append failure without changing other execution logs`, async () => {
			const append = (address: string | TaskStorageAddress, label: string, offset: number) =>
				kind === "api"
					? appendApiConversationOperations(
							address,
							[{ offset, type: "reset", messages: apiMessages(label) }],
							apiMessages(label),
						)
					: appendPresentationOperations(address, [{ offset, type: "reset", messages: presentationMessages(label) }])
			await Promise.all(addresses.map((address, index) => append(address, `before-${index}`, 0)))
			const fileName =
				kind === "api" ? GlobalFileNames.apiConversationHistoryOperations : GlobalFileNames.uiMessageOperations
			const failedPath = path.join(getTaskDirectoryPath(firstTasklet), fileName)
			const failure = new Error(`injected ${kind} append failure`)
			const appendFile = fs.appendFile.bind(fs)
			sandbox.stub(fs, "appendFile").callsFake(async (file, data, options) => {
				if (file === failedPath) throw failure
				return appendFile(file, data, options)
			})
			enqueue.resetHistory()
			await Promise.all([
				assert.rejects(append(firstTasklet, "failed", 1), (error) => error === failure),
				append(rootTaskId, "root-after", 1),
				append(secondTasklet, "sibling-after", 1),
			])
			for (const [address, label, lastOffset] of [
				[firstTasklet, "before-1", 0],
				[rootTaskId, "root-after", 1],
				[secondTasklet, "sibling-after", 1],
			] as const) {
				const state =
					kind === "api" ? await getSavedApiConversationState(address) : await getSavedPresentationHistory(address)
				assert.deepEqual(state, {
					lastOffset,
					messages: kind === "api" ? apiMessages(label) : presentationMessages(label),
				})
			}
			assert.equal(enqueue.callCount, kind === "api" ? 2 : 0)
			assert.ok(enqueue.args.every(([, key]) => !key.includes(firstTasklet.taskletId)))
		})
	}

	it("surfaces a tasklet provider write failure without changing its saved state or other executions", async () => {
		await Promise.all(
			addresses.map((address, index) => saveApiConversationProviderState(address, providerState(`before-${index}`))),
		)
		const failedPath = path.join(getTaskDirectoryPath(firstTasklet), GlobalFileNames.apiConversationProviderState)
		const failure = new Error("injected provider rename failure")
		const rename = fs.rename.bind(fs)
		sandbox.stub(fs, "rename").callsFake(async (source, destination) => {
			if (destination === failedPath) throw failure
			return rename(source, destination)
		})
		await Promise.all([
			assert.rejects(saveApiConversationProviderState(firstTasklet, providerState("failed")), (error) => error === failure),
			saveApiConversationProviderState(rootTaskId, providerState("root-after")),
			saveApiConversationProviderState(secondTasklet, providerState("sibling-after")),
		])
		assert.deepEqual(await getSavedApiConversationProviderState(firstTasklet), providerState("before-1"))
		assert.deepEqual(await getSavedApiConversationProviderState(rootTaskId), providerState("root-after"))
		assert.deepEqual(await getSavedApiConversationProviderState(secondTasklet), providerState("sibling-after"))
	})

	it("surfaces a tasklet provider read failure while root and sibling reads and saves succeed", async () => {
		await Promise.all(
			addresses.map((address, index) => saveApiConversationProviderState(address, providerState(`before-${index}`))),
		)
		const failedPath = path.join(getTaskDirectoryPath(firstTasklet), GlobalFileNames.apiConversationProviderState)
		const failure = new Error("injected provider read failure")
		const readFile = fs.readFile.bind(fs)
		// All non-targeted filesystem reads still use real files.
		const readFileStub = sandbox.stub(fs, "readFile").callThrough()
		readFileStub.withArgs(failedPath, "utf8").rejects(failure)
		await Promise.all([
			assert.rejects(getSavedApiConversationProviderState(firstTasklet), (error) => error === failure),
			saveApiConversationProviderState(rootTaskId, providerState("root-after")),
			saveApiConversationProviderState(secondTasklet, providerState("sibling-after")),
		])
		assert.deepEqual(await getSavedApiConversationProviderState(rootTaskId), providerState("root-after"))
		assert.deepEqual(await getSavedApiConversationProviderState(secondTasklet), providerState("sibling-after"))
		assert.deepEqual(JSON.parse(await readFile(failedPath, "utf8")), providerState("before-1"))
	})

	it("keeps corrupt tasklet transcript reads isolated from healthy root and sibling transcripts", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				await saveApiConversationHistory(address, apiMessages(`before-${index}`))
				await appendPresentationOperations(address, [
					{ offset: 0, type: "create", message: presentationMessages(`before-${index}`)[0] },
				])
			}),
		)
		const directory = getTaskDirectoryPath(firstTasklet)
		await fs.writeFile(path.join(directory, GlobalFileNames.apiConversationHistory), "not JSON")
		await fs.writeFile(path.join(directory, GlobalFileNames.uiMessageOperations), "not JSON\n")
		await assert.rejects(getSavedApiConversationHistory(firstTasklet), SyntaxError)
		await assert.rejects(getSavedPresentationHistory(firstTasklet), /Invalid operation record/)
		for (const [index, address] of [
			[0, rootTaskId],
			[2, secondTasklet],
		] as const) {
			assert.deepEqual(await getSavedApiConversationHistory(address), apiMessages(`before-${index}`))
			assert.deepEqual(await getSavedDiracMessages(address), presentationMessages(`before-${index}`))
		}
	})
})
