import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as api from "@core/api"
import { StateManager } from "@core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { CardStatus, DiracMessageType, type DiracApiReqInfo, type DiracMessage } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { createTaskletId } from "@shared/taskletId"
import { taskletUsageAvailability, taskletUsageTotal, type TaskletUsageSnapshot } from "@shared/taskletUsage"
import { Task } from "../index"
import { recordUtilityModelUsage } from "../recordUtilityModelUsage"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { TaskState } from "../TaskState"
import { StreamingMetricsManager } from "../StreamingMetricsManager"

const known = { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheWrites: true, cacheReads: true, cost: true }
const optionalUnknown = { ...known, reasoningTokens: false, cacheWrites: false, cacheReads: false, cost: false }

function apiMessage(status: DiracApiReqInfo, id = "api"): DiracMessage {
	return { id, ts: 1, content: { type: DiracMessageType.API_STATUS, status } }
}

function snapshot(messages: DiracMessage[], state = new TaskState()): TaskletUsageSnapshot {
	const task = Object.create(Task.prototype) as any
	task.taskState = state
	task.messageStateHandler = { getApiUsage: () => getApiMetrics(messages), getDiracMessages: () => messages }
	return task.getUsageSnapshot()
}

describe("Tasklet usage knowledge", () => {
	it("distinguishes unobserved sources, placeholder zeroes, unknown metrics and reported zeroes", () => {
		const empty = snapshot([
			apiMessage({
				usageAvailability: {
					...known,
					inputTokens: false,
					outputTokens: false,
					reasoningTokens: false,
					cacheWrites: false,
					cacheReads: false,
					cost: false,
				},
				tokensIn: 0,
				tokensOut: 0,
				cost: 0,
				reasoningTokens: 0,
				cacheWrites: 0,
				cacheReads: 0,
			}),
		])
		assert.equal(empty.primary.usageObserved, false)
		assert.equal(empty.utility.usageObserved, false)
		assert.deepEqual(taskletUsageTotal(empty).usageAvailability, known)
		const unknown = snapshot([
			apiMessage({
				tokensIn: 10,
				tokensOut: 2,
				cost: 0,
				reasoningTokens: 0,
				cacheWrites: 0,
				cacheReads: 0,
				usageAvailability: optionalUnknown,
			}),
		])
		assert.equal(unknown.primary.usageObserved, true)
		assert.deepEqual(unknown.primary.usageAvailability, optionalUnknown)
		assert.deepEqual(taskletUsageTotal(unknown).usageAvailability, optionalUnknown)
		const zero = snapshot([
			apiMessage({
				tokensIn: 0,
				tokensOut: 0,
				cost: 0,
				reasoningTokens: 0,
				cacheWrites: 0,
				cacheReads: 0,
				usageAvailability: known,
			}),
		])
		assert.equal(zero.primary.usageObserved, true)
		assert.deepEqual(taskletUsageTotal(zero).usageAvailability, known)
	})

	it("requires every attributable primary request to report each optional metric", () => {
		const usage = snapshot([
			apiMessage(
				{
					tokensIn: 10,
					tokensOut: 2,
					cost: 0.5,
					reasoningTokens: 3,
					cacheWrites: 2,
					cacheReads: 4,
					usageAvailability: known,
				},
				"first",
			),
			apiMessage(
				{
					tokensIn: 5,
					tokensOut: 1,
					cost: 0,
					reasoningTokens: 0,
					cacheWrites: 0,
					cacheReads: 0,
					usageAvailability: optionalUnknown,
				},
				"second",
			),
		])
		assert.equal(usage.primary.cost, 0.5)
		assert.equal(usage.primary.reasoningTokens, 3)
		assert.equal(usage.primary.cacheReads, 4)
		assert.deepEqual(usage.primary.usageAvailability, optionalUnknown)
	})

	it("does not certify archived placeholder zeroes whose historical availability was not retained", () => {
		const usage = snapshot([
			apiMessage({
				tokensIn: 10,
				tokensOut: 2,
				cost: 0,
				usageAvailability: known,
				deletedMetrics: { tokensIn: 5, tokensOut: 1, cost: 0, reasoningTokens: 0, cacheReads: 0 },
			}),
		])
		assert.equal(usage.primary.tokensIn, 15)
		assert.equal(usage.primary.cost, 0)
		assert.deepEqual(usage.primary.usageAvailability, optionalUnknown)
	})

	it("retains known zero and unknown availability through retry archives and transcript restoration", async () => {
		for (const priced of [true, false]) {
			const message = apiMessage({})
			const messages = {
				getDiracMessages: () => [message],
				patchApiStatusById: async (_id: string, patch: object, deletions: string[] = []) => {
					Object.assign((message.content as any).status, patch)
					for (const key of deletions) delete (message.content as any).status[key]
				},
			}
			const manager = new StreamingMetricsManager(messages as any, 0, {
				shouldEstimateCost: () => false,
				getModel: () => ({ info: {} }),
			} as any)
			manager.updateFromChunk({
				inputTokens: 10,
				outputTokens: 2,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				...(priced ? { totalCost: 0 } : {}),
			})
			await manager.archiveForRetry()
			manager.updateFromChunk({
				inputTokens: 5,
				outputTokens: 1,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0,
			})
			await manager.updateApiReqMsgFromMetrics()
			const restored = snapshot(JSON.parse(JSON.stringify([message])))
			assert.equal(restored.primary.tokensIn, 15)
			assert.equal(restored.primary.cost, 0)
			assert.deepEqual(restored.primary.usageAvailability, { ...known, cost: priced })
		}
	})

	it("does not invent observed usage when retrying before the first usage chunk", async () => {
		const message = apiMessage({})
		const messages = {
			getDiracMessages: () => [message],
			patchApiStatusById: async (_id: string, patch: object, deletions: string[] = []) => {
				Object.assign((message.content as any).status, patch)
				for (const key of deletions) delete (message.content as any).status[key]
			},
		}
		const manager = new StreamingMetricsManager(messages as any, 0, {
			shouldEstimateCost: () => false,
			getModel: () => ({ info: {} }),
		} as any)
		for (let attempt = 0; attempt < 2; attempt++) {
			await manager.archiveForRetry()
			const restored = snapshot(JSON.parse(JSON.stringify([message])))
			assert.equal(restored.primary.usageObserved, false)
			assert.equal(restored.primary.tokensIn, 0)
			assert.equal(restored.primary.cost, 0)
		}
		manager.updateFromChunk({
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0,
		})
		await manager.updateApiReqMsgFromMetrics()
		assert.equal(snapshot([message]).primary.usageObserved, true)
		assert.deepEqual(snapshot([message]).primary.usageAvailability, known)
	})

	it("keeps root numeric metrics unchanged when structured cards retain unknown knowledge", () => {
		const value = snapshot([apiMessage({ tokensIn: 10, tokensOut: 2, usageAvailability: optionalUnknown })])
		const total = taskletUsageTotal(value)
		const metrics = getApiMetrics([
			{
				id: "usage",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "usage",
						header: "Usage",
						status: CardStatus.SUCCESS,
						renderType: "text",
						rawOutput: { source: "tasklet", taskletId: "child", ...total },
					},
				},
			},
		])
		assert.equal(metrics.totalTokensIn, 10)
		assert.equal(metrics.totalCost, 0)
		assert.equal(total.usageAvailability!.cost, false)
	})
})

/** Real Task construction and MessageStateHandler events; no provider execution. */
describe("Tasklet usage knowledge on explicit restoration", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	let tasks: Task[]
	let previousDiracDir: string | undefined
	let stateManager: StateManager

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-usage-knowledge-"))
		previousDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = path.join(directory, "home")
		setVscodeHostProviderMock({
			globalStorageFsPath: directory,
			terminalManagerCreator: (() => ({
				setShellIntegrationTimeout() {},
				setTerminalReuseEnabled() {},
				setTerminalOutputLineLimit() {},
				setDefaultTerminalProfile() {},
				getTerminals: () => [],
				disposeAll: async () => {},
			})) as any,
		})
		sandbox.stub(HostProvider, "env" as any).value({ getHostVersion: async () => ({ platform: "linux", diracType: 0 }) })
		sandbox.stub(StateManager, "get").callsFake(() => stateManager)
		tasks = []
		stateManager = {
			getGlobalStateKey: sandbox.stub().returns(undefined),
			getTaskSettings: sandbox.stub().returns(undefined),
			getWorkspaceStateKey: sandbox.stub().returns(undefined),
			getSecretKey: sandbox.stub().returns(undefined),
			registerCallbacks: sandbox.stub(),
			setTaskSettingsBatch: sandbox.stub(),
		} as unknown as StateManager
		sandbox
			.stub(api, "buildApiHandler")
			.returns({ getModel: () => ({ id: "controlled", info: { contextWindow: 200000 } }) } as any)
	})

	afterEach(async () => {
		try {
			for (const task of tasks) await task.retirePersistence()
		} finally {
			sandbox.restore()
			HostProvider.reset()
			if (previousDiracDir === undefined) delete process.env.DIRAC_DIR
			else process.env.DIRAC_DIR = previousDiracDir
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	function create(usage: TaskletUsageSnapshot) {
		const id = createTaskletId()
		let latest: TaskletUsageSnapshot | undefined
		const task = new Task({
			controller: { getWorkspaceManager: () => undefined } as any,
			updateTaskHistory: async () => [],
			postStateToWebview: async () => {},
			reinitExistingTaskFromId: async () => {},
			cancelTask: async () => {},
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: directory,
			stateManager,
			task: "Private assignment",
			taskId: id,
			executionProfile: "tasklet",
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { ...SETTINGS_DEFAULTS, mode: "act", enableCheckpointsSetting: false } as Settings,
				apiConfiguration: {
					planModeApiProvider: "anthropic",
					actModeApiProvider: "anthropic",
					actModeApiModelId: "claude-opus-4-20250514",
				},
				workspaceConfiguration: {} as any,
				executionOptions: {
					terminalReuseEnabled: true,
					vscodeTerminalExecutionMode: "vscodeTerminal",
					multiRootEnabled: false,
				},
			}),
			tasklet: {
				storageAddress: { kind: "tasklet", rootTaskId: "root", taskletId: id },
				usage,
				counterparty: { recordResponse: async () => {}, requestInteraction: sandbox.stub() },
				postStateToOwner: async () => {},
				updateBackgroundCommandState: () => {},
				withMutationAuthorization: (_toolName, mutation) => mutation(),
				retainMutationUntil: () => {},
				recordUsage: (value) => {
					latest = value
				},
			},
		})
		tasks.push(task)
		return { task, latest: () => latest! }
	}

	it("restores unknown Utility knowledge before adding known usage and retains primary crash shortfall", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 3,
			usageObserved: true,
			usageAvailability: optionalUnknown,
		}
		const utility = {
			tokensIn: 4,
			tokensOut: 1,
			cost: 0,
			reasoningTokens: 0,
			cacheReads: 0,
			usageObserved: true,
			usageAvailability: optionalUnknown,
		}
		const first = create({ primary, utility })
		assert.equal(first.task.taskState.utilityModelUsageObserved, true)
		assert.equal(first.task.taskState.utilityModelCostAvailable, false)
		assert.equal(first.task.taskState.utilityModelCacheReadAvailable, false)
		assert.equal(first.task.taskState.utilityModelReasoningAvailable, false)
		await first.task.messageStateHandler.overwriteDiracMessages([])
		assert.equal(first.latest().primary.cost, 0.5)
		assert.equal(first.latest().primary.tokensIn, 10)
		assert.deepEqual(first.latest().primary.usageAvailability, optionalUnknown)
		const selection = { provider: "anthropic", modelId: "controlled" }
		recordUtilityModelUsage(first.task.taskState, first.task.ulid, {
			selection,
			usage: {
				inputTokens: 5,
				outputTokens: 2,
				totalCost: 0.25,
				reasoningTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		} as any)
		await first.task.messageStateHandler.overwriteDiracMessages([
			apiMessage({
				tokensIn: 5,
				tokensOut: 1,
				cost: 0.125,
				reasoningTokens: 0,
				cacheWrites: 0,
				cacheReads: 0,
				usageAvailability: known,
			}),
		])
		assert.equal(first.latest().primary.cost, 0.625)
		assert.equal(first.latest().primary.tokensIn, 15)
		assert.equal(first.latest().utility.cost, 0.25)
		assert.equal(first.latest().utility.tokensIn, 9)
		assert.equal(first.latest().utility.usageAvailability!.cost, false)
		const second = create(structuredClone(first.latest()))
		await second.task.messageStateHandler.overwriteDiracMessages([])
		assert.equal(second.latest().primary.cost, 0.625)
		assert.equal(second.latest().primary.tokensIn, 15)
		assert.equal(second.latest().utility.cost, 0.25)
		assert.equal(second.latest().utility.tokensIn, 9)
		assert.equal(taskletUsageTotal(second.latest()).usageAvailability!.cost, false)
	})

	it("trusts durable knowledge over an older restored prefix, but includes unknown new usage", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 0,
			cacheReads: 0,
			cacheWrites: 0,
			usageObserved: true,
			usageAvailability: known,
		}
		const utility = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary, utility })
		const old = apiMessage(
			{
				tokensIn: 10,
				tokensOut: 2,
				cost: 0,
				reasoningTokens: 0,
				cacheReads: 0,
				cacheWrites: 0,
				usageAvailability: optionalUnknown,
			},
			"restored-prefix",
		)
		await restored.task.messageStateHandler.overwriteDiracMessages([old])
		assert.equal(restored.latest().primary.tokensIn, 10)
		assert.equal(restored.latest().primary.cost, 0.5)
		assert.deepEqual(restored.latest().primary.usageAvailability, known)
		// Resume can restore/reset the presentation more than once before new work.
		await restored.task.messageStateHandler.overwriteDiracMessages([structuredClone(old)])
		assert.deepEqual(restored.latest().primary.usageAvailability, known)
		await restored.task.messageStateHandler.addToDiracMessages(
			apiMessage(
				{
					tokensIn: 5,
					tokensOut: 1,
					cost: 0,
					reasoningTokens: 0,
					cacheReads: 0,
					cacheWrites: 0,
					usageAvailability: optionalUnknown,
				},
				"new-request",
			),
		)
		assert.equal(restored.latest().primary.tokensIn, 15)
		assert.equal(restored.latest().primary.cost, 0.5)
		assert.deepEqual(restored.latest().primary.usageAvailability, optionalUnknown)
	})

	it("does not count checkpoint archive knowledge as new usage over a restored prefix", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 0,
			cacheReads: 0,
			cacheWrites: 0,
			usageObserved: true,
			usageAvailability: known,
		}
		const utility = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary, utility })
		await restored.task.messageStateHandler.overwriteDiracMessages([
			apiMessage({ tokensIn: 10, tokensOut: 2, usageAvailability: optionalUnknown }, "restored-prefix"),
		])
		await restored.task.messageStateHandler.overwriteDiracMessages([
			apiMessage(
				{
					tokensIn: 0,
					tokensOut: 0,
					cost: 0.5,
					usageAvailability: optionalUnknown,
					deletedUsageAvailability: optionalUnknown,
					deletedMetrics: { tokensIn: 10, tokensOut: 2 },
				},
				"checkpoint-archive",
			),
		])
		assert.equal(restored.latest().primary.tokensIn, 10)
		assert.equal(restored.latest().primary.cost, 0.5)
		assert.deepEqual(restored.latest().primary.usageAvailability, known)
		await restored.task.messageStateHandler.addToDiracMessages(
			apiMessage(
				{
					tokensIn: 5,
					tokensOut: 1,
					cost: 0.25,
					reasoningTokens: 0,
					cacheReads: 0,
					cacheWrites: 0,
					usageAvailability: known,
				},
				"new-known-request",
			),
		)
		assert.equal(restored.latest().primary.tokensIn, 15)
		assert.deepEqual(restored.latest().primary.usageAvailability, known)
	})

	it("keeps new unknown retry usage unknown through a later checkpoint summary", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 0,
			cacheReads: 0,
			cacheWrites: 0,
			usageObserved: true,
			usageAvailability: known,
		}
		const utility = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary, utility })
		const prefix = apiMessage(
			{
				tokensIn: 10,
				tokensOut: 2,
				cost: 0.5,
				reasoningTokens: 0,
				cacheReads: 0,
				cacheWrites: 0,
				usageAvailability: known,
			},
			"restored-prefix",
		)
		await restored.task.messageStateHandler.overwriteDiracMessages([prefix])
		await restored.task.messageStateHandler.addToDiracMessages(
			apiMessage({ tokensIn: 5, tokensOut: 1, usageAvailability: optionalUnknown }, "new-request"),
		)
		await restored.task.messageStateHandler.patchApiStatusById("new-request", {
			tokensIn: 0,
			tokensOut: 0,
			cost: 0,
			usageAvailability: {
				...known,
				inputTokens: false,
				outputTokens: false,
				reasoningTokens: false,
				cacheReads: false,
				cacheWrites: false,
				cost: false,
			},
			deletedUsageAvailability: optionalUnknown,
			deletedMetrics: { tokensIn: 5, tokensOut: 1 },
		})
		assert.equal(restored.latest().primary.tokensIn, 15)
		assert.deepEqual(restored.latest().primary.usageAvailability, optionalUnknown)
		await restored.task.messageStateHandler.overwriteDiracMessages([
			prefix,
			apiMessage(
				{
					tokensIn: 0,
					tokensOut: 0,
					cost: 0,
					usageAvailability: optionalUnknown,
					deletedUsageAvailability: optionalUnknown,
					deletedMetrics: { tokensIn: 5, tokensOut: 1 },
				},
				"checkpoint-archive",
			),
		])
		assert.equal(restored.latest().primary.tokensIn, 15)
		assert.deepEqual(restored.latest().primary.usageAvailability, optionalUnknown)
	})

	it("defers the restored primary boundary when Utility reports before transcript loading", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 0,
			cacheReads: 0,
			cacheWrites: 0,
			usageObserved: true,
			usageAvailability: known,
		}
		const utility = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary, utility })
		// Invoke the existing Utility callback before any presentation is restored.
		const executor = (restored.task as unknown as { toolExecutor: { onUtilityUsageRecorded: () => void } }).toolExecutor
		executor.onUtilityUsageRecorded()
		assert.equal(restored.latest().primary.tokensIn, 10)
		assert.equal(restored.latest().primary.cost, 0.5)
		await restored.task.messageStateHandler.overwriteDiracMessages([
			apiMessage({ tokensIn: 10, tokensOut: 2, usageAvailability: optionalUnknown }, "restored-prefix"),
		])
		assert.equal(restored.latest().primary.tokensIn, 10)
		assert.deepEqual(restored.latest().primary.usageAvailability, known)
	})

	it("retains additional transcript usage when its durable snapshot is older", async () => {
		const primary = {
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.5,
			reasoningTokens: 0,
			cacheReads: 0,
			cacheWrites: 0,
			usageObserved: true,
			usageAvailability: known,
		}
		const utility = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary, utility })
		await restored.task.messageStateHandler.overwriteDiracMessages([
			apiMessage(
				{
					tokensIn: 10,
					tokensOut: 2,
					cost: 0.5,
					reasoningTokens: 0,
					cacheReads: 0,
					cacheWrites: 0,
					usageAvailability: known,
				},
				"restored-prefix",
			),
			apiMessage({ tokensIn: 5, tokensOut: 1, usageAvailability: optionalUnknown }, "unprojected-prefix"),
		])
		assert.equal(restored.latest().primary.tokensIn, 15)
		assert.equal(restored.latest().primary.cost, 0.5)
		assert.deepEqual(restored.latest().primary.usageAvailability, optionalUnknown)
		await restored.task.messageStateHandler.addToDiracMessages(
			apiMessage(
				{
					tokensIn: 3,
					tokensOut: 1,
					cost: 0.25,
					reasoningTokens: 0,
					cacheReads: 0,
					cacheWrites: 0,
					usageAvailability: known,
				},
				"new-request",
			),
		)
		assert.equal(restored.latest().primary.tokensIn, 18)
		assert.equal(restored.latest().primary.cost, 0.75)
		assert.deepEqual(restored.latest().primary.usageAvailability, optionalUnknown)
	})

	it("restores an unused Utility source without making later reported zeroes unknown", async () => {
		const part = { tokensIn: 0, tokensOut: 0, cost: 0, reasoningTokens: 0, usageObserved: false, usageAvailability: known }
		const restored = create({ primary: part, utility: part })
		assert.equal(restored.task.taskState.utilityModelUsageObserved, false)
		assert.equal(restored.task.taskState.utilityModelCostAvailable, true)
		recordUtilityModelUsage(restored.task.taskState, restored.task.ulid, {
			selection: { provider: "anthropic", modelId: "controlled" },
			usage: { inputTokens: 1, outputTokens: 0, totalCost: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		} as any)
		await restored.task.messageStateHandler.overwriteDiracMessages([])
		assert.deepEqual(taskletUsageTotal(restored.latest()).usageAvailability, known)
		assert.equal(restored.latest().utility.usageObserved, true)
		assert.equal(restored.latest().utility.cost, 0)
	})

	it("accepts historical numeric snapshots without mistaking missing metadata for known zeroes", async () => {
		const part = { tokensIn: 1, tokensOut: 1, cost: 0, reasoningTokens: 0 }
		const restored = create({ primary: part, utility: part })
		assert.equal(restored.task.taskState.utilityModelUsageObserved, true)
		assert.equal(restored.task.taskState.utilityModelCostAvailable, false)
		await restored.task.messageStateHandler.overwriteDiracMessages([])
		assert.deepEqual(taskletUsageAvailability(restored.latest().primary), optionalUnknown)
		assert.equal(taskletUsageTotal(restored.latest()).cost, 0)
		assert.equal(taskletUsageTotal(restored.latest()).usageAvailability!.cost, false)
	})
})
