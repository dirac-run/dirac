import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracContext } from "../DiracContext"

const TASK_ID = "context-persistence"
const CONVERSATION_ID = "context-conversation"

function contextFile(diracHome: string): string {
	return path.join(diracHome, "data", "tasks", TASK_ID, "tool_context.json")
}

function operationFile(diracHome: string): string {
	return path.join(diracHome, "data", "tasks", TASK_ID, "tool_context.jsonl")
}

describe("DiracContext persistence", () => {
	let diracHome: string
	let previousDiracHome: string | undefined
	let stateManager: { flushPendingState: sinon.SinonStub }

	beforeEach(async () => {
		diracHome = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-context-"))
		previousDiracHome = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = diracHome
		stateManager = { flushPendingState: sinon.stub().resolves() }
		AnchorStateManager.reset(CONVERSATION_ID)
	})

	afterEach(async () => {
		AnchorStateManager.reset(CONVERSATION_ID)
		if (previousDiracHome === undefined) delete process.env.DIRAC_DIR
		else process.env.DIRAC_DIR = previousDiracHome
		await fs.rm(diracHome, { recursive: true, force: true })
	})

	it("does not persist or flush when a tool never accesses context", async () => {
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)

		await context.save()

		await assert.rejects(fs.access(contextFile(diracHome)))
		sinon.assert.notCalled(stateManager.flushPendingState)
	})

	it("loads a legacy baseline without rewriting it and appends framed mutations", async () => {
		const filePath = contextFile(diracHome)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const legacy = JSON.stringify({ fileHashes: { "/workspace/a.ts#plain": { contentHash: "abc" } } }, null, 2)
		await fs.writeFile(filePath, legacy)
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)

		assert.deepEqual(await context.task.get("fileHashes"), { "/workspace/a.ts#plain": { contentHash: "abc" } })
		await context.save()
		assert.equal(await fs.readFile(filePath, "utf8"), legacy)
		sinon.assert.notCalled(stateManager.flushPendingState)

		await context.task.set("fileHashes", { "/workspace/a.ts#plain": { contentHash: "def" } })
		await context.save()
		assert.equal(await fs.readFile(filePath, "utf8"), legacy)
		const operations = (await fs.readFile(operationFile(diracHome), "utf8"))
			.trim()
			.split("\n")
			.map((record) => JSON.parse(record))
		assert.deepEqual(operations, [
			{ offset: 0, type: "set", key: "fileHashes", value: { "/workspace/a.ts#plain": { contentHash: "def" } } },
		])
		sinon.assert.calledOnce(stateManager.flushPendingState)

		await context.task.set("fileHashes", { "/workspace/a.ts#plain": { contentHash: "def" } })
		await context.save()
		sinon.assert.calledOnce(stateManager.flushPendingState)
	})

	it("rejects a legacy baseline that is not valid JSON", async () => {
		const filePath = contextFile(diracHome)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, '{"fileHashes": {')
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)

		await assert.rejects(context.task.get("fileHashes"), /malformed JSON.*payload:/s)
	})

	it("rejects a legacy baseline that is not a JSON object", async () => {
		const filePath = contextFile(diracHome)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, '"just a string"')
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)

		await assert.rejects(context.task.get("fileHashes"), /schema mismatch/)
	})

	it("persists changed anchor state and restores it lazily", async () => {
		const sourcePath = path.join(diracHome, "workspace", "source.ts")
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await context.ensureAnchorState()
		const anchors = AnchorStateManager.reconcile(sourcePath, ["first", "second"], CONVERSATION_ID)
		context.markAnchorStateDirty()
		await context.save()

		AnchorStateManager.reset(CONVERSATION_ID)
		const restored = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await restored.load()
		assert.equal(AnchorStateManager.getAnchors(sourcePath, CONVERSATION_ID), null)
		await restored.ensureAnchorState()
		assert.deepEqual(AnchorStateManager.getAnchors(sourcePath, CONVERSATION_ID), anchors)
	})

	it("retains current anchor documents when compacting a large operation tail", async () => {
		const sourcePath = path.join(diracHome, "workspace", "baseline.ts")
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await context.ensureAnchorState()
		const anchors = AnchorStateManager.reconcile(sourcePath, ["baseline"], CONVERSATION_ID)
		context.markAnchorStateDirty(sourcePath)
		await context.task.set("largeValue", "x".repeat(8 * 1024 * 1024))
		await context.save()

		await fs.access(path.join(diracHome, "data", "tasks", TASK_ID, "tool_context.baseline.jsonl"))
		AnchorStateManager.reset(CONVERSATION_ID)
		const restored = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await restored.ensureAnchorState()

		assert.deepEqual(AnchorStateManager.getAnchors(sourcePath, CONVERSATION_ID), anchors)
		assert.equal((await restored.task.get<string>("largeValue"))?.length, 8 * 1024 * 1024)
	})

	it("serializes concurrent cache updates and retains anchor mutations made during persistence", async () => {
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await Promise.all([
			context.task.update<Record<string, string>>("fileHashes", (current) => ({ ...current, first: "one" })),
			context.task.update<Record<string, string>>("fileHashes", (current) => ({ ...current, second: "two" })),
		])
		await context.save()
		assert.deepEqual(await context.task.get("fileHashes"), { first: "one", second: "two" })

		const sourcePath = path.join(diracHome, "workspace", "source.ts")
		await context.ensureAnchorState()
		AnchorStateManager.reconcile(sourcePath, ["first"], CONVERSATION_ID)
		context.markAnchorStateDirty()

		let releaseWrite!: () => void
		const writeReleased = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		let signalWriteStarted!: () => void
		const writeStarted = new Promise<void>((resolve) => {
			signalWriteStarted = resolve
		})
		stateManager.flushPendingState.onSecondCall().callsFake(async () => {
			signalWriteStarted()
			await writeReleased
		})

		const firstSave = context.save()
		await writeStarted
		const anchors = AnchorStateManager.reconcile(sourcePath, ["first", "second"], CONVERSATION_ID)
		context.markAnchorStateDirty()
		releaseWrite()
		await firstSave
		await context.save()

		AnchorStateManager.reset(CONVERSATION_ID)
		const restored = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await restored.ensureAnchorState()
		assert.deepEqual(AnchorStateManager.getAnchors(sourcePath, CONVERSATION_ID), anchors)
		assert.deepEqual(await restored.task.get("fileHashes"), { first: "one", second: "two" })
	})

	it("replays anchor recency and evicts the oldest document at capacity", async () => {
		const context = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await context.ensureAnchorState()
		const paths = Array.from({ length: AnchorStateManager.MAX_TRACKED_FILES }, (_, index) =>
			path.join(diracHome, "workspace", `source-${index}.ts`),
		)
		for (const sourcePath of paths) {
			AnchorStateManager.reconcile(sourcePath, [sourcePath], CONVERSATION_ID)
			context.markAnchorStateDirty(sourcePath)
		}
		await context.save()

		AnchorStateManager.reconcile(paths[0], [paths[0]], CONVERSATION_ID)
		context.markAnchorStateDirty(paths[0])
		const newestPath = path.join(diracHome, "workspace", "newest.ts")
		AnchorStateManager.reconcile(newestPath, ["newest"], CONVERSATION_ID)
		context.markAnchorStateDirty(newestPath)
		await context.save()

		AnchorStateManager.reset(CONVERSATION_ID)
		const restored = new DiracContext(TASK_ID, stateManager as any, CONVERSATION_ID)
		await restored.ensureAnchorState()
		const persisted = AnchorStateManager.exportState(CONVERSATION_ID)

		assert.equal(persisted.documents.length, AnchorStateManager.MAX_TRACKED_FILES)
		assert.equal(AnchorStateManager.isTracking(paths[0], CONVERSATION_ID), true)
		assert.equal(AnchorStateManager.isTracking(paths[1], CONVERSATION_ID), false)
		assert.equal(persisted.documents.at(-1)?.absolutePath, newestPath)
	})
})
