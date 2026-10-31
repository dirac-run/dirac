import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GlobalFileNames } from "@core/storage/fileNames"
import type { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { DiracContext } from "../DiracContext"

const rootTaskId = "context-root"
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
const conversations = ["root-conversation", "first-conversation", "second-conversation", "other-root-conversation"]

function contextFile(address: string | TaskStorageAddress, fileName: string): string {
	return path.join(getTaskDirectoryPath(address), fileName)
}

describe("DiracContext tasklet addressing", () => {
	let storageDirectory: string
	let sourcePath: string
	let stateManager: StateManager
	let sandbox: sinon.SinonSandbox

	function createContext(address: string | TaskStorageAddress, index: number): DiracContext {
		return new DiracContext(address, stateManager, conversations[index])
	}

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-tasklet-context-"))
		sourcePath = path.join(storageDirectory, "workspace", "shared.ts")
		setVscodeHostProviderMock({ globalStorageFsPath: path.join(storageDirectory, "data") })
		sandbox = sinon.createSandbox()
		sandbox.stub(process, "env").value({ ...process.env, DIRAC_DIR: storageDirectory })
		stateManager = { flushPendingState: sandbox.stub().resolves() } as unknown as StateManager
		for (const conversation of conversations) AnchorStateManager.reset(conversation)
	})

	afterEach(async () => {
		sandbox.restore()
		for (const conversation of conversations) AnchorStateManager.reset(conversation)
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	for (const compact of [false, true]) {
		it(`concurrently saves and lazily restores root and sibling caches and conversation anchors from ${compact ? "compacted baselines" : "operation logs"}`, async () => {
			const contexts = addresses.map(createContext)
			await Promise.all(
				contexts.map(async (context, index) => {
					await context.ensureAnchorState()
					AnchorStateManager.reconcile(
						sourcePath,
						Array.from({ length: index + 1 }, () => `execution-${index}`),
						conversations[index],
					)
					context.markAnchorStateDirty(sourcePath)
					await Promise.all([
						context.task.updateEntries("fileHashes", { [sourcePath]: { contentHash: `hash-${index}` } }),
						context.task.updateEntries("inspectAstImplementationCache", { [sourcePath]: `ast-${index}` }),
						...Array.from({ length: 10 }, () => context.task.update<number>("count", (count) => (count ?? 0) + 1)),
					])
					if (compact) await context.task.set("largeValue", String(index).repeat(8 * 1024 * 1024))
					await Promise.all([context.save(), context.save()])
				}),
			)
			const expectedAnchors = conversations.slice(0, 3).map((conversation) => AnchorStateManager.exportState(conversation))
			for (const conversation of conversations) AnchorStateManager.reset(conversation)
			const restored = addresses.map(createContext)
			await Promise.all(restored.map((context) => context.load()))
			for (const conversation of conversations) assert.equal(AnchorStateManager.getAnchors(sourcePath, conversation), null)

			for (const [index, context] of restored.entries()) {
				await context.ensureAnchorState()
				assert.deepEqual(AnchorStateManager.exportState(conversations[index]), expectedAnchors[index])
				for (let pending = index + 1; pending < restored.length; pending++) {
					assert.equal(AnchorStateManager.getAnchors(sourcePath, conversations[pending]), null)
				}
				assert.deepEqual(await context.task.get("fileHashes"), { [sourcePath]: { contentHash: `hash-${index}` } })
				assert.deepEqual(await context.task.get("inspectAstImplementationCache"), { [sourcePath]: `ast-${index}` })
				assert.equal(await context.task.get("count"), 10)
				const fileName = compact ? GlobalFileNames.toolContextBaseline : GlobalFileNames.toolContextOperations
				await fs.access(contextFile(addresses[index], fileName))
				if (compact) assert.equal(await context.task.get("largeValue"), String(index).repeat(8 * 1024 * 1024))
			}
			assert.equal(AnchorStateManager.getAnchors(sourcePath, rootTaskId), null)
			assert.equal(AnchorStateManager.getAnchors(sourcePath, firstTasklet.taskletId), null)
			assert.deepEqual((await fs.readdir(path.join(storageDirectory, "data", "tasks"))).sort(), [rootTaskId])
			assert.deepEqual((await fs.readdir(path.join(getTaskDirectoryPath(rootTaskId), "tasklets"))).sort(), [
				firstTasklet.taskletId,
				secondTasklet.taskletId,
			])
		})
	}

	it("reads legacy context files at each address and treats explicit roots like string roots", async () => {
		await Promise.all(
			addresses.map(async (address, index) => {
				await fs.mkdir(getTaskDirectoryPath(address), { recursive: true })
				await fs.writeFile(
					contextFile(address, GlobalFileNames.toolContext),
					JSON.stringify({ label: `legacy-${index}` }),
				)
				assert.equal(await createContext(address, index).task.get("label"), `legacy-${index}`)
			}),
		)
		const explicitRoot = createContext({ kind: "task", taskId: rootTaskId }, 0)
		assert.equal(await explicitRoot.task.get("label"), "legacy-0")
		await explicitRoot.task.set("label", "updated-root")
		await explicitRoot.save()
		assert.equal(await createContext(rootTaskId, 0).task.get("label"), "updated-root")
		assert.equal(await createContext(firstTasklet, 1).task.get("label"), "legacy-1")
	})

	for (const compact of [false, true]) {
		it(`preserves ${compact ? "framed" : "legacy"} root context when HostProvider and DIRAC_DATA_DIR use a different base`, async () => {
			const legacyDirectory = path.join(storageDirectory, "data", "tasks", rootTaskId)
			AnchorStateManager.reconcile(sourcePath, ["existing root"], conversations[0])
			const expectedAnchors = AnchorStateManager.exportState(conversations[0])
			await fs.mkdir(legacyDirectory, { recursive: true })
			await fs.writeFile(
				path.join(legacyDirectory, GlobalFileNames.toolContext),
				JSON.stringify({ owner: "existing-root", anchorState: expectedAnchors }),
			)
			if (compact) {
				const root = createContext(rootTaskId, 0)
				await root.task.set("largeValue", "x".repeat(8 * 1024 * 1024))
				await root.save()
				await fs.access(path.join(legacyDirectory, GlobalFileNames.toolContextBaseline))
			}
			AnchorStateManager.reset(conversations[0])
			process.env.DIRAC_DATA_DIR = path.join(storageDirectory, "different-host-base")
			HostProvider.reset()
			setVscodeHostProviderMock({ globalStorageFsPath: process.env.DIRAC_DATA_DIR })
			const unrelatedRootFile = contextFile(rootTaskId, GlobalFileNames.toolContext)
			await fs.mkdir(path.dirname(unrelatedRootFile), { recursive: true })
			await fs.writeFile(unrelatedRootFile, "must not read or overwrite this root")

			for (const address of [rootTaskId, { kind: "task", taskId: rootTaskId }] satisfies (string | TaskStorageAddress)[]) {
				const root = createContext(address, 0)
				assert.equal(await root.task.get("owner"), "existing-root")
				await root.ensureAnchorState()
				assert.deepEqual(AnchorStateManager.exportState(conversations[0]), expectedAnchors)
				await root.task.update<number>("updates", (value) => (value ?? 0) + 1)
				await root.save()
			}
			assert.equal(await createContext(rootTaskId, 0).task.get("updates"), 2)
			await fs.access(path.join(legacyDirectory, GlobalFileNames.toolContextOperations))
			assert.equal(await fs.readFile(unrelatedRootFile, "utf8"), "must not read or overwrite this root")
			await assert.rejects(fs.access(contextFile(rootTaskId, GlobalFileNames.toolContextOperations)), { code: "ENOENT" })
			await Promise.all(
				[firstTasklet, secondTasklet].map(async (address, index) => {
					const context = createContext(address, index + 1)
					await context.task.set("owner", `tasklet-${index}`)
					await context.save()
					assert.equal(await createContext(address, index + 1).task.get("owner"), `tasklet-${index}`)
					await fs.access(contextFile(address, GlobalFileNames.toolContextOperations))
				}),
			)
			await assert.rejects(fs.access(path.join(legacyDirectory, "tasklets")), { code: "ENOENT" })
		})
	}

	it("qualifies the same tasklet ID by its root while keeping conversation ownership distinct", async () => {
		const otherRoot: TaskStorageAddress = { ...firstTasklet, rootTaskId: "other-context-root" }
		const pairs = [
			{ address: firstTasklet, index: 1 },
			{ address: otherRoot, index: 3 },
		]
		await Promise.all(
			pairs.map(async ({ address, index }) => {
				const context = createContext(address, index)
				await context.ensureAnchorState()
				AnchorStateManager.reconcile(sourcePath, [`root-${index}`], conversations[index])
				context.markAnchorStateDirty()
				await context.task.set("owner", index)
				await context.save()
			}),
		)
		const expected = pairs.map(({ index }) => AnchorStateManager.exportState(conversations[index]))
		for (const conversation of conversations) AnchorStateManager.reset(conversation)
		for (const [pairIndex, { address, index }] of pairs.entries()) {
			const restored = createContext(address, index)
			assert.equal(await restored.task.get("owner"), index)
			await restored.ensureAnchorState()
			assert.deepEqual(AnchorStateManager.exportState(conversations[index]), expected[pairIndex])
		}
		assert.notEqual(getTaskDirectoryPath(firstTasklet), getTaskDirectoryPath(otherRoot))
	})

	it("resets only the selected sibling cache and preserves its conversation anchors", async () => {
		const contexts = addresses.map(createContext)
		await Promise.all(
			contexts.map(async (context, index) => {
				await context.ensureAnchorState()
				AnchorStateManager.reconcile(sourcePath, [`execution-${index}`], conversations[index])
				context.markAnchorStateDirty()
				await context.task.set("owner", index)
				await context.save()
			}),
		)
		const expected = conversations.slice(0, 3).map((conversation) => AnchorStateManager.exportState(conversation))
		await contexts[1].resetTaskContext()
		for (const conversation of conversations) AnchorStateManager.reset(conversation)
		for (const [index, address] of addresses.entries()) {
			const restored = createContext(address, index)
			assert.equal(await restored.task.get("owner"), index === 1 ? undefined : index)
			await restored.ensureAnchorState()
			assert.deepEqual(AnchorStateManager.exportState(conversations[index]), expected[index])
		}
	})

	it("surfaces one sibling append failure, allows other saves, and retries only the failed context", async () => {
		const contexts = addresses.map(createContext)
		await Promise.all(
			contexts.map(async (context, index) => {
				await context.task.set("owner", index)
				await context.save()
				await context.task.set("owner", `updated-${index}`)
			}),
		)
		const failedPath = contextFile(firstTasklet, GlobalFileNames.toolContextOperations)
		const original = await fs.readFile(failedPath, "utf8")
		const appendFile = fs.appendFile.bind(fs)
		const failure = new Error("injected sibling append failure")
		const append = sandbox.stub(fs, "appendFile").callsFake(async (file, data, options) => {
			if (file === failedPath) throw failure
			return appendFile(file, data, options)
		})
		const results = await Promise.allSettled(contexts.map((context) => context.save()))
		assert.deepEqual(results, [
			{ status: "fulfilled", value: undefined },
			{ status: "rejected", reason: failure },
			{ status: "fulfilled", value: undefined },
		])
		assert.equal(await fs.readFile(failedPath, "utf8"), original)
		for (const [index, address] of addresses.entries()) {
			assert.equal(await createContext(address, index).task.get("owner"), index === 1 ? 1 : `updated-${index}`)
		}
		const healthyPaths = [rootTaskId, secondTasklet].map((address) =>
			contextFile(address, GlobalFileNames.toolContextOperations),
		)
		const healthyBytes = await Promise.all(healthyPaths.map((file) => fs.readFile(file, "utf8")))
		append.restore()
		await contexts[1].save()
		assert.equal(await createContext(firstTasklet, 1).task.get("owner"), "updated-1")
		assert.deepEqual(await Promise.all(healthyPaths.map((file) => fs.readFile(file, "utf8"))), healthyBytes)
	})

	for (const fileName of [
		GlobalFileNames.toolContext,
		GlobalFileNames.toolContextBaseline,
		GlobalFileNames.toolContextOperations,
	]) {
		it(`isolates corruption of a sibling ${fileName} from root and other sibling data and anchors`, async () => {
			await Promise.all(
				addresses.map(async (address, index) => {
					const context = createContext(address, index)
					await context.ensureAnchorState()
					AnchorStateManager.reconcile(sourcePath, [`execution-${index}`], conversations[index])
					context.markAnchorStateDirty()
					await context.task.set("owner", index)
					await context.save()
				}),
			)
			const expected = conversations.slice(0, 3).map((conversation) => AnchorStateManager.exportState(conversation))
			for (const conversation of conversations) AnchorStateManager.reset(conversation)
			await fs.writeFile(contextFile(firstTasklet, fileName), "not JSON\n")
			const corrupted = createContext(firstTasklet, 1)
			await assert.rejects(corrupted.ensureAnchorState(), /malformed JSON|Invalid operation record/)
			assert.equal(AnchorStateManager.getAnchors(sourcePath, conversations[1]), null)
			for (const index of [0, 2]) {
				const restored = createContext(addresses[index], index)
				assert.equal(await restored.task.get("owner"), index)
				await restored.ensureAnchorState()
				assert.deepEqual(AnchorStateManager.exportState(conversations[index]), expected[index])
				await restored.task.set("afterCorruption", index)
				await restored.save()
				assert.equal(await createContext(addresses[index], index).task.get("afterCorruption"), index)
			}
			assert.equal(await fs.readFile(contextFile(firstTasklet, fileName), "utf8"), "not JSON\n")
		})
	}

	it("rejects invalid tasklet storage identities without creating directories", async () => {
		for (const address of [
			{ ...firstTasklet, rootTaskId: "../escape" },
			"../escape",
			firstTasklet.taskletId,
			{ kind: "task", taskId: firstTasklet.taskletId } as const,
			{ kind: "task", taskId: "../escape" } as const,
			{ ...firstTasklet, taskletId: "../escape" },
		]) {
			assert.throws(() => createContext(address, 1), /Invalid task(let)? directory identity/)
		}
		assert.deepEqual(await fs.readdir(storageDirectory), [])
	})
})
