import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import pWaitFor from "p-wait-for"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import type { StorageContext } from "@shared/storage/storage-context"
import type { RunHistoryItem } from "@shared/HistoryItem"
import { readTaskHistoryFromState, readTaskSettingsFromStorage, writeTaskHistoryToState } from "../disk"
import { StatePersistenceManager } from "../StatePersistenceManager"
import { applyTaskHistoryMutations, type TaskHistoryMutation } from "../taskHistory"

describe("StatePersistenceManager", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-persistence-"))
		setVscodeHostProviderMock({ globalStorageFsPath: tempDir })
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("preserves task settings queued while a flush is in progress", async () => {
		const taskId = `flush-race-${Date.now()}`
		const taskSettings = { mode: "act", customPrompt: "compact" }
		const persistence = new StatePersistenceManager(createStorage(), {
			getGlobalStateValue: () => undefined,
			getTaskStateValue: (key) => taskSettings[key as keyof typeof taskSettings],
			getSecretValue: () => undefined,
			getWorkspaceStateValue: () => undefined,
			setTaskHistoryInCache: () => { },
			onTaskHistoryCommitMerged: () => { },
		})
		persistence.addPendingTaskState(taskId, "mode")
		const originalRename = fs.rename.bind(fs)
		let releaseRename!: () => void
		let renameStarted!: () => void
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve
		})
		const renameStartedGate = new Promise<void>((resolve) => {
			renameStarted = resolve
		})
		sandbox.stub(fs, "rename").callsFake(async (oldPath, newPath) => {
			renameStarted()
			await renameGate
			await originalRename(oldPath, newPath)
		})

		const firstFlush = persistence.flushPendingState()
		await renameStartedGate
		persistence.addPendingTaskState(taskId, "customPrompt")
		releaseRename()
		await firstFlush
		await persistence.flushPendingState()
		await persistence.dispose()

		const settings = await readTaskSettingsFromStorage(taskId) as any
		settings.mode.should.equal("act")
		settings.customPrompt.should.equal("compact")
	})

	it("preserves a pending local history upsert across another instance's watcher reload", async () => {
		const base = historyItem("base")
		const fromA = historyItem("from-a")
		const fromB = historyItem("from-b")
		await writeTaskHistoryToState([base])

		let cacheA: RunHistoryItem[] = [base]
		let cacheB: RunHistoryItem[] = [base]
		const persistenceA = createHistoryPersistence(() => cacheA, (value) => {
			cacheA = value
		})
		const persistenceB = createHistoryPersistence(() => cacheB, (value) => {
			cacheB = value
		})
		await persistenceA.setupTaskHistoryWatcher(() => true, async () => { })
		await persistenceB.setupTaskHistoryWatcher(() => true, async () => { })

		const mutationA: TaskHistoryMutation = { kind: "upsert", item: fromA }
		cacheA = applyTaskHistoryMutations(cacheA, [mutationA])
		persistenceA.addPendingTaskHistoryMutation(mutationA)

		const mutationB: TaskHistoryMutation = { kind: "upsert", item: fromB }
		cacheB = applyTaskHistoryMutations(cacheB, [mutationB])
		persistenceB.addPendingTaskHistoryMutation(mutationB)
		await persistenceB.flushPendingState()

		await pWaitFor(() => cacheA.some((item) => item.id === fromB.id), { timeout: 5_000 })
		cacheA.map((item) => item.id).should.containEql(fromA.id)

		await persistenceA.flushPendingState()
		const committedIds = (await readTaskHistoryFromState()).map((item) => item.id)
		committedIds.should.containEql(base.id)
		committedIds.should.containEql(fromA.id)
		committedIds.should.containEql(fromB.id)

		await Promise.all([persistenceA.dispose(), persistenceB.dispose()])
	})
})

function createHistoryPersistence(
	getHistory: () => RunHistoryItem[],
	setHistory: (items: RunHistoryItem[]) => void,
): StatePersistenceManager {
	return new StatePersistenceManager(createStorage(), {
		getGlobalStateValue: (key) => (key === "taskHistory" ? getHistory() : undefined),
		getTaskStateValue: () => undefined,
		getSecretValue: () => undefined,
		getWorkspaceStateValue: () => undefined,
		setTaskHistoryInCache: setHistory,
		onTaskHistoryCommitMerged: () => { },
	})
}

function historyItem(id: string): RunHistoryItem {
	return { id, ts: Date.now(), task: id, tokensIn: 0, tokensOut: 0, totalCost: 0 }
}

function createStorage(): StorageContext {
	return {
		globalState: {} as any,
		globalStateBackingStore: { setBatch: () => { } } as any,
		secrets: { setBatch: () => { } } as any,
		workspaceState: { setBatch: () => { } } as any,
		dataDir: "",
		diracDir: "",
		workspaceStoragePath: "",
	}
}
