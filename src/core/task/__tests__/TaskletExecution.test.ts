import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { TaskletEscalationCleanupError } from "../TaskMessenger"
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
import { DiracAskResponse } from "@/shared/WebviewMessage"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import * as notifications from "@integrations/notifications"
import * as retryPolicy from "@core/api/ApiRequestRetryPolicy"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { Task, TaskletHost, type TaskParams, type TaskletTaskOptions } from "../index"
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
	let nextTurn: ((mode: Mode) => Promise<"progress" | "plan" | "complete" | "question" | "read_file" | "execute_command" | "condense">) | undefined

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
								name: operation === "read_file" || operation === "execute_command" || operation === "condense" ? operation : "respond",
								arguments: JSON.stringify(operation === "read_file" ? { paths: ["assignment.txt"] }
									: operation === "execute_command" ? { commands: ["touch permission-bypass-marker"] }
										: operation === "condense" ? { context: "Private continuation summary" }
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
				// Controlled answers exercise legacy execution/resource cases, not production host authorization.
				counterparty: {
					recordResponse: sandbox.stub().resolves(),
					requestInteraction: sandbox.stub().resolves({ response: DiracAskResponse.APPROVE, action: DiracAskResponse.APPROVE }),
				},
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

	async function waitForOutcome(host: TaskletHost, id: string) {
		const deadline = Date.now() + 5_000
		while (!host.inspect(id).outcomePersisted) {
			assert.ok(Date.now() < deadline, "Tasklet did not settle")
			if (host.inspect(id).settlementError) assert.fail(JSON.stringify(host.inspect(id)))
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		return host.inspect(id)
	}

	function createHost(params = parameters()) {
		const options: TaskletTaskOptions = {
			controller: params.controller, cwd, stateManager, workingConfiguration: params.workingConfiguration,
			shellIntegrationTimeout: params.shellIntegrationTimeout, terminalReuseEnabled: params.terminalReuseEnabled,
			terminalOutputLineLimit: params.terminalOutputLineLimit, defaultTerminalProfile: params.defaultTerminalProfile,
			vscodeTerminalExecutionMode: params.vscodeTerminalExecutionMode, toolSelectionPolicy: params.toolSelectionPolicy,
			pinnedContext: params.pinnedContext,
		}
		return new TaskletHost({
			taskId: "root", executionProfile: "standalone",
			authorizePermission: rejectCall("unconfigured owner authorization"),
			assertPermissionAllowed: rejectCall("unconfigured owner authority"),
			escalateInteraction: rejectCall("unconfigured owner escalation"),
		}, options)
	}

	async function waitForInteraction(host: TaskletHost, id: string) {
		const deadline = Date.now() + 5_000
		while (!host.inspect(id).interactions.some((request) => request.status === "pending")) {
			assert.ok(Date.now() < deadline, `No owner request: ${JSON.stringify(host.inspect(id))}`)
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		return host.inspect(id).interactions.find((request) => request.status === "pending")!
	}

	function createResolutionRoot() {
		const params = parameters()
		return create({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "execute_command"] },
			vscodeTerminalExecutionMode: "backgroundExec",
			workingConfiguration: {
				...params.workingConfiguration,
				executionOptions: { ...params.workingConfiguration.executionOptions, vscodeTerminalExecutionMode: "backgroundExec" },
			},
			releaseTaskLock: async () => { }, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
		})
	}

	async function waitForRootCard(root: Task) {
		const deadline = Date.now() + 5_000
		while (!root.stateView.lastWaitingCardId) {
			assert.ok(Date.now() < deadline, "Root escalation did not become actionable")
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		const id = root.stateView.lastWaitingCardId
		const message = root.messageStateHandler.getDiracMessages().find((entry) => entry.id === id)
		assert.equal(message?.content.type, DiracMessageType.CARD)
		assert.ok(message?.content.type === DiracMessageType.CARD)
		return message.content.card
	}

	it("delivers questions and bounded results to an executing parent through environment controls while a sibling runs", async () => {
		const { SurfaceToolEnvironmentFactory } = await import("../tools/adapters/SurfaceAdapter")
		const surface = new SurfaceToolEnvironmentFactory()
		const modelPresets = await import("@core/models/modelProviderPresets")
		sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
		const fullResult = `CHILD_RESULT_START ${"detail ".repeat(1000)} CHILD_RESULT_END`
		let childId = ""
		let siblingId = ""
		let questionId = ""
		let rootTurn = 0
		let activeParentRequests = 0
		let maxParentRequests = 0
		let releaseSibling!: () => void
		let siblingEntered!: () => void
		const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve })
		const siblingStarted = new Promise<void>((resolve) => { siblingEntered = resolve })
		const parentMessages: string[] = []
		const siblingMessages: string[] = []
		let handlerNumber = 0
		const buildApi = apiModule.buildApiHandler as sinon.SinonStub
		buildApi.callsFake(() => {
			const role = handlerNumber++
			let turn = 0
			return {
				getModel: () => ({ id: "claude-opus-4-20250514", info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false } }),
				async *createMessage(_systemPrompt: string, messages: unknown): ApiStream {
					const currentTurn = ++turn
					const serialized = JSON.stringify(messages)
					if (role === 0) {
						activeParentRequests++
						maxParentRequests = Math.max(maxParentRequests, activeParentRequests)
						parentMessages.push(serialized)
						rootTurn = currentTurn
						assert.ok(currentTurn <= 4, "Unexpected parent request")
						assert.doesNotMatch(serialized, /PRIVATE_FILE_CONTENT|CHILD_RESULT_END/)
						assert.doesNotMatch(serialized, /taskletEventIds/)
						if (currentTurn === 2) {
							assert.match(serialized, /CHILD_QUESTION/)
							assert.ok(serialized.includes(questionId))
							assert.ok(serialized.includes(childId))
						}
						if (currentTurn === 3) {
							assert.match(serialized, /CHILD_RESULT_START/)
							assert.match(serialized, /preview truncated/)
						}
					} else if (role === 2) {
						siblingMessages.push(serialized)
						if (currentTurn === 1) {
							siblingEntered()
							await siblingGate
						}
					}
					try {
						const read = role === 1 && currentTurn === 1
						const operation = role === 0 ? (currentTurn < 4 ? "progress" : "complete")
							: role === 1 ? (currentTurn === 2 ? "question" : "complete")
								: currentTurn === 1 ? "progress" : "complete"
						const text = role === 1 ? (currentTurn === 2 ? "CHILD_QUESTION" : fullResult) : `role ${role} turn ${currentTurn}`
						yield {
							type: "tool_calls", tool_call: {
								call_id: `call-${role}-${currentTurn}`, function: {
									name: read ? "read_file" : "respond", arguments: JSON.stringify(read ? { paths: ["assignment.txt"] } : { operation, text }),
								}
							}
						}
						yield { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
					} finally {
						if (role === 0) activeParentRequests--
					}
				},
			} satisfies ApiHandler
		})
		const params = parameters()
		const root = create({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			releaseTaskLock: async () => { }, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
			toolEnvironmentFactory: {
				create(config, toolName) {
					const env = surface.create(config, toolName)
					if (config.executionProfile !== "standalone") {
						assert.equal(env.orchestration.tasklets, undefined)
						return env
					}
					const controls = env.orchestration.tasklets!
					assert.ok(controls, "Root tool environment must expose contained controls")
					const recordResponse = env.responseObserver.recordResponse
					env.responseObserver.recordResponse = async (response) => {
						await recordResponse(response)
						if (response.operation !== "progress") return
						if (rootTurn === 1) {
							childId = (await controls.start({ title: "question worker", prompt: "Read privately then ask CHILD_QUESTION" })).id
							questionId = (await waitForInteraction(root.taskletHost!, childId)).id
							siblingId = (await controls.start({ title: "running sibling", prompt: "Work independently" })).id
							await siblingStarted
							assert.equal(parentMessages.length, 1, "Child events must not start another parent loop")
							return
						}
						if (rootTurn === 2) {
							assert.equal(controls.list().length, 2)
							assert.equal(controls.inspect(siblingId).outcome, undefined)
							assert.match(JSON.stringify(await controls.readTranscript(childId)), /PRIVATE_FILE_CONTENT/)
							assert.equal((await controls.steer(siblingId, "SIBLING_STEERING")).accepted, true)
							assert.deepEqual(await controls.resolveInteraction(childId, questionId, {
								operation: "answer", response: { action: DiracAskResponse.MESSAGE, response: DiracAskResponse.MESSAGE, text: "PARENT_ANSWER" },
							}), { status: "resolved" })
							await waitForOutcome(root.taskletHost!, childId)
							assert.equal(controls.inspect(siblingId).outcome, undefined)
							return
						}
						assert.equal(rootTurn, 3)
						assert.equal(controls.inspect(siblingId).outcome, undefined)
						assert.equal(controls.inspect(childId).responses.at(-1)?.text, fullResult)
						const transcript = JSON.stringify(await controls.readTranscript(childId))
						assert.match(transcript, /CHILD_RESULT_END/)
						assert.match(transcript, /PARENT_ANSWER/)
						releaseSibling()
						await waitForOutcome(root.taskletHost!, siblingId)
					}
					return env
				},
			},
		})
		// Terminate the normal root follow-up wait after completion; model/tool execution remains real.
		sandbox.stub(root as any, "waitForFollowUp").resolves(undefined)
		try {
			const outcome = await root.startTask("Supervise the contained workers")
			assert.equal(outcome.kind, "completed", JSON.stringify(outcome))
			assert.equal(parentMessages.length, 4)
			assert.equal(maxParentRequests, 1)
			assert.equal(siblingMessages.length, 2)
			assert.match(siblingMessages[1], /SIBLING_STEERING/)
			const persisted = await getSavedApiConversationState(root.taskId)
			assert.match(JSON.stringify(persisted.messages), /CHILD_QUESTION|CHILD_RESULT_START/)
			assert.doesNotMatch(JSON.stringify(persisted.messages), /PRIVATE_FILE_CONTENT|CHILD_RESULT_END/)
		} finally {
			releaseSibling()
			await root.abortTask()
		}
	})

	it("answers a real child question through the root host while a sibling completes independently", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "question" : "complete"
		const child = await host.start({ title: "question", prompt: "Ask privately" })
		const request = await waitForInteraction(host, child.id)
		assert.equal(request.permissionOperation, undefined)
		const sibling = await host.start({ title: "sibling", prompt: "Finish independently" })
		assert.equal((await waitForOutcome(host, sibling.id)).outcome?.kind, "completed")
		assert.equal(host.inspect(child.id).interactions[0].status, "pending")
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, {
			operation: "answer", response: {
				action: DiracAskResponse.MESSAGE, response: DiracAskResponse.MESSAGE, text: "PRIVATE_PARENT_ANSWER",
			},
		}), { status: "resolved" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		assert.match(JSON.stringify(requests[2].messages), /PRIVATE_PARENT_ANSWER/)
		assert.equal(root.stateView.lastWaitingCardId, undefined)
		assert.equal(requests.length, 3)
	})

	it("rejects a real command without executing it and resumes the child conversation", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "execute_command" : "complete"
		const child = await host.start({ title: "command", prompt: "Ask command permission" })
		const request = await waitForInteraction(host, child.id)
		assert.deepEqual(request.permissionOperation, { kind: "commands", commands: ["touch permission-bypass-marker"] })
		await host.resolveInteraction(child.id, request.id, { operation: "reject" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		assert.match(JSON.stringify(requests[1].messages), /denied/i)
		assert.equal(root.stateView.lastWaitingCardId, undefined)
	})

	it("uses the parent's current authority rather than the child's spawn settings for real command approval", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "execute_command" : "complete"
		const child = await host.start({ title: "command", prompt: "Ask command permission" })
		const request = await waitForInteraction(host, child.id)
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: false } })
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), { status: "requires_user_approval" })
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		assert.equal(host.inspect(child.id).interactions[0].status, "pending")
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), { status: "resolved" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		await fs.access(path.join(cwd, "permission-bypass-marker"))
		assert.equal(root.stateView.lastWaitingCardId, undefined)
	})

	it("escalates a real command through root input without granting approval to the next operation", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => ++turn <= 2 ? "execute_command" : "complete"
		const child = await host.start({ title: "command", prompt: "Ask command permission twice" })
		const request = await waitForInteraction(host, child.id)
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), { status: "requires_user_approval" })
		const escalation = host.resolveInteraction(child.id, request.id, { operation: "escalate" })
		const card = await waitForRootCard(root)
		assert.notEqual(card.id, request.card.id)
		assert.match(card.header, /command/)
		assert.deepEqual(card.rawInput, request.card.rawInput)
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		await root.submitCardResponse(card.id, DiracAskResponse.APPROVE)
		assert.deepEqual(await escalation, { status: "resolved" })
		const next = await waitForInteraction(host, child.id)
		assert.notEqual(next.id, request.id)
		await fs.access(path.join(cwd, "permission-bypass-marker"))
		await fs.unlink(path.join(cwd, "permission-bypass-marker"))
		assert.deepEqual(await host.resolveInteraction(child.id, next.id, { operation: "approve" }), { status: "requires_user_approval" })
		await host.resolveInteraction(child.id, next.id, { operation: "reject" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		const final = root.messageStateHandler.getDiracMessages().find((entry) => entry.id === card.id)!
		assert.ok(final.content.type === DiracMessageType.CARD)
		assert.equal(final.content.card.status, CardStatus.SUCCESS)
	})

	it("keeps explicit real-root escalation interactive even under current YOLO permission", async () => {
		const root = createResolutionRoot()
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "execute_command" : "complete"
		const child = await host.start({ title: "command", prompt: "Explicitly escalate" })
		const request = await waitForInteraction(host, child.id)
		const escalation = host.resolveInteraction(child.id, request.id, { operation: "escalate" })
		const card = await waitForRootCard(root)
		assert.equal(host.inspect(child.id).interactions[0].status, "pending")
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		await root.submitCardResponse(card.id, DiracAskResponse.REJECT)
		await escalation
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
	})

	it("answers real runtime retry intervention without treating the answer as a permission grant", async () => {
		expectLoggerErrors() // The first controlled provider request deliberately fails authentication.
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => {
			if (++turn === 1) throw new Error("authentication failed: controlled provider")
			return "complete"
		}
		const child = await host.start({ title: "runtime", prompt: "Retry when instructed" })
		const request = await waitForInteraction(host, child.id)
		assert.equal(request.card.header, "API Request Failed")
		assert.equal(request.permissionOperation, undefined)
		await host.resolveInteraction(child.id, request.id, {
			operation: "answer", response: { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE },
		})
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		assert.equal(requests.length, 2)
		assert.equal(root.stateView.lastWaitingCardId, undefined)
	})

	it("retains directed progress and completion without emitting routine presentation as communication", async () => {
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "progress" : "complete"
		const host = createHost()
		try {
			const child = await host.start({ title: "updates", prompt: "Report privately" })
			const result = await waitForOutcome(host, child.id)
			assert.equal(result.outcome?.kind, "completed")
			assert.deepEqual(result.responses.map((response) => response.operation), ["progress", "complete"])
			assert.deepEqual(result.interactions, [])
			assert.ok((await host.readTranscript(child.id)).presentation.length > result.responses.length)
			result.responses[0].text = "mutated snapshot"
			assert.notEqual(host.inspect(child.id).responses[0].text, "mutated snapshot")
		} finally { await host.shutdown() }
	})

	for (const operation of ["question", "execute_command", "condense"] as const) {
		it(`routes real ${operation} to the owner despite YOLO, permits a sibling to finish, and retires on shutdown`, async () => {
			expectLoggerErrors() // Aborting a real tool wait is an expected tool cancellation.
			const notification = sandbox.stub(notifications, "showSystemNotification")
			const params = parameters()
			params.toolSelectionPolicy = { mode: "exact", toolIds: ["respond", "execute_command", "condense"] }
			params.workingConfiguration = createTaskWorkingConfiguration({
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-20250514" },
				workspaceConfiguration: {} as any,
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "vscodeTerminal", multiRootEnabled: false },
				settings: {
					...SETTINGS_DEFAULTS, mode: "act", hooksEnabled: false, yoloModeToggled: true,
					toolToggles: { read_file: true, execute_command: true },
					autoApprovalSettings: { ...SETTINGS_DEFAULTS.autoApprovalSettings!, enableNotifications: true }
				} as Settings,
			})
			let turn = 0
			nextTurn = async () => ++turn === 1 ? operation : "complete"
			const host = createHost(params)
			try {
				const child = await host.start({ title: "waiting", prompt: "Private request" })
				const request = await waitForInteraction(host, child.id)
				assert.equal(request.toolCall?.name, operation === "question" ? "respond" : operation)
				await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
				assert.equal(host.inspect(child.id).outcome, undefined)
				assert.equal(host.inspect(child.id).responses.length, 0)
				assert.doesNotMatch(JSON.stringify(await host.readTranscript(child.id)), /PRIVATE_FILE_CONTENT/)
				assert.equal(requests.length, 1)
				const sibling = await host.start({ title: "independent", prompt: "Complete independently" })
				assert.equal((await waitForOutcome(host, sibling.id)).outcome?.kind, "completed")
				assert.equal(host.inspect(child.id).interactions[0].status, "pending")
				await host.shutdown()
				assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
				assert.equal(host.inspect(child.id).interactions[0].status, "retired")
				assert.ok(host.inspect(child.id).interactions[0].retiredAt)
				sinon.assert.notCalled(notification)
			} finally { await host.shutdown() }
		})
	}

	it("routes real runtime authentication intervention to the owner and retires it on interruption", async () => {
		expectLoggerErrors()
		nextTurn = async () => { throw new Error("authentication failed: controlled provider") }
		const host = createHost()
		try {
			const child = await host.start({ title: "runtime", prompt: "Runtime wait" })
			const request = await waitForInteraction(host, child.id)
			assert.equal(request.card.header, "API Request Failed")
			assert.equal(request.toolCall, undefined)
			assert.equal(requests.length, 1)
			await host.interrupt(child.id)
			assert.equal(host.inspect(child.id).interactions[0].status, "retired")
			assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
		} finally { await host.shutdown() }
	})

	it("keeps ordinary real Task transport retry automatic and out of pending interactions", async () => {
		expectLoggerErrors()
		sandbox.stub(retryPolicy, "getApiRequestRetryDelay").returns(1)
		let turn = 0
		nextTurn = async () => {
			if (++turn === 1) throw new Error("temporary transport failure")
			return "complete"
		}
		const host = createHost()
		try {
			const child = await host.start({ title: "retry", prompt: "Retry transport" })
			const result = await waitForOutcome(host, child.id)
			assert.equal(result.outcome?.kind, "completed")
			assert.equal(requests.length, 2)
			assert.deepEqual(result.interactions, [])
			assert.deepEqual(result.responses.map((response) => response.operation), ["complete"])
			assert.match(JSON.stringify(await host.readTranscript(child.id)), /API Error \(Retrying\)/)
		} finally { await host.shutdown() }
	})

	it("cancels a running root and its running child without changing ordinary root lock lifetime", async () => {
		expectLoggerErrors()
		const params = parameters()
		const release = sandbox.stub().resolves()
		const root = create({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			releaseTaskLock: release, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
		})
		let releaseProviders!: () => void
		let enteredRoot!: () => void
		let enteredChild!: () => void
		const gate = new Promise<void>((resolve) => { releaseProviders = resolve })
		const rootEntered = new Promise<void>((resolve) => { enteredRoot = resolve })
		const childEntered = new Promise<void>((resolve) => { enteredChild = resolve })
		let turns = 0
		nextTurn = async () => {
			if (++turns === 1) enteredRoot()
			else enteredChild()
			await gate
			return "complete"
		}
		const run = root.startTask("Root assignment")
		try {
			await rootEntered
			const child = await root.taskletHost!.start({ title: "child", prompt: "Child assignment" })
			await childEntered
			const abort = root.abortTask()
			releaseProviders()
			await abort
			assert.equal((await run).kind, "cancelled")
			assert.equal(root.taskletHost!.inspect(child.id).outcome?.kind, "interrupted")
			assert.equal(root.taskletHost!.inspect(child.id).outcomePersisted, true)
			sinon.assert.notCalled(release)
			await root.retirePersistence()
			sinon.assert.calledOnce(release)
		} finally {
			releaseProviders()
			await root.abortTask()
			await run
			await root.retirePersistence()
		}
	})

	it("owns real children through root abort, final record persistence, lock release and deletion", async () => {
		expectLoggerErrors() // Controlled providers deliberately return late chunks after abort.
		const acquire = taskLocks.acquireTaskLock as sinon.SinonStub
		acquire.restore()
		const rootDirectory = getTaskDirectoryPath("root")
		const releaseLock = await taskLocks.acquireTaskLock(rootDirectory)
		const release = sandbox.spy(releaseLock)
		const params = parameters()
		const root = create({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			releaseTaskLock: release, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
		})
		const host = root.taskletHost!
		assert.ok(host)
		let releaseProviders!: () => void
		let enteredBoth!: () => void
		const providers = new Promise<void>((resolve) => { releaseProviders = resolve })
		const entered = new Promise<void>((resolve) => { enteredBoth = resolve })
		let turns = 0
		nextTurn = async () => {
			if (++turns === 2) enteredBoth()
			await providers
			return "complete"
		}
		let releaseRecord!: () => void
		let writingRecord!: () => void
		const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve })
		const recordEntered = new Promise<void>((resolve) => { writingRecord = resolve })
		const storage = await import("@core/storage/taskStorage")
		const originalSave = storage.saveTaskletRecord
		const save = sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (record.outcome) { writingRecord(); await recordGate }
			await originalSave(record)
		})
		let abort: Promise<void> | undefined
		let retirement: Promise<void> | undefined
		try {
			const first = await host.start({ title: "first", prompt: "first owned child" })
			const second = await host.start({ title: "second", prompt: "second owned child" })
			await entered
			const completion = await (root as any).commitAttemptCompletion("too soon")
			assert.equal(completion.committed, false)
			assert.match(completion.error, new RegExp(first.id))
			assert.match(completion.error, new RegExp(second.id))
			assert.equal(host.listActive().length, 2)
			abort = root.abortTask()
			retirement = root.retirePersistence()
			await assert.rejects(taskLocks.acquireTaskLock(rootDirectory), /another Dirac instance/)
			releaseProviders()
			await recordEntered
			sinon.assert.notCalled(release)
			assert.equal(host.list().filter((record) => record.outcomePersisted).length, 0)
			releaseRecord()
			await Promise.all([abort, retirement])
			sinon.assert.calledOnce(release)
			assert.ok(host.list().every((record) => record.outcomePersisted && record.outcome?.kind === "interrupted"))
			await assert.rejects(host.start({ title: "late", prompt: "must not launch" }), /shutting down/)
			const writesAtDeletion = save.callCount
			const deletionLock = await taskLocks.acquireTaskLock(rootDirectory)
			try {
				const { deleteTaskDirectory } = await import("@core/storage/taskDirectory")
				await deleteTaskDirectory("root")
			} finally { await deletionLock() }
			await new Promise((resolve) => setTimeout(resolve, 30))
			assert.equal(save.callCount, writesAtDeletion)
			await assert.rejects(fs.stat(rootDirectory), { code: "ENOENT" })
		} finally {
			releaseProviders()
			releaseRecord()
			await abort
			await retirement
			await root.abortTask()
			await root.retirePersistence()
		}
	})

	it("interrupts a real Task immediately after acceptance without starting a provider request", async () => {
		const host = createHost()
		const record = await host.start({ title: "early stop", prompt: "Do not start this work" })
		const stopped = await host.interrupt(record.id, "stop during startup")
		assert.equal(stopped.outcome?.kind, "interrupted", JSON.stringify(stopped))
		assert.equal(stopped.outcomePersisted, true)
		assert.equal(requests.length, 0)
		assert.match(JSON.stringify(await host.readTranscript(record.id)), /Do not start this work/)
	})

	it("retains the real root lock when cancelled escalation cannot finalize its card", async () => {
		expectLoggerErrors() // Cancelling the child's real command wait is expected.
		const acquire = taskLocks.acquireTaskLock as sinon.SinonStub
		acquire.restore()
		const rootDirectory = getTaskDirectoryPath("root")
		const releaseLock = await taskLocks.acquireTaskLock(rootDirectory)
		const release = sandbox.spy(releaseLock)
		const params = parameters()
		// This failed owner is deliberately not registered with ordinary successful afterEach shutdown.
		const root = new Task({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "execute_command"] },
			releaseTaskLock: release, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
		})
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "execute_command" : "complete"
		let expectedShutdownFailure = false
		try {
			const child = await host.start({ title: "permission", prompt: "Wait for command approval" })
			const request = await waitForInteraction(host, child.id)
			const sibling = await host.start({ title: "sibling", prompt: "Complete independently" })
			assert.equal((await waitForOutcome(host, sibling.id)).outcome?.kind, "completed")
			const escalation = host.resolveInteraction(child.id, request.id, { operation: "escalate" })
			const failedEscalation = assert.rejects(escalation, (error) => {
				assert.ok(error instanceof TaskletEscalationCleanupError)
				assert.match(String(error.cause), /root escalation patch failure/)
				return true
			})
			const card = await waitForRootCard(root)
			const patch = root.messageStateHandler.patchCardById.bind(root.messageStateHandler)
			sandbox.stub(root.messageStateHandler, "patchCardById").callsFake(async (id, update) => {
				if (id === card.id && update.status === CardStatus.CANCELLED) {
					throw new Error("root escalation patch failure")
				}
				return patch(id, update)
			})
			expectedShutdownFailure = true
			await Promise.all([
				assert.rejects(root.abortTask(), /Tasklet shutdown failed/),
				failedEscalation,
			])
			await assert.rejects(root.retirePersistence(), /Tasklet shutdown failed/)
			assert.deepEqual(root.stateView.waitingCardIds, [])
			assert.equal(root.stateView.lastWaitingCardId, undefined)
			assert.equal(root.stateView.askResponseCardId, undefined)
			assert.equal(host.inspect(child.id).interactions[0].status, "retired")
			assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
			assert.equal(host.inspect(child.id).outcomePersisted, true)
			assert.equal(host.inspect(sibling.id).outcome?.kind, "completed")
			sinon.assert.notCalled(release)
			await assert.rejects(taskLocks.acquireTaskLock(rootDirectory), /another Dirac instance/)
			await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		} finally {
			try {
				if (expectedShutdownFailure) {
					await assert.rejects(root.abortTask(), /Tasklet shutdown failed/)
					await assert.rejects(root.retirePersistence(), /Tasklet shutdown failed/)
				} else {
					await root.abortTask()
					await root.retirePersistence()
				}
			} finally {
				// Test-only release; production correctly retains failed ownership.
				await releaseLock()
			}
		}
	})

	it("keeps root ownership on a child transcript-flush failure while retiring writers and settling siblings", async () => {
		expectLoggerErrors()
		const acquire = taskLocks.acquireTaskLock as sinon.SinonStub
		acquire.restore()
		const rootDirectory = getTaskDirectoryPath("root")
		const releaseLock = await taskLocks.acquireTaskLock(rootDirectory)
		const release = sandbox.spy(releaseLock)
		const params = parameters()
		const root = new Task({
			...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
			releaseTaskLock: release, updateTaskHistory: async () => [],
			postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
		})
		const host = root.taskletHost!
		nextTurn = async () => "complete"
		const originalRetire = Task.prototype.retirePersistence
		let failedTask: Task | undefined
		let writerRetirement: sinon.SinonSpy | undefined
		sandbox.stub(Task.prototype, "retirePersistence").callsFake(async function (this: Task) {
			if (this.executionProfile === "tasklet" && !failedTask) {
				failedTask = this
				writerRetirement = sandbox.spy(this.messageStateHandler, "retirePersistence")
				sandbox.stub(this.messageStateHandler, "flushPendingWrites").rejects(new Error("child transcript disk failure"))
			}
			return originalRetire.call(this)
		})
		try {
			const first = await host.start({ title: "failure", prompt: "Complete privately" })
			await waitForOutcome(host, first.id)
			const second = await host.start({ title: "sibling", prompt: "Sibling completes independently" })
			await waitForOutcome(host, second.id)
			assert.equal(host.inspect(first.id).outcome?.kind, "failed")
			assert.match(host.inspect(first.id).settlementError!.message, /child transcript disk failure/)
			assert.equal(host.inspect(second.id).outcome?.kind, "completed")
			assert.equal(host.inspect(second.id).outcomePersisted, true)
			await assert.rejects(root.abortTask(), /Tasklet shutdown failed/)
			await assert.rejects(root.retirePersistence(), /Tasklet shutdown failed/)
			sinon.assert.calledOnce(writerRetirement!)
			sinon.assert.notCalled(release)
			await assert.rejects(taskLocks.acquireTaskLock(rootDirectory), /another Dirac instance/)
			await fs.access(rootDirectory)
		} finally {
			await assert.rejects(root.abortTask(), /Tasklet shutdown failed/)
			await assert.rejects(root.retirePersistence(), /Tasklet shutdown failed/)
			// Test-only owner release: production deliberately retains the failed ownership.
			await releaseLock()
		}
	})

	it("preserves the full failed transcript when final persistence fails after a completion response", async () => {
		expectLoggerErrors()
		nextTurn = async () => "complete"
		const host = createHost()
		const originalRetire = Task.prototype.retirePersistence
		let failedTask: Task | undefined
		sandbox.stub(Task.prototype, "retirePersistence").callsFake(async function (this: Task) {
			if (!failedTask) {
				failedTask = this
				// Inject unflushed history and a disk failure at the actual retirement boundary.
				this.messageStateHandler.setApiConversationHistory([
					...this.messageStateHandler.getApiConversationHistory(),
					{ role: "assistant", content: [{ type: "text", text: "UNFLUSHED_FINAL_DETAIL" }] },
				])
				sandbox.stub(this.messageStateHandler, "flushPendingWrites").rejects(new Error("final transcript flush failed"))
			}
			return originalRetire.call(this)
		})
		const record = await host.start({ title: "failure", prompt: "Complete privately" })
		try {
			const result = await waitForOutcome(host, record.id)
			assert.equal(result.outcome?.kind, "failed", JSON.stringify(result))
			const transcript = await host.readTranscript(record.id)
			assert.match(JSON.stringify(transcript.conversation), /Private assignment complete/)
			assert.match(JSON.stringify(transcript.conversation), /UNFLUSHED_FINAL_DETAIL/)
			const disk = await getSavedApiConversationState({ kind: "tasklet", rootTaskId: "root", taskletId: record.id })
			assert.doesNotMatch(JSON.stringify(disk.messages), /UNFLUSHED_FINAL_DETAIL/)
			transcript.conversation.length = 0
			assert.match(JSON.stringify(await host.readTranscript(record.id)), /UNFLUSHED_FINAL_DETAIL/)
		} finally {
			await assert.rejects(host.interrupt(record.id), /interruption failed/)
			await assert.rejects(host.shutdown(), /shutdown failed/)
		}
	})

	it("hosts two real unfinished Tasks, steers privately, interrupts one and retains the other's full result", async () => {
		// The controlled provider deliberately produces a late chunk after interruption.
		expectLoggerErrors()
		const host = createHost()
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		let enteredFirst!: () => void
		let enteredSecond!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve })
		const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve })
		let turn = 0
		nextTurn = async () => {
			turn++
			if (turn === 1) { enteredFirst(); await firstGate; return "complete" }
			if (turn === 2) { enteredSecond(); await secondGate; return "progress" }
			return "complete"
		}
		try {
			const first = await host.start({ title: "first", prompt: "FIRST_PRIVATE_ASSIGNMENT" })
			assert.equal(first.outcome, undefined)
			await firstEntered
			const second = await host.start({ title: "second", prompt: "SECOND_PRIVATE_ASSIGNMENT" })
			await secondEntered
			assert.equal(host.list().filter((record) => !record.outcome).length, 2)
			const steering = await host.steer(second.id, "SECOND_PRIVATE_GUIDANCE")
			assert.equal(steering.accepted, true)
			const liveTranscript = await host.readTranscript(second.id)
			assert.match(JSON.stringify(liveTranscript.presentation), /SECOND_PRIVATE_GUIDANCE/)
			assert.doesNotMatch(JSON.stringify(liveTranscript.conversation), /SECOND_PRIVATE_GUIDANCE/)
			assert.doesNotMatch(JSON.stringify(await host.readTranscript(first.id)), /SECOND_PRIVATE_GUIDANCE/)
			const interruption = host.interrupt(first.id, "first no longer needed")
			releaseFirst()
			const interrupted = await interruption
			assert.equal(interrupted.outcome?.kind, "interrupted")
			assert.equal(interrupted.id, first.id)
			assert.equal(interrupted.outcomePersisted, true)
			assert.equal(host.inspect(second.id).outcome, undefined)
			releaseSecond()
			// Observe independently committed completion, not a respond card or an implicit join on start.
			await waitForOutcome(host, second.id)
			const result = host.inspect(second.id)
			assert.equal(result.outcome?.kind, "completed", JSON.stringify(result))
			const transcript = await host.readTranscript(second.id)
			assert.match(JSON.stringify(transcript.conversation), /SECOND_PRIVATE_GUIDANCE/)
			assert.match(JSON.stringify(transcript.conversation), /Private assignment complete/)
			assert.doesNotMatch(JSON.stringify(transcript), /FIRST_PRIVATE_ASSIGNMENT/)
			assert.equal(requests.length, 3)
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: second.id }
			const record = JSON.parse(await fs.readFile(path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord), "utf8"))
			assert.deepEqual(record.outcome, result.outcome)
			assert.equal(record.conversationUlid, second.conversationUlid)
			assert.deepEqual(await fs.readdir(path.join(directory, "storage", "tasks")), ["root"])
		} finally {
			releaseFirst()
			releaseSecond()
			await Promise.all(host.list().map((record) => host.interrupt(record.id)))
		}
	})

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

	it("routes controlled Plan-to-Act input through the child's configuration, not the foreground host", async () => {
		const params = parameters("plan")
		const task = create(params)
		params.tasklet!.counterparty.requestInteraction = async () => {
			await task.applyWorkingConfigurationUpdate({ settings: { mode: "act" } })
			return { response: DiracAskResponse.APPROVE, action: DiracAskResponse.APPROVE, text: "Proceed" }
		}
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
