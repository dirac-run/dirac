import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as apiModule from "@core/api"
import type { ApiHandler } from "@core/api"
import type { ApiStream } from "@core/api/transform/stream"
import { getSavedApiConversationState, getSavedApiConversationProviderState, getSavedPresentationHistory } from "@core/storage/conversationHistory"
import { GlobalFileNames } from "@core/storage/fileNames"
import { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { writeTaskSettingsToStorage } from "@core/storage/taskStorage"
import * as checkpointFactory from "@integrations/checkpoints/factory"
import { ErrorService } from "@/services/error/ErrorService"
import { HostProvider } from "@/hosts/host-provider"
import { SETTINGS_DEFAULTS, type Settings } from "@/shared/storage/state-keys"
import type { Mode } from "@/shared/storage/types"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { Task, type TaskParams } from "../index"
import * as taskLocks from "../TaskLockUtils"
import { SqliteLockManager } from "@core/locks/SqliteLockManager"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

type Request = { mode: Mode; model: string; systemPrompt: string; messages: unknown; tools: string[] }

/**
 * Phase 3.4: the Task lifecycle, request loop, tool discovery/dispatch, messages and
 * persistence are real. Only the provider and external host resources are controlled.
 * Checkpoint/git resource ownership is deliberately excluded until phase 3.5.
 */
describe("Tasklet real Task execution", function () {
	this.timeout(30_000)
	let sandbox: sinon.SinonSandbox
	let directory: string
	let cwd: string
	let previousDiracDir: string | undefined
	let tasks: Task[]
	let requests: Request[]
	let forbidden: sinon.SinonStub[]
	let stateManager: StateManager
	let nextTurn: ((mode: Mode) => Promise<"progress" | "plan" | "complete" | "read_file">) | undefined

	function rejectCall(name: string) {
		const spy = sandbox.stub().callsFake(() => { throw new Error(`Tasklet escaped to ${name}`) })
		forbidden.push(spy)
		return spy
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tasks = []
		requests = []
		forbidden = []
		nextTurn = undefined
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-execution-")))
		cwd = path.join(directory, "workspace")
		await fs.mkdir(cwd)
		await fs.writeFile(path.join(cwd, "assignment.txt"), "PRIVATE_FILE_CONTENT\n")
		previousDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = path.join(directory, "home")
		setVscodeHostProviderMock({
			globalStorageFsPath: path.join(directory, "storage"),
			extensionFsPath: process.cwd(),
			terminalManagerCreator: (() => ({
				setShellIntegrationTimeout() { }, setTerminalReuseEnabled() { },
				setTerminalOutputLineLimit() { }, setDefaultTerminalProfile() { },
				getTerminals: () => [], disposeAll: async () => { },
			})) as any,
		})
		sandbox.stub(HostProvider, "env" as any).value({ getHostVersion: async () => ({ platform: "linux", diracType: 0 }) })
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: async () => ({ paths: [] }), getVisibleTabs: async () => ({ paths: [] }),
			showMessage: rejectCall("host message"),
		})
		// No checkpoint capability is disabled in production or in the working configuration.
		sandbox.stub(checkpointFactory, "buildCheckpointManager").returns({
			isEnabled: () => true, initialize: async () => { },
			commit: async () => undefined, saveCheckpoint: async () => { },
			doesLatestTaskCompletionHaveNewChanges: async () => false,
		} as any)
		stateManager = {
			getGlobalSettingsKey: (key: keyof typeof SETTINGS_DEFAULTS) => SETTINGS_DEFAULTS[key],
			getGlobalStateKey: () => undefined,
			getWorkspaceStateKey: () => undefined,
			getSecretKey: () => undefined,
			getApiConfiguration: rejectCall("singleton API defaults"),
			setGlobalState: rejectCall("global settings"),
			setWorkspaceState: rejectCall("workspace settings"),
			setTaskSettingsBatch: rejectCall("foreground task settings"),
			captureEffectiveTaskConfiguration: rejectCall("recaptured singleton defaults"),
			flushPendingState: async () => { },
		} as unknown as StateManager
		sandbox.stub(StateManager, "get").returns(stateManager)
		sandbox.stub(ErrorService, "get").returns({ toDiracError: (error: unknown) => { throw error } } as unknown as ErrorService)
		sandbox.stub(taskLocks, "acquireTaskLock").callsFake(rejectCall("root lock acquisition"))
		sandbox.stub(SqliteLockManager.prototype, "registerFolderLock").callsFake(rejectCall("SQLite lock acquisition"))
		sandbox.stub(SqliteLockManager.prototype, "releaseFolderLockByTarget").callsFake(rejectCall("SQLite lock release"))
		sandbox.stub(apiModule, "buildApiHandler").callsFake((configuration, mode) => {
			const model = (mode === "plan" ? configuration.planModeApiModelId : configuration.actModeApiModelId)!
			const handler: ApiHandler = {
				getModel: () => ({ id: model, info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false } }),
				async *createMessage(systemPrompt, messages, tools): ApiStream {
					requests.push({ mode, model, systemPrompt, messages: structuredClone(messages), tools: (tools ?? []).map((tool) => (tool as { name: string }).name) })
					assert.ok(requests.length <= 3, "Unexpected retry/request after controlled completion")
					const operation = await nextTurn?.(mode) ?? (requests.length === 1 ? "read_file" : "complete")
					yield {
						type: "tool_calls", tool_call: {
							call_id: `call-${requests.length}`, function: {
								name: operation === "read_file" ? "read_file" : "respond",
								arguments: JSON.stringify(operation === "read_file" ? { paths: ["assignment.txt"] }
									: { operation, text: operation === "complete" ? "Private assignment complete." : "Private Plan analysis." }),
							}
						}
					}
					yield { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
				},
			}
			return handler
		})
	})

	afterEach(async () => {
		try {
			for (const task of tasks) await task.abortTask()
			for (const spy of forbidden) sinon.assert.notCalled(spy)
		} finally {
			sandbox.restore()
			HostProvider.reset()
			if (previousDiracDir === undefined) delete process.env.DIRAC_DIR
			else process.env.DIRAC_DIR = previousDiracDir
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	function configuration(mode: Mode) {
		return createTaskWorkingConfiguration({
			settings: {
				...SETTINGS_DEFAULTS, mode, enableCheckpointsSetting: true, subagentsEnabled: true,
				autoApprovalSettings: { ...SETTINGS_DEFAULTS.autoApprovalSettings!, enableNotifications: false },
				toolToggles: { read_file: true, execute_command: true },
			} as Settings,
			apiConfiguration: {
				planModeApiProvider: "anthropic", actModeApiProvider: "anthropic",
				planModeApiModelId: "claude-sonnet-4-20250514", actModeApiModelId: "claude-opus-4-20250514"
			},
			workspaceConfiguration: {} as any,
			executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "vscodeTerminal", multiRootEnabled: false },
		})
	}

	function parameters(mode: Mode = "act"): TaskParams {
		const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: createTaskletId() }
		return {
			controller: {
				updateBackgroundCommandState: rejectCall("controller background state"),
				toggleActModeForYoloMode: rejectCall("controller mode"), getWorkspaceManager: rejectCall("controller workspace")
			} as any,
			updateTaskHistory: rejectCall("root history"), postStateToWebview: rejectCall("root state"),
			postPresentationToWebview: rejectCall("root presentation"), reinitExistingTaskFromId: rejectCall("root reinit"),
			cancelTask: rejectCall("root cancellation"), updateBackgroundCommandState: rejectCall("root background state"),
			switchToActMode: rejectCall("root mode"),
			shellIntegrationTimeout: 5000, terminalReuseEnabled: true, terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default", vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd, stateManager, workingConfiguration: configuration(mode), task: "Complete a private assignment.",
			taskId: address.taskletId, executionProfile: "tasklet", pinnedContext: "PINNED_PRIVATE_CONSTRAINT",
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "read_file"] },
			tasklet: {
				storageAddress: address, postStateToOwner: sandbox.stub().resolves(),
				postPresentationToOwner: sandbox.stub().resolves(), updateBackgroundCommandState: sandbox.stub()
			},
		}
	}

	function create(params: TaskParams) {
		const task = new Task(params)
		tasks.push(task)
		return task
	}

	async function seedPreservedArtifacts(address: TaskStorageAddress) {
		const base = getTaskDirectoryPath(address)
		await fs.mkdir(base, { recursive: true })
		const files = [GlobalFileNames.apiConversationHistoryOperations, GlobalFileNames.apiConversationProviderState,
		GlobalFileNames.uiMessageOperations, GlobalFileNames.taskMetadata, "settings.json"]
		return Promise.all(files.map(async (name) => {
			const file = path.join(base, name)
			const contents = `preserve:${JSON.stringify(address)}:${name}\n`
			await fs.writeFile(file, contents)
			return { file, contents }
		}))
	}

	it("runs a real Act assignment privately and persists only root-qualified tasklet artifacts", async () => {
		const params = parameters()
		const address = params.tasklet!.storageAddress
		const sibling = { ...address, taskletId: createTaskletId() }
		const preserved = (await Promise.all([
			seedPreservedArtifacts({ kind: "task", taskId: "root" }), seedPreservedArtifacts(sibling),
		])).flat()
		let steeringQueued = false
		params.enqueuePreRequestSteeringMessages = async () => {
			if (steeringQueued) return
			steeringQueued = true
			await task.enqueueSteeringMessage("PRIVATE_STEERING_CONSTRAINT")
		}
		const task = create(params)
		const outcome = await task.startTask(params.task)
		assert.equal(outcome.kind, "completed", JSON.stringify(outcome))
		assert.ok(outcome.kind === "completed")
		assert.equal(outcome.response, "Private assignment complete.")
		assert.equal(requests.length, 2)
		assert.match(JSON.stringify(requests[1].messages), /PRIVATE_FILE_CONTENT/)
		assert.equal(requests[0].mode, "act")
		assert.equal(requests[0].model, "claude-opus-4-20250514")
		assert.match(JSON.stringify(requests[0]), /PINNED_PRIVATE_CONSTRAINT/)
		assert.ok(requests[0].tools.includes("respond"))
		assert.ok(requests[0].tools.includes("read_file"))
		assert.ok(!requests[0].tools.includes("execute_command"))
		assert.ok(!requests[0].tools.includes("use_subagents"))
		assert.ok(!requests[0].tools.includes("task"))
		assert.ok(!requests[0].tools.some((name) => name.startsWith("task_")))
		sinon.assert.called(params.tasklet!.postStateToOwner as sinon.SinonStub)
		sinon.assert.called(params.tasklet!.postPresentationToOwner as sinon.SinonStub)
		const transcript = await getSavedApiConversationState(address)
		assert.match(JSON.stringify(transcript.messages), /Private assignment complete/)
		assert.match(JSON.stringify((await getSavedPresentationHistory(address)).messages), /Private assignment complete/)
		assert.deepEqual(await getSavedApiConversationProviderState(address), task.messageStateHandler.getApiConversationProviderState())
		assert.equal((await getSavedApiConversationProviderState(address)).deliveredSteeringMessageIds?.length, 1)
		const base = getTaskDirectoryPath(address)
		const metadata = JSON.parse(await fs.readFile(path.join(base, GlobalFileNames.taskMetadata), "utf8"))
		assert.ok(metadata.model_usage.length > 0)
		assert.equal(metadata.model_usage[0].model_id, "claude-opus-4-20250514")
		await fs.access(path.join(base, GlobalFileNames.apiConversationProviderState))
		for (const { file, contents } of preserved) assert.equal(await fs.readFile(file, "utf8"), contents)
		assert.deepEqual(await fs.readdir(path.join(directory, "storage", "tasks")), ["root"])
		await assert.rejects(fs.stat(path.join(directory, "storage", "tasks", "root", "children")), { code: "ENOENT" })
		await assert.rejects(fs.stat(path.join(process.env.DIRAC_DIR!, "data", "tasks", address.taskletId)), { code: "ENOENT" })
	})

	it("allows Plan requests then commits an Act configuration locally without singleton/default mutation", async () => {
		const params = parameters("plan")
		params.toolSelectionPolicy = undefined
		const original = params.workingConfiguration
		const task = create(params)
		nextTurn = async (mode) => {
			if (mode === "act") return "complete"
			await task.applyWorkingConfigurationUpdate({ settings: { mode: "act", toolToggles: { read_file: false } } },
				(candidate) => writeTaskSettingsToStorage(params.tasklet!.storageAddress, { mode: candidate.settings.mode, toolToggles: { ...candidate.settings.toolToggles } }))
			return "progress"
		}
		const outcome = await task.startTask(params.task)
		assert.equal(outcome.kind, "completed", JSON.stringify(outcome))
		assert.deepEqual(requests.map(({ mode }) => mode), ["plan", "act"])
		assert.deepEqual(requests.map(({ model }) => model), ["claude-sonnet-4-20250514", "claude-opus-4-20250514"])
		assert.ok(requests[0].tools.includes("read_file"))
		assert.ok(!requests[1].tools.includes("read_file"))
		assert.equal(original.settings.mode, "plan")
		assert.equal(original.settings.toolToggles.read_file, true)
		assert.equal(task.getWorkingConfiguration().settings.mode, "act")
		assert.equal(task.getWorkingConfiguration().settings.toolToggles.read_file, false)
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(getTaskDirectoryPath(params.tasklet!.storageAddress), "settings.json"), "utf8")),
			{ mode: "act", toolToggles: { read_file: false } })
		assert.deepEqual(await fs.readdir(path.join(directory, "storage", "tasks")), ["root"])
	})

	it("routes automatic Plan-to-Act approval through the child's configuration, not the foreground host", async () => {
		const params = parameters("plan")
		const task = create(params)
		await task.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
		nextTurn = async (mode) => mode === "plan" ? "plan" : "complete"
		const outcome = await task.startTask(params.task)
		assert.equal(outcome.kind, "completed", JSON.stringify(outcome))
		assert.deepEqual(requests.map(({ mode }) => mode), ["plan", "act"])
		assert.equal(task.getWorkingConfiguration().settings.mode, "act")
		assert.equal(params.workingConfiguration.settings.mode, "plan")
	})

	it("rejects missing bindings, mismatched identity, and root lock ownership before execution", () => {
		const params = parameters()
		assert.throws(() => new Task({ ...params, tasklet: undefined }), /private owner bindings/)
		assert.throws(() => new Task({ ...params, executionProfile: "standalone" }), /private owner bindings/)
		assert.throws(() => new Task({ ...params, taskId: createTaskletId() }), /identity/)
		assert.throws(() => new Task({ ...params, releaseTaskLock: rejectCall("root lock release") }), /root Task lock/)
		assert.throws(() => new Task({
			...params, tasklet: {
				...params.tasklet!, storageAddress: {
					...params.tasklet!.storageAddress, rootTaskId: "../escape",
				}
			}
		}), /rootTaskId|Invalid/)
		assert.equal(requests.length, 0)
	})
})
