import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as puppeteer from "puppeteer-core"
import sinon from "sinon"
import * as apiModule from "@core/api"
import type { ApiHandler } from "@core/api"
import type { ApiStream } from "@core/api/transform/stream"
import { StateManager } from "@core/storage/StateManager"
import * as checkpointFactory from "@integrations/checkpoints/factory"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
import { StandaloneTerminalManager } from "@integrations/terminal/standalone/StandaloneTerminalManager"
import { HostProvider } from "@/hosts/host-provider"
import { BrowserConnectionManager } from "@/services/browser/BrowserConnectionManager"
import { ErrorService } from "@/services/error/ErrorService"
import { SETTINGS_DEFAULTS, type Settings } from "@/shared/storage/state-keys"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { Task, type TaskParams } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

type Gate = ReturnType<typeof deferred>
type ProviderControl = {
	ready: Gate
	continue: Gate
	continued: Gate
	abort: Gate
	aborted: boolean
	requests: number
	messages: unknown[]
}

/**
 * Phase 3.5 integration: real Task construction/start/abort, provider request loop,
 * command executor/orchestrator, standalone managers, OS subprocesses and temporary
 * persistence. The two tasklets share the ordinary root's workspace and storage root.
 *
 * Provider responses and host publication are controlled. Checkpoint/Git is mocked;
 * shared-Git concurrency and checkpoint draining are not verified by this suite.
 * BrowserSession/BrowserConnectionManager are real, but Puppeteer's external
 * browser and launch discovery are mocked. This is not live CLI/VS Code/browser UI
 * coverage and does not introduce the phase 3.6 TaskletHost.
 */
describe("Tasklet integrated resource cleanup", function () {
	this.timeout(45_000)
	let sandbox: sinon.SinonSandbox
	let directory: string
	let cwd: string
	let previousDiracDir: string | undefined
	let tasks: Task[]
	let editors: FileEditProvider[]
	let runs: Promise<TaskRunOutcome>[]
	let gates: Gate[]
	let controls: Map<string, ProviderControl>
	let subprocesses: { name: string; pid: number }[]
	let stateManager: StateManager
	let launch: sinon.SinonStub

	function gate() {
		const result = deferred()
		gates.push(result)
		return result
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tasks = []
		editors = []
		runs = []
		gates = []
		controls = new Map()
		subprocesses = []
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-resource-cleanup-")))
		cwd = path.join(directory, "workspace")
		await fs.mkdir(cwd)
		previousDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = path.join(directory, "home")
		setVscodeHostProviderMock({
			globalStorageFsPath: path.join(directory, "storage"),
			extensionFsPath: process.cwd(),
			diffViewProviderCreator: () => {
				const editor = new FileEditProvider(undefined, false, false)
				editors.push(editor)
				return editor
			},
			// Exercise the host-manager path too, without pretending to run VS Code UI.
			terminalManagerCreator: () => new StandaloneTerminalManager(),
		})
		sandbox.stub(HostProvider, "env" as any).value({ getHostVersion: async () => ({ platform: "linux", diracType: 0 }) })
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: async () => ({ paths: [] }), getVisibleTabs: async () => ({ paths: [] }),
			showMessage: () => { throw new Error("Unexpected host message") },
		})
		stateManager = {
			getGlobalSettingsKey: (key: keyof typeof SETTINGS_DEFAULTS) => SETTINGS_DEFAULTS[key],
			getGlobalStateKey: () => undefined,
			getWorkspaceStateKey: () => undefined,
			getSecretKey: () => undefined,
			getApiConfiguration: () => ({ actModeApiProvider: "anthropic", actModeApiModelId: "root" }),
			setGlobalState: sandbox.stub().resolves(),
			setWorkspaceState: sandbox.stub().resolves(),
			flushPendingState: async () => { },
		} as unknown as StateManager
		sandbox.stub(StateManager, "get").returns(stateManager)
		sandbox.stub(ErrorService, "get").returns({ toDiracError: (error: unknown) => { throw error } } as unknown as ErrorService)
		sandbox.stub(checkpointFactory, "buildCheckpointManager").callsFake(() => {
			return {
				isEnabled: () => true, setEnabled() { }, initialize: async () => { },
				commit: async () => "controlled-checkpoint", saveCheckpoint: async () => { },
				doesLatestTaskCompletionHaveNewChanges: async () => false,
				restoreCheckpoint: async () => { throw new Error("Cancellation must not restore the shared workspace") },
			} satisfies ICheckpointManager
		})
		sandbox.stub(BrowserConnectionManager.prototype, "getDetectedChromePath").resolves({ path: "/mock/chrome", isBundled: false })
		launch = sandbox.stub(puppeteer, "launch")
		sandbox.stub(apiModule, "buildApiHandler").callsFake((configuration) => {
			const name = configuration.actModeApiModelId!
			const control = controls.get(name)!
			const handler: ApiHandler = {
				getModel: () => ({ id: name, info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false } }),
				abort() {
					control.aborted = true
					control.abort.resolve()
				},
				async *createMessage(_systemPrompt, messages, tools): ApiStream {
					control.requests++
					control.messages.push(structuredClone(messages))
					assert.ok(control.requests <= 2, "Unexpected provider retry")
					assert.ok(tools?.some((tool) => (tool as { name: string }).name === "execute_command"))
					if (control.requests === 2) {
						control.continued.resolve()
						await control.abort.promise
						return
					}
					control.ready.resolve()
					await Promise.race([control.continue.promise, control.abort.promise])
					if (control.aborted) return
					yield {
						type: "tool_calls", tool_call: {
							call_id: `${name}-continued`, function: {
								name: "execute_command", arguments: JSON.stringify({ commands: [`printf '${name}-CONTINUED'`] }),
							},
						},
					}
					yield { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
				},
			}
			return handler
		})
		// A ready marker records the actual Node child, not just its shell. Heartbeat
		// and signal markers make liveness/termination observable independently of mocks.
		await fs.writeFile(path.join(cwd, "hold.cjs"), `
const fs = require("node:fs")
const name = process.argv[2]
let ticks = 0
fs.writeFileSync(name + ".ready", String(process.pid))
const timer = setInterval(() => fs.writeFileSync(name + ".heartbeat", String(++ticks)), 20)
process.on("SIGTERM", () => {
  clearInterval(timer)
  fs.writeFileSync(name + ".stopped", "SIGTERM")
  process.exit(0)
})
`)
	})

	afterEach(async () => {
		// Release every external gate even on an assertion failure before joining the
		// actual Tasks, so teardown cannot leave writers or OS children behind.
		for (const item of gates) item.resolve()
		for (const control of controls.values()) control.aborted = true
		try {
			await Promise.all(tasks.map((task) => task.abortTask()))
			await Promise.all(runs)
			for (const { name, pid } of subprocesses) await assertProcessStops(name, pid)
			await Promise.all(tasks.map((task) => task.retirePersistence()))
		} finally {
			sandbox.restore()
			HostProvider.reset()
			if (previousDiracDir === undefined) delete process.env.DIRAC_DIR
			else process.env.DIRAC_DIR = previousDiracDir
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	function create(name: string, mode: "backgroundExec" | "vscodeTerminal", rootTaskId?: string) {
		const control: ProviderControl = {
			ready: gate(), continue: gate(), continued: gate(), abort: gate(),
			aborted: false, requests: 0, messages: [],
		}
		controls.set(name, control)
		const taskId = rootTaskId ? createTaskletId() : "resource-root"
		const params: TaskParams = {
			controller: { getWorkspaceManager: () => undefined } as any,
			updateTaskHistory: sandbox.stub().resolves([]), postStateToWebview: sandbox.stub().resolves(),
			postPresentationToWebview: sandbox.stub().resolves(), reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(), updateBackgroundCommandState: sandbox.stub(),
			shellIntegrationTimeout: 5000, terminalReuseEnabled: true, terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default", vscodeTerminalExecutionMode: mode,
			cwd, stateManager, taskId, task: `Keep ${name} running until its owner interrupts it.`,
			workingConfiguration: createTaskWorkingConfiguration({
				settings: {
					...SETTINGS_DEFAULTS, mode: "act", enableCheckpointsSetting: true, hooksEnabled: false,
					yoloModeToggled: true,
					autoApprovalSettings: { ...SETTINGS_DEFAULTS.autoApprovalSettings!, enableNotifications: false },
					toolToggles: { execute_command: true },
				} as Settings,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: name },
				workspaceConfiguration: {} as any,
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: mode, multiRootEnabled: false },
			}),
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "execute_command"] },
			...(rootTaskId ? {
				executionProfile: "tasklet" as const,
				tasklet: {
					storageAddress: { kind: "tasklet" as const, rootTaskId, taskletId: taskId },
					postStateToOwner: sandbox.stub().resolves(), postPresentationToOwner: sandbox.stub().resolves(),
					updateBackgroundCommandState: sandbox.stub(),
				},
			} : {}),
		}
		const task = new Task(params)
		tasks.push(task)
		const run = task.startTask(params.task)
		runs.push(run)
		return { task, control, run, params }
	}

	async function readMarker(name: string, suffix: string): Promise<string> {
		const filename = path.join(cwd, `${name}.${suffix}`)
		const deadline = Date.now() + 10_000
		while (true) {
			try {
				return await fs.readFile(filename, "utf8")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				assert.ok(Date.now() < deadline, `Timed out waiting for ${filename}`)
				await delay(10)
			}
		}
	}

	async function assertHeartbeatAdvances(name: string) {
		const before = Number(await readMarker(name, "heartbeat"))
		const deadline = Date.now() + 5000
		while (Number(await readMarker(name, "heartbeat")) <= before) {
			assert.ok(Date.now() < deadline, `${name} stopped producing output`)
			await delay(10)
		}
	}

	async function assertProcessStops(name: string, pid: number): Promise<void> {
		const deadline = Date.now() + 10_000
		while (true) {
			try {
				process.kill(pid, 0)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return
				throw error
			}
			assert.ok(Date.now() < deadline, `${name} did not eventually stop`)
			await delay(10)
		}
	}

	async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			return await Promise.race([promise, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}; messages: ${JSON.stringify(tasks.map((task) => ({ taskId: task.taskId, messages: task.messageStateHandler.getDiracMessages().slice(-3) })))}`)), 10_000)
			})])
		} finally {
			clearTimeout(timer)
		}
	}

	for (const mode of ["backgroundExec", "vscodeTerminal"] as const) {
		it(`stops only the cancelled tasklet's resources (${mode}) while root and sibling continue`, async () => {
			const root = create("root", mode)
			const cancelled = create("cancelled", mode, root.task.taskId)
			const sibling = create("sibling", mode, root.task.taskId)
			const executions = [root, cancelled, sibling]
			await waitFor(Promise.all(executions.map(({ control, run }) => Promise.race([
				control.ready.promise,
				run.then((outcome) => { throw new Error(`Task ended before provider readiness: ${JSON.stringify(outcome)}`) }),
			]))), "provider readiness")
			assert.notEqual(root.task.terminalManager, cancelled.task.terminalManager)
			assert.notEqual(sibling.task.terminalManager, cancelled.task.terminalManager)
			assert.notEqual(root.task.browserSession, cancelled.task.browserSession)
			assert.notEqual(sibling.task.checkpointManager, cancelled.task.checkpointManager)

			const browserCloses = executions.map(() => sandbox.stub().resolves())
			for (const [index, { task }] of executions.entries()) {
				launch.onCall(index).resolves({ close: browserCloses[index] } as unknown as puppeteer.Browser)
				await task.browserSession.launchLocalBrowser()
				assert.equal(task.browserSession.getConnectionInfo().isConnected, true)
			}

			const backgrounds = []
			const foregrounds = []
			for (const { task, control } of executions) {
				const name = [...controls].find(([, value]) => value === control)![0]
				const command = (label: string) => `${JSON.stringify(process.execPath)} hold.cjs ${label}`
				const backgroundName = `${name}-background`
				const background = await task.executeCommandTool(command(backgroundName), 0.1, {
					useBackgroundExecution: true, suppressUserInteraction: true,
				})
				assert.equal(background[2]?.completed, false)
				assert.ok(background[2]?.backgroundCompletion)
				backgrounds.push(background)
				const foregroundName = `${name}-foreground`
				foregrounds.push(task.executeCommandTool(command(foregroundName), undefined, { suppressUserInteraction: true }))
				for (const label of [backgroundName, foregroundName]) {
					subprocesses.push({ name: label, pid: Number(await readMarker(label, "ready")) })
					await assertHeartbeatAdvances(label)
				}
			}

			// Exercise cancellation through the real Task with both modify and create paths.
			const sharedFile = path.join(cwd, "shared.ts")
			const editType = mode === "backgroundExec" ? "modify" : "create"
			if (editType === "modify") await fs.writeFile(sharedFile, "original")
			await editors[1].applyAndSaveSilently(sharedFile, "cancelled write", editType)
			await editors[2].applyAndSaveSilently(sharedFile, "sibling write", "modify")

			await waitFor(cancelled.task.abortTask(), "public abort")
			for (const index of [0, 2]) {
				sinon.assert.notCalled(browserCloses[index])
				assert.equal(executions[index].task.browserSession.getConnectionInfo().isConnected, true)
			}
			assert.equal(await fs.readFile(sharedFile, "utf8"), "sibling write")
			assert.equal(editors[1].isEditing, false)
			assert.equal(editors[2].isEditing, true)
			// Best-effort shutdown requests termination; abort is not a process/log drain barrier.
			await waitFor(foregrounds[1], "cancelled foreground completion")
			await waitFor(backgrounds[1][2]!.backgroundCompletion!, "cancelled background completion")
			const ownedProcesses = subprocesses.filter(({ name }) => name.startsWith("cancelled-"))
			for (const { name, pid } of ownedProcesses) await assertProcessStops(name, pid)
			assert.equal((await cancelled.run).kind, "cancelled")
			for (const { name } of ownedProcesses) assert.equal(await readMarker(name, "stopped"), "SIGTERM")
			assert.deepEqual(cancelled.task.terminalManager.getTerminals(true), [])
			assert.equal(cancelled.task.browserSession.getConnectionInfo().isConnected, false)
			sinon.assert.calledOnce(browserCloses[1])

			for (const { name, pid } of subprocesses.filter(({ name }) => !name.startsWith("cancelled-"))) {
				process.kill(pid, 0)
				await assertHeartbeatAdvances(name)
			}
			for (const execution of [root, sibling]) {
				assert.equal(execution.control.aborted, false)
				execution.control.continue.resolve()
			}
			await waitFor(Promise.all([root.control.continued.promise, sibling.control.continued.promise]), "continued provider turns")
			assert.match(JSON.stringify(root.control.messages[1]), /root-CONTINUED/)
			assert.match(JSON.stringify(sibling.control.messages[1]), /sibling-CONTINUED/)
			// Confirm these are tool results, not merely echoed command arguments.
			for (const execution of [root, sibling]) {
				assert.match(JSON.stringify(execution.control.messages[1]), /exit code 0/)
			}
			await cancelled.task.abortTask()
			sinon.assert.calledOnce(browserCloses[1])
			for (const { params } of [cancelled, sibling]) {
				sinon.assert.notCalled(params.updateTaskHistory as sinon.SinonStub)
				sinon.assert.notCalled(params.postStateToWebview as sinon.SinonStub)
				sinon.assert.notCalled(params.postPresentationToWebview as sinon.SinonStub)
				sinon.assert.notCalled(params.updateBackgroundCommandState as sinon.SinonStub)
			}

			await Promise.all([root.task.abortTask(), sibling.task.abortTask()])
			await Promise.all(foregrounds)
			await Promise.all(backgrounds.map((result) => result[2]!.backgroundCompletion))
			for (const { name, pid } of subprocesses) await assertProcessStops(name, pid)
		})
	}
})
