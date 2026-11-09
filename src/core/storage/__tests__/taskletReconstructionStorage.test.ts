import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { CardKind, CardStatus } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import { GlobalFileNames } from "../fileNames"
import { getTaskDirectoryPath } from "../taskDirectory"
import {
	loadTaskletEvents,
	loadTaskletRecords,
	rebindCopiedTaskletRecords,
	saveTaskletEvents,
	saveTaskletRecord,
	type TaskletEvent,
	type TaskletRecord,
} from "../taskStorage"

const firstId = "tasklet_00000000-0000-4000-8000-000000000001"
const secondId = "tasklet_00000000-0000-4000-8000-000000000002"
const address = (rootTaskId = "root", taskletId = firstId) => ({ kind: "tasklet" as const, rootTaskId, taskletId })
const record = (rootTaskId = "root", id = firstId): TaskletRecord => ({
	id,
	rootTaskId,
	conversationUlid: "retained-conversation",
	title: "Private child",
	prompt: "Original work",
	createdAt: 123,
})

/** Real temporary filesystem coverage; no Task/host or execution is constructed. */
describe("tasklet reconstruction storage", () => {
	let directory: string

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-reconstruction-storage-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("retains exact command grants on reload but strips them when copying to another root", async () => {
		const commandGrants = { version: 1 as const, grants: [{ identity: { kind: "command" as const, command: "npm test", cwd: "/workspace" }, restrictions: ["explicit exception"] }] }
		await saveTaskletRecord({ ...record(), commandGrants })
		assert.deepEqual((await loadTaskletRecords("root"))[0].commandGrants, commandGrants)
		await fs.cp(getTaskDirectoryPath("root"), getTaskDirectoryPath("fork"), { recursive: true })
		await rebindCopiedTaskletRecords("root", "fork")
		assert.equal((await loadTaskletRecords("fork"))[0].commandGrants, undefined)
		assert.deepEqual((await loadTaskletRecords("root"))[0].commandGrants, commandGrants)
	})

	it("accepts legacy records without grants and rejects malformed durable command authority", async () => {
		await saveTaskletRecord(record())
		assert.equal((await loadTaskletRecords("root"))[0].commandGrants, undefined)
		const file = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletRecord)
		for (const commandGrants of [{ version: 2, grants: [] }, { version: 1, grants: [{}] }, null]) {
			await fs.writeFile(file, JSON.stringify({ ...record(), commandGrants }))
			await assert.rejects(loadTaskletRecords("root"), /Invalid tasklet record/)
		}
	})

	it("persists current and legacy scientist IDs under their owning roots", async () => {
		const ids = ["Gödel", "vonNeumann", "deBroglie", "Planck2", "von Neumann", "de Broglie", "Planck 2"]
		for (const id of ids) {
			await saveTaskletRecord(record("root", id))
			await saveTaskletRecord({ ...record("other", id), title: "Other assignment" })
		}
		const first = await loadTaskletRecords("root")
		const other = await loadTaskletRecords("other")
		assert.deepEqual(first.map((child) => child.id).sort(), [...ids].sort())
		assert.deepEqual(other.map((child) => child.id).sort(), [...ids].sort())
		assert.ok(first.every((child) => child.rootTaskId === "root" && child.title === "Private child"))
		assert.ok(other.every((child) => child.rootTaskId === "other" && child.title === "Other assignment"))
		const file = path.join(getTaskDirectoryPath(address("root", "Planck 2")), GlobalFileNames.taskletRecord)
		await fs.writeFile(file, JSON.stringify(record("other", "Planck 2")))
		await assert.rejects(loadTaskletRecords("root"), /Invalid tasklet record/)
	})

	it("migrates retired options without changing saved identity, selection or conversation", async () => {
		const selection = { provider: "anthropic", modelId: "claude-opus-4-6", reasoningEffort: "high" }
		await saveTaskletRecord({
			...record(), configuration: {
				name: "Deleted reviewer", modelSelection: selection, timeoutSeconds: 600,
				includeHistory: true, systemPrompt: "Retired", allowedTools: ["read_file"], skills: ["old"],
			}
		} as unknown as TaskletRecord)
		const conversation = path.join(getTaskDirectoryPath(address()), "api_conversation_history.json")
		await fs.writeFile(conversation, "retained child conversation bytes")
		const [loaded] = await loadTaskletRecords("root")
		assert.deepEqual(loaded.configuration, { name: "Deleted reviewer", modelSelection: selection })
		assert.equal(loaded.role, "Deleted reviewer")
		assert.equal(loaded.id, firstId)
		assert.equal(loaded.conversationUlid, "retained-conversation")
		await saveTaskletRecord(loaded)
		assert.deepEqual((await loadTaskletRecords("root"))[0], loaded)
		assert.equal(await fs.readFile(conversation, "utf8"), "retained child conversation bytes")
	})

	it("recovers an explicit child-local model but never invents an unknown role or provider default", async () => {
		await saveTaskletRecord(record())
		const settingsFile = path.join(getTaskDirectoryPath(address()), "settings.json")
		await fs.writeFile(settingsFile, JSON.stringify({
			actModeApiProvider: "openai", actModeOpenAiModelId: "saved-local-model",
			actModeOpenAiProfileName: "Local", actModeReasoningEffort: "none", actModeThinkingBudgetTokens: 0,
			apiKey: "must-not-be-captured", subagentRoles: [{ name: "Current", modelSelection: { modelId: "wrong" } }],
		}))
		const [loaded] = await loadTaskletRecords("root")
		assert.deepEqual(loaded.configuration, {
			modelSelection: {
				provider: "openai", modelId: "saved-local-model", openAiProfileName: "Local", reasoningEffort: "none", thinkingBudgetTokens: 0,
			}
		})
		assert.equal(loaded.role, undefined)
		await fs.writeFile(settingsFile, JSON.stringify({ actModeApiProvider: "anthropic", planModeApiModelId: "not-the-child-model" }))
		assert.equal((await loadTaskletRecords("root"))[0].configuration, undefined)
	})

	it("returns empty missing collections/events without creating storage", async () => {
		assert.deepEqual(await loadTaskletRecords("root"), [])
		assert.deepEqual(await loadTaskletEvents(address()), [])
		assert.deepEqual(await fs.readdir(directory), [])
	})

	it("loads only contained records from the requested root, retaining outcome and identity", async () => {
		const first = record()
		const second = {
			...record("root", secondId),
			outcome: { kind: "completed" as const, completedAt: 456, response: "done" },
		}
		await Promise.all([saveTaskletRecord(first), saveTaskletRecord(second), saveTaskletRecord(record("other"))])
		await fs.writeFile(path.join(getTaskDirectoryPath("root"), "tasklets", "README.txt"), "not a child")
		const loaded = await loadTaskletRecords("root")
		assert.deepEqual(
			loaded.sort((a, b) => a.id.localeCompare(b.id)),
			[first, second],
		)
		loaded[0].prompt = "local mutation"
		assert.equal((await loadTaskletRecords("root")).find((value) => value.id === firstId)?.prompt, first.prompt)
		assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["other", "root"])
	})

	it("rebinds the copied records, retaining the snapshot rather than rereading the live source", async () => {
		const original = record()
		await saveTaskletRecord(original)
		const sourceDirectory = getTaskDirectoryPath("root")
		const copiedDirectory = getTaskDirectoryPath("fork")
		await fs.cp(sourceDirectory, copiedDirectory, { recursive: true })
		const copiedRecord = {
			...original,
			outcome: { kind: "completed" as const, response: "Copied result", completedAt: 456 },
		}
		await fs.writeFile(path.join(getTaskDirectoryPath(address("fork")), GlobalFileNames.taskletRecord), JSON.stringify(copiedRecord))
		await rebindCopiedTaskletRecords("root", "fork")
		assert.deepEqual(await loadTaskletRecords("fork"), [{ ...copiedRecord, rootTaskId: "fork" }])
		assert.deepEqual(await loadTaskletRecords("root"), [original])
	})

	it("rejects a copied record with unexpected ownership without rewriting it", async () => {
		await saveTaskletRecord(record("fork"))
		const file = path.join(getTaskDirectoryPath(address("fork")), GlobalFileNames.taskletRecord)
		const bytes = await fs.readFile(file)
		await assert.rejects(rebindCopiedTaskletRecords("root", "fork"), /Invalid tasklet record/)
		assert.deepEqual(await fs.readFile(file), bytes)
	})

	it("roundtrips every communication variant without losing settlement or wait evidence", async () => {
		type Communication = TaskletEvent["communication"]
		const variants = {
			waiting_for_message: { type: "waiting_for_message" },
			response: { type: "response", response: { operation: ResponseOperation.PROGRESS, text: "Still working" } },
			message: { type: "message", message: { taskletId: firstId, type: "guidance", text: "Continue" } },
			lifecycle: { type: "lifecycle", state: "accepted" },
			interaction: {
				type: "interaction", request: {
					id: "request", createdAt: 125, status: "pending",
					card: { id: "card", kind: CardKind.GENERIC, header: "Question", body: "Full request", status: CardStatus.WAITING_FOR_INPUT, renderType: "text", requireApproval: true },
				}
			},
			outcome: { type: "outcome", outcome: { kind: "completed", completedAt: 126, response: "Done" } },
		} satisfies { [Type in Communication["type"]]: Extract<Communication, { type: Type }> }
		const events: TaskletEvent[] = Object.values(variants).map((communication, index) => ({
			id: `event-${index}`, taskletId: firstId, createdAt: 124 + index, deliveredAt: 150, communication,
		}))
		events.push({ id: "resumed", taskletId: firstId, createdAt: 151, communication: { type: "lifecycle", state: "resumed", assignment: "Next work" } })
		await saveTaskletEvents(address(), events)
		assert.deepEqual(await loadTaskletEvents(address()), events)
	})

	it("retains full events, delivery receipts and pending/resolved/retired request history unchanged", async () => {
		const events: TaskletEvent[] = [
			{
				id: "result",
				taskletId: firstId,
				createdAt: 124,
				deliveredAt: 150,
				communication: {
					type: "response",
					response: { operation: ResponseOperation.COMPLETE, text: "detail".repeat(2000) },
				},
			},
			...(["pending", "resolved", "retired"] as const).map(
				(status, index): TaskletEvent => ({
					id: `request-${index}`,
					taskletId: firstId,
					createdAt: 125 + index,
					communication: {
						type: "interaction",
						request: {
							id: `request-${index}`,
							createdAt: 125 + index,
							status,
							card: {
								id: `card-${index}`,
								kind: CardKind.GENERIC,
								header: "Question",
								body: "Keep full request",
								status: CardStatus.WAITING_FOR_INPUT,
								renderType: "text",
								requireApproval: true,
							},
						},
					},
				}),
			),
		]
		await saveTaskletEvents(address(), events)
		assert.deepEqual(await loadTaskletEvents(address()), events)
		assert.deepEqual(await loadTaskletEvents(address("other")), [])
		assert.deepEqual(await loadTaskletEvents(address("root", secondId)), [])
	})

	it("rejects record root/id mismatches and missing required identity data", async () => {
		await saveTaskletRecord(record())
		const file = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletRecord)
		for (const invalid of [
			{ ...record(), id: secondId },
			{ ...record(), rootTaskId: "other" },
			{ ...record(), conversationUlid: "" },
			{ ...record(), prompt: 1 },
			null,
			[],
		]) {
			await fs.writeFile(file, JSON.stringify(invalid))
			await assert.rejects(loadTaskletRecords("root"), /Invalid tasklet record/)
		}
	})

	it("rejects malformed committed records but skips directories whose admission record is missing", async () => {
		await saveTaskletRecord(record())
		const file = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletRecord)
		await fs.writeFile(file, "{broken")
		await assert.rejects(loadTaskletRecords("root"), SyntaxError)
		await fs.rm(file)
		assert.deepEqual(await loadTaskletRecords("root"), [])
	})

	it("rejects malformed or cross-tasklet events without changing stored contents", async () => {
		await saveTaskletRecord(record())
		const file = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletEvents)
		for (const invalid of [
			{},
			null,
			[null],
			[{ id: "event", taskletId: secondId, createdAt: 1, communication: { type: "response", response: {} } }],
			[{ id: "event", taskletId: firstId, createdAt: 1, communication: { type: "other" } }],
			[
				{
					id: "event",
					taskletId: firstId,
					createdAt: 1,
					communication: { type: "interaction", request: { id: "request", status: "unknown" } },
				},
			],
		]) {
			const contents = JSON.stringify(invalid)
			await fs.writeFile(file, contents)
			await assert.rejects(loadTaskletEvents(address()), /Invalid tasklet events/)
			assert.equal(await fs.readFile(file, "utf8"), contents)
		}
		await fs.writeFile(file, "{broken")
		await assert.rejects(loadTaskletEvents(address()), SyntaxError)
	})

	it("does not mistake a present dangling record symlink for an uncommitted directory", async () => {
		await saveTaskletRecord(record())
		const file = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletRecord)
		await fs.rm(file)
		await fs.symlink(path.join(directory, "missing-record-target"), file)
		await assert.rejects(loadTaskletRecords("root"), { code: "ENOENT" })
		assert.equal((await fs.lstat(file)).isSymbolicLink(), true)
	})

	it("propagates non-absence filesystem errors from collection, record and event reads", async () => {
		await fs.mkdir(getTaskDirectoryPath("root"), { recursive: true })
		const collection = path.join(getTaskDirectoryPath("root"), "tasklets")
		await fs.writeFile(collection, "not a directory")
		await assert.rejects(loadTaskletRecords("root"), { code: "ENOTDIR" })
		await fs.rm(collection)
		await saveTaskletRecord(record())
		const recordFile = path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletRecord)
		await fs.rm(recordFile)
		await fs.mkdir(recordFile)
		await assert.rejects(loadTaskletRecords("root"), { code: "EISDIR" })
		await fs.mkdir(path.join(getTaskDirectoryPath(address()), GlobalFileNames.taskletEvents))
		await assert.rejects(loadTaskletEvents(address()), { code: "EISDIR" })
	})

	it("rejects invalid root/tasklet addresses before any reads create directories", async () => {
		await assert.rejects(loadTaskletRecords("../escape"), /Invalid task directory identity/)
		await assert.rejects(loadTaskletRecords(firstId), /Invalid task directory identity/)
		await assert.rejects(loadTaskletEvents(address("root", "../escape")), /Invalid tasklet directory identity/)
		assert.deepEqual(await fs.readdir(directory), [])
	})

	it("ignores real partial child directories without deleting their files or hiding committed siblings", async () => {
		await saveTaskletRecord(record())
		const partial = getTaskDirectoryPath(address("root", "Partial"))
		await fs.mkdir(partial, { recursive: true })
		const temporaryRecord = path.join(partial, `${GlobalFileNames.taskletRecord}.tmp.crash.json`)
		await fs.writeFile(temporaryRecord, "{interrupted atomic write")
		await fs.writeFile(path.join(partial, "settings.json"), "{unfinished settings")
		assert.deepEqual(await loadTaskletRecords("root"), [record()])
		assert.equal(await fs.readFile(temporaryRecord, "utf8"), "{interrupted atomic write")
		assert.equal(await fs.readFile(path.join(partial, "settings.json"), "utf8"), "{unfinished settings")
	})
})
