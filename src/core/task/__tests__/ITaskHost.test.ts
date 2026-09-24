import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { StateManager } from "../../storage/StateManager"
import { Task } from "../index"
import type { ITaskHost } from "../types/task-host"

describe("ITaskHost contract", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let previousDiracDir: string | undefined

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `dirac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
		previousDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = tempDir

		sandbox.stub(HostProvider, "get").returns({
			createDiffViewProvider: () => null,
			createTerminalManager: () => ({
				setShellIntegrationTimeout: sandbox.stub(),
				setTerminalReuseEnabled: sandbox.stub(),
				setTerminalOutputLineLimit: sandbox.stub(),
				setDefaultTerminalProfile: sandbox.stub(),
				disposeAll: sandbox.stub().resolves(),
			}),
			extensionFsPath: tempDir,
			globalStorageFsPath: tempDir,
			hostBridge: {
				workspaceClient: {
					getWorkspaceFolders: sandbox.stub().returns([]),
					getWorkspacePaths: sandbox.stub().resolves({ paths: [tempDir] }),
				},
				envClient: {},
				windowClient: {},
			},
			getEnvironmentVariables: sandbox.stub().returns({}),
		} as any)
		sandbox.stub(HostProvider, "env" as any).value({
			getHostVersion: sandbox.stub().resolves({ platform: "macos", diracType: 0 }),
		})
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: sandbox.stub().resolves({ paths: [] }),
			getVisibleTabs: sandbox.stub().resolves({ paths: [] }),
		})

		const mockSM = {
			getGlobalSettingsKey: sandbox.stub().returns(undefined),
			getGlobalStateKey: sandbox.stub().returns(undefined),
			getWorkspaceStateKey: sandbox.stub().returns(undefined),
			setGlobalState: sandbox.stub(),
			setTaskSettingsBatch: sandbox.stub(),
			flushPendingState: sandbox.stub().resolves(),
			loadTaskSettings: sandbox.stub().resolves(),
			getApiConfiguration: sandbox.stub().returns({
				planModeApiProvider: "anthropic",
				actModeApiProvider: "anthropic",
				planModeApiModelId: "claude-sonnet-4-20250514",
				actModeApiModelId: "claude-sonnet-4-20250514",
			}),
			captureEffectiveTaskConfiguration: sandbox.stub().callsFake(() => ({
				revision: 1,
				settings: new Proxy(
					{},
					{
						get: (_target, key) =>
							(
								({
									mode: "act",
									enableCheckpointsSetting: true,
									shellIntegrationTimeout: 5000,
									terminalOutputLineLimit: 500,
									defaultTerminalProfile: "default",
									autoApprovalSettings: { actions: {} },
									browserSettings: {},
									toolToggles: {},
								}) as any
							)[key as any],
					},
				),
				apiConfiguration: {
					planModeApiProvider: "anthropic",
					actModeApiProvider: "anthropic",
					planModeApiModelId: "claude-sonnet-4-20250514",
					actModeApiModelId: "claude-sonnet-4-20250514",
				},
				workspaceConfiguration: {},
				executionOptions: {
					terminalReuseEnabled: true,
					vscodeTerminalExecutionMode: "vscodeTerminal",
					multiRootEnabled: false,
				},
			})),
			registerCallbacks: sandbox.stub(),
			getSecretKey: sandbox.stub().returns(undefined),
		}
		sandbox.stub(StateManager, "get").returns(mockSM as any)
	})

	afterEach(async () => {
		sandbox.restore()
		if (previousDiracDir === undefined) delete process.env.DIRAC_DIR
		else process.env.DIRAC_DIR = previousDiracDir
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {}
	})

	it("constructs a Task from a structural host without any Controller", () => {
		// A plain literal satisfies ITaskHost — if TaskParams.controller ever
		// regresses to the concrete Controller type, this file stops compiling
		// and the task→controller cycle cannot silently regrow.
		const host: ITaskHost = {
			toggleActModeForYoloMode: sandbox.stub().resolves(true),
			updateBackgroundCommandState: sandbox.stub(),
		}

		const task = new Task({
			controller: host,
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "host-contract-1",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})

		assert.ok(task)
		assert.equal(task.taskId, "host-contract-1")
	})
})
