import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as storage from "@core/storage/taskStorage"
import { StateManager } from "@core/storage/StateManager"
import { anthropicDefaultModelId } from "@shared/api"
import { TaskStatus } from "@shared/ExtensionMessage"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskletHost, type Task, type TaskletOwner, type TaskletTaskOptions } from "../index"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskRunOutcome } from "../TaskRunOutcome"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

describe("root-owned scientist conversation identity", () => {
	let directory: string
	let sandbox: sinon.SinonSandbox
	let hosts: TaskletHost[]
	let constructed: sinon.SinonStub

	function newHost(taskId = "root", executionProfile: TaskletOwner["executionProfile"] = "standalone") {
		const owner: TaskletOwner = {
			taskId, executionProfile,
			authorizePermission: sandbox.stub(), assertPermissionAllowed: sandbox.stub(), escalateInteraction: sandbox.stub(),
			hasPendingUserInput: () => false,
			withMutationAuthorization: (_toolName, mutation) => mutation(), retainMutationUntil: () => { },
		}
		const options = {
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { ...SETTINGS_DEFAULTS, mode: "act" } as Settings,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: anthropicDefaultModelId, apiKey: "test-key" },
				workspaceConfiguration: { localDiracRulesToggles: {}, localCursorRulesToggles: {}, localWindsurfRulesToggles: {}, localAgentsRulesToggles: {}, localSkillsToggles: {}, workflowToggles: {} },
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
			}),
		} as TaskletTaskOptions
		const host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		hosts.push(host)
		return host
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		sandbox.stub(StateManager, "get").returns({ getSystemDefaultSettingsKey: () => [] } as unknown as StateManager)
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "scientist-identity-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		hosts = []
		constructed = sandbox.stub().callsFake(() => {
			const outcome = deferred<TaskRunOutcome>()
			return {
				stateView: { status: TaskStatus.WAITING_FOR_API },
				startTask: () => outcome.promise,
				resumeTaskFromHistory: () => outcome.promise,
				abortTask: async () => outcome.resolve({ kind: "interrupted", reason: "Stopped by owner", interruptedAt: Date.now() }),
				retirePersistence: async () => { },
				messageStateHandler: {
					getApiConversationHistory: () => [], getDiracMessages: () => [],
					getPresentationOffset: () => -1, getPresentationStateGeneration: () => 0,
				},
			}
		})
	})

	afterEach(async () => {
		await Promise.all(hosts.map((host) => host.shutdown()))
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("reserves pending starts and never reuses an initial-write failure", async () => {
		const host = newHost()
		const entered = deferred<void>()
		const release = deferred<void>()
		const save = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (record.id !== "Feynman") return save(record)
			entered.resolve()
			await release.promise
			throw new Error("initial write failed")
		})
		const first = host.start({ type: "default", title: "First", prompt: "Work" })
		const rejected = assert.rejects(first, /initial write failed/)
		await entered.promise
		assert.deepEqual(host.listActive(), [{ id: "Feynman", title: "First" }])
		const second = await host.start({ type: "default", title: "Second", prompt: "Work" })
		assert.equal(second.id, "Planck")
		release.resolve()
		await rejected
		assert.equal(host.list().some((record) => record.id === "Feynman"), false)
		assert.equal((await storage.loadTaskletRecords("root")).some((record) => record.id === "Feynman"), false)
		const third = await host.start({ type: "default", title: "Third", prompt: "Work" })
		assert.equal(third.id, "Bohr")
	})

	it("does not consume an ID for invalid assignments; concurrent accepted starts are distinct", async () => {
		const host = newHost()
		await assert.rejects(host.start({ type: "default", title: " ", prompt: "Work" }), /non-empty/)
		await assert.rejects(host.start({ type: "missing-role", title: "Invalid", prompt: "Work" }), /Unavailable subagent role/)
		const records = await Promise.all(Array.from({ length: 4 }, (_, index) =>
			host.start({ type: "default", title: `Assignment ${index}`, prompt: "Work" })))
		assert.deepEqual(records.map((record) => record.id), ["Feynman", "Planck", "Bohr", "Heisenberg"])
		assert.equal((await storage.loadTaskletRecords("root")).length, 4)
	})

	it("retains accepted constructor failures and their IDs in existing child records", async () => {
		const host = newHost()
		constructed.onFirstCall().throws(new Error("constructor failed"))
		const failed = await host.start({ type: "default", title: "Failure", prompt: "Work" })
		assert.equal(failed.id, "Feynman")
		assert.equal(failed.outcome?.kind, "failed")
		assert.equal((await storage.loadTaskletRecords("root"))[0].id, "Feynman")
		assert.equal((await host.start({ type: "default", title: "Next", prompt: "Work" })).id, "Planck")
	})

	it("restores Goal reservations before a concurrent follow-up start and resumes without reallocation", async () => {
		const original = newHost("goal-root", "goal_coordinator")
		const first = await original.start({ type: "default", title: "Original", prompt: "Work" })
		await original.shutdown()
		const followup = newHost("goal-root", "goal_followup")
		const entered = deferred<void>()
		const release = deferred<void>()
		const load = storage.loadTaskletRecords
		sandbox.stub(storage, "loadTaskletRecords").callsFake(async (root) => {
			const records = await load(root)
			entered.resolve()
			await release.promise
			return records
		})
		const restoration = followup.reconstruct()
		await entered.promise
		const next = followup.start({ type: "default", title: "Follow-up", prompt: "New work" })
		await Promise.resolve()
		assert.equal(constructed.callCount, 1)
		release.resolve()
		await restoration
		assert.equal((await next).id, "Planck")
		const resumed = await followup.resume(first.id, "Continue original work")
		assert.equal(resumed.id, "Feynman")
		assert.equal(resumed.conversationUlid, first.conversationUlid)
		assert.equal((await followup.start({ type: "default", title: "Third", prompt: "Work" })).id, "Bohr")
	})

	it("isolates identical scientist IDs under different roots and rejects foreign ownership", async () => {
		const firstRoot = newHost("first-root")
		const secondRoot = newHost("second-root")
		const [first, second] = await Promise.all([
			firstRoot.start({ type: "default", title: "First root work", prompt: "Work" }),
			secondRoot.start({ type: "default", title: "Second root work", prompt: "Work" }),
		])
		assert.equal(first.id, "Feynman")
		assert.equal(second.id, "Feynman")
		assert.notEqual(first.conversationUlid, second.conversationUlid)
		assert.equal((await storage.loadTaskletRecords("first-root"))[0].title, "First root work")
		assert.equal((await storage.loadTaskletRecords("second-root"))[0].title, "Second root work")
		const sibling = await firstRoot.start({ type: "default", title: "First root sibling", prompt: "Work" })
		assert.throws(() => secondRoot.inspect(sibling.id), /does not belong to root/)
		await assert.rejects(storage.loadTaskletRecord({ kind: "tasklet", rootTaskId: "second-root", taskletId: first.id }, "first-root"),
			/Invalid tasklet record/)
	})
})
