import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendPresentationOperations, getSavedDiracMessages, saveDiracMessages } from "@core/storage/conversationHistory"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as sync from "@/shared/services/worker/sync"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { buildCheckpointManager } from "@integrations/checkpoints/factory"

function checkpoint(id = "checkpoint"): DiracMessage {
	return { id, ts: 1, content: { type: DiracMessageType.CHECKPOINT }, lastCheckpointHash: `${id}-hash` }
}

describe("addressed checkpoint restore", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-checkpoint-restore-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		const worker = sync.syncWorker()
		sandbox.stub(sync, "syncWorker").returns({ ...worker, enqueue: sandbox.stub() })
	})
	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("factory restore replays only the addressed root or sibling's real nested history", async () => {
		const addresses: TaskStorageAddress[] = [
			{ kind: "task", taskId: "root" },
			{ kind: "tasklet", rootTaskId: "root", taskletId: "tasklet_00000000-0000-4000-8000-000000000001" },
			{ kind: "tasklet", rootTaskId: "root", taskletId: "tasklet_00000000-0000-4000-8000-000000000002" },
		]
		for (const [index, address] of addresses.entries()) {
			await appendPresentationOperations(address, [
				{
					offset: 0,
					type: "create",
					message: { id: "text", ts: 0, content: { type: DiracMessageType.MARKDOWN, content: `owner-${index}` } },
				},
				{ offset: 1, type: "create", message: { ...checkpoint(), conversationHistoryDeletedRange: [0, 5] } },
				{
					offset: 2,
					type: "create",
					message: { id: "later", ts: 2, content: { type: DiracMessageType.MARKDOWN, content: "later" } },
				},
			])
		}
		for (const [index, address] of addresses.entries()) {
			const before = await Promise.all(addresses.map((item) => getSavedDiracMessages(item)))
			const messages = before[index]
			const messageStateHandler = {
				getDiracMessages: sandbox.stub().returns(messages),
				getMessageById: sandbox.stub().callsFake((id: string) => messages.find((message) => message.id === id)),
				getApiConversationHistory: sandbox.stub().returns([]),
				setCheckpointTracker: sandbox.stub(),
				patchMessageById: sandbox.stub().resolves(),
				saveDiracMessagesAndUpdateHistory: sandbox.stub().resolves(),
				overwriteDiracMessages: sandbox.stub().callsFake((restored: DiracMessage[]) =>
					saveDiracMessages(address, restored),
				),
				overwriteApiConversationHistory: sandbox.stub().resolves(),
			}
			const cancelTask = sandbox.stub().resolves()
			const manager = buildCheckpointManager({
				taskId: address.kind === "task" ? address.taskId : address.taskletId,
				storageAddress: address,
				messageStateHandler,
				taskState: {},
				fileContextTracker: {
					detectFilesEditedAfterMessage: sandbox.stub().resolves([]),
					storePendingFileContextWarning: sandbox.stub().resolves(),
				},
				diffViewProvider: {},
				workspaceManager: { getPrimaryRoot: () => ({ path: "/test-workspace" }) },
				postStateToWebview: sandbox.stub().resolves(),
				cancelTask,
				resetTransientState: sandbox.stub().resolves(),
				updateTaskHistory: sandbox.stub().resolves([]),
				taskMessenger: { upsertApiStatus: sandbox.stub().resolves() },
				enableCheckpoints: true,
				multiRootEnabled: false,
			} as any)
			assert.deepEqual(await manager.restoreCheckpoint("checkpoint", "task"), { conversationHistoryDeletedRange: [0, 5] })
			const after = await Promise.all(addresses.map((item) => getSavedDiracMessages(item)))
			assert.deepEqual(after[index], before[index].slice(0, 2))
			for (let other = 0; other < addresses.length; other++) {
				if (other !== index) assert.deepEqual(after[other], before[other])
			}
			assert.equal(cancelTask.callCount, 1)
		}
		assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["root"])
	})
})
