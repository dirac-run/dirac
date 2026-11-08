import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import type { Controller } from ".."
import { CardStatus, DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { TaskletInventoryRequest, TaskletTranscriptRequest } from "@shared/proto/dirac/task"
import type { TaskletInventoryPage, TaskletInventoryRow, TaskletTranscriptPage } from "@shared/taskletObservation"
import { getTaskletInventory } from "./getTaskletInventory"
import { getTaskletTranscript } from "./getTaskletTranscript"
import { OBSERVATION_PAGE_BYTES } from "./taskletObservation"
import { saveTaskletEvents, saveTaskletRecord } from "@core/storage/taskStorage"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { createTaskletFixtureId as createTaskletId } from "@/test/taskletFixtures"

const ROOT = "observation-root"
const text = (id: string, content = id): DiracMessage => ({ id, ts: 1, content: { type: DiracMessageType.MARKDOWN, content } })
const request = (overrides: Partial<TaskletInventoryRequest> = {}) =>
	TaskletInventoryRequest.create({ rootTaskId: ROOT, filter: "active", ...overrides })

describe("passive tasklet UI observation", () => {
	it("pages sixteen lifecycle rows and rejects changed or cross-source cursors", async () => {
		const rows: TaskletInventoryRow[] = Array.from({ length: 16 }, (_, index) => ({
			taskletId: `child-${index.toString().padStart(2, "0")}`,
			title: `Worker ${index}`,
			state: index === 2 ? "waiting_for_parent" : index === 3 ? "settlement_failed" : "running",
		}))
		let sourceId = "live:first"
		const controller = {
			selectedTaskletObservation: () => ({
				rootTaskId: ROOT,
				sourceId,
				availability: "live",
				host: {
					observationInventory: () => rows.slice(),
				},
			}),
		} as unknown as Controller
		const page = JSON.parse((await getTaskletInventory(controller, request({ limit: 5 }))).value) as TaskletInventoryPage
		assert.equal(page.totalItems, 16)
		assert.equal(page.items.length, 5)
		assert.equal(page.items[2].state, "waiting_for_parent")
		assert.equal(page.items[3].state, "settlement_failed")
		const next = JSON.parse(
			(await getTaskletInventory(controller, request({ limit: 5, cursor: page.nextCursor }))).value,
		) as TaskletInventoryPage
		assert.equal(next.items[0].taskletId, "child-05")
		rows[0] = { ...rows[0], state: "completed" }
		await assert.rejects(getTaskletInventory(controller, request({ cursor: page.nextCursor })), /changed/)
		sourceId = "live:second"
		await assert.rejects(getTaskletInventory(controller, request({ sourceId: page.sourceId })), /source changed/)
		await assert.rejects(getTaskletInventory(controller, request({ rootTaskId: "other" })), /root changed/)
	})

	it("returns bounded inert transcript pages and rejects incompatible transcript revisions", async () => {
		let offset = 1
		const messages: DiracMessage[] = [
			{
				id: "approval",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "approval",
						header: "Private approval",
						body: "\u0000".repeat(100_000),
						status: CardStatus.WAITING_FOR_INPUT,
						renderType: "markdown",
						requireApproval: true,
						requireFeedback: true,
						actions: [{ label: "Approve", value: "approve" }],
						rawInput: { secret: "never transport" },
						locations: [{ path: "/private" }],
					},
				},
			},
			...Array.from({ length: 20 }, (_, index) => text(`message-${index}`, "large".repeat(10_000))),
		]
		const controller = {
			selectedTaskletObservation: () => ({
				rootTaskId: ROOT,
				sourceId: "live:host",
				availability: "live",
				host: {
					readObservationTranscript: async () => ({
						title: "Worker",
						state: "waiting_for_parent",
						messages,
						presentationGeneration: 0,
						presentationOffset: offset,
						outcome: undefined,
					}),
				},
			}),
		} as unknown as Controller
		const req = TaskletTranscriptRequest.create({ rootTaskId: ROOT, taskletId: "child", limit: 50 })
		const response = await getTaskletTranscript(controller, req)
		assert.ok(Buffer.byteLength(response.value) <= OBSERVATION_PAGE_BYTES)
		const page = JSON.parse(response.value) as TaskletTranscriptPage
		assert.ok(page.nextCursor)
		assert.ok(page.truncatedMessageIds.includes("approval"))
		const card = page.messages[0].content
		assert.equal(card.type, "card")
		if (card.type === "card") assert.deepEqual(Object.keys(card.card).sort(), ["body", "header", "id", "status"])
		assert.equal(response.value.includes("never transport"), false)
		offset++
		await assert.rejects(getTaskletTranscript(controller, { ...req, cursor: page.nextCursor }), /changed/)
	})

	it("discards an async transcript read when the selected root changes", async () => {
		let rootTaskId = ROOT
		const controller = {
			selectedTaskletObservation: () => ({
				rootTaskId,
				sourceId: "live:host",
				availability: "live",
				host: {
					readObservationTranscript: async () => {
						rootTaskId = "new-root"
						return {
							title: "Worker",
							state: "running",
							messages: [],
							presentationGeneration: 0,
							presentationOffset: 0,
						}
					},
				},
			}),
		} as unknown as Controller
		await assert.rejects(
			getTaskletTranscript(controller, TaskletTranscriptRequest.create({ rootTaskId: ROOT, taskletId: "child" })),
			/root changed/,
		)
	})
})

describe("saved tasklet observation has no persistence effects", () => {
	let storagePath: string
	const controller = {
		selectedTaskletObservation: () => ({ rootTaskId: ROOT, sourceId: `saved:${ROOT}`, availability: "saved" }),
	} as unknown as Controller
	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-observation-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})
	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("does not create directories to observe an empty saved root", async () => {
		const page = JSON.parse((await getTaskletInventory(controller, request({ filter: "all" }))).value) as TaskletInventoryPage
		assert.equal(page.availability, "saved")
		assert.deepEqual(page.items, [])
		assert.deepEqual(await fs.readdir(storagePath), [])
	})

	it("requires matching outcome evidence and never backs up or repairs malformed legacy presentation", async () => {
		const id = createTaskletId()
		const outcome = { kind: "completed" as const, response: "Finished", completedAt: 2 }
		await saveTaskletRecord({
			id,
			rootTaskId: ROOT,
			conversationUlid: "conversation",
			title: "Saved worker",
			prompt: "Do work",
			createdAt: 1,
			outcome,
		})
		let page = JSON.parse((await getTaskletInventory(controller, request({ filter: "all" }))).value) as TaskletInventoryPage
		assert.equal(page.items[0].state, "unsettled")
		const address = { kind: "tasklet" as const, rootTaskId: ROOT, taskletId: id }
		await saveTaskletEvents(address, [
			{ id: "outcome", taskletId: id, createdAt: 2, communication: { type: "outcome", outcome } },
		])
		page = JSON.parse((await getTaskletInventory(controller, request({ filter: "all" }))).value) as TaskletInventoryPage
		assert.equal(page.items[0].state, "completed")
		const directory = getTaskDirectoryPath(address)
		const legacy = path.join(directory, "ui_messages.json")
		await fs.writeFile(legacy, JSON.stringify([text("valid"), { unreadable: true }]))
		const before = await fs.readdir(directory)
		const bytes = await fs.readFile(legacy)
		await assert.rejects(
			getTaskletTranscript(controller, TaskletTranscriptRequest.create({ rootTaskId: ROOT, taskletId: id })),
			/unreadable/,
		)
		assert.deepEqual(await fs.readdir(directory), before)
		assert.deepEqual(await fs.readFile(legacy), bytes)
		await fs.writeFile(legacy, JSON.stringify([text("valid")]))
		const result = JSON.parse(
			(await getTaskletTranscript(controller, TaskletTranscriptRequest.create({ rootTaskId: ROOT, taskletId: id }))).value,
		) as TaskletTranscriptPage
		assert.equal(result.outcome?.summary, "Finished")
		assert.equal(result.messages.length, 1)
	})
})
