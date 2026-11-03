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
import { getSavedApiConversationState, getSavedApiConversationProviderState, getSavedPresentationHistory, saveApiConversationProviderState, saveApiConversationHistory, saveDiracMessages } from "@core/storage/conversationHistory"
import { GlobalFileNames } from "@core/storage/fileNames"
import { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { writeTaskSettingsToStorage, updateTaskMetadata } from "@core/storage/taskStorage"
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
import { getApiMetrics } from "@shared/getApiMetrics"
import { getTaskletUsage } from "@shared/taskletUsage"
import { createDefaultTextCondensationTemplateRegistry } from "@core/text-condensation/templates"

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
			hasPendingUserInput: () => false,
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

	for (const interrupt of [false, true]) {
		it(`composes supervision, sleep, ownership and accounting through an executing root reopening its ${interrupt ? "interrupted" : "completed"} child`, async () => {
			if (interrupt) expectLoggerErrors() // Cancellation of the real command permission wait.
			const { SurfaceToolEnvironmentFactory } = await import("../tools/adapters/SurfaceAdapter")
			const surface = new SurfaceToolEnvironmentFactory()
			const modelPresets = await import("@core/models/modelProviderPresets")
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			const fullResult = `FOUNDATION_RESULT_START ${"private detail ".repeat(1000)} FOUNDATION_RESULT_END`
			const parentInputs: string[] = []
			const turns = [0, 0, 0, 0, 0]
			let handlerNumber = 0
			let childId = ""
			let siblingId = ""
			let requestId = ""
			let userWoke = false
			let releaseSibling!: () => void
			const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve })
			let siblingReadFile!: () => void
			const siblingRead = new Promise<void>((resolve) => { siblingReadFile = resolve })
			const lockReleases: string[] = []
			let parentRequests = 0
			let maxParentRequests = 0
			const buildApi = apiModule.buildApiHandler as sinon.SinonStub
			buildApi.callsFake(() => {
				const role = handlerNumber++ // Original root, permission child, sibling, reopened root, resumed child.
				assert.ok(role < turns.length, "Reconstruction must not construct historical children")
				return {
					getModel: () => ({ id: "claude-opus-4-20250514", info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false } }),
					async *createMessage(_systemPrompt: string, messages: unknown): ApiStream {
						const turn = ++turns[role]
						const serialized = JSON.stringify(messages)
						const parent = role === 0 || role === 3
						if (parent) {
							parentRequests++
							maxParentRequests = Math.max(maxParentRequests, parentRequests)
							parentInputs.push(serialized)
							assert.doesNotMatch(serialized, /PRIVATE_FILE_CONTENT|FOUNDATION_RESULT_END/)
						}
						try {
							assert.ok(turn <= (role === 0 ? 4 : 2), "Unexpected request after controlled completion")
							if (role === 0 && turn === 2) assert.ok(serialized.includes(requestId), "Parent model receives the permission request")
							if (role === 0 && turn === 3) {
								assert.match(serialized, /Active tasklets:/)
								assert.ok(serialized.includes(childId) && serialized.includes(siblingId))
							}
							if (role === 0 && turn === 4) {
								assert.equal(userWoke, true)
								assert.match(serialized, /FOUNDATION_USER_GUIDANCE/)
								assert.match(serialized, /FOUNDATION_RESULT_START/)
							}
							if (role === 2 && turn === 2) {
								assert.match(serialized, /PRIVATE_FILE_CONTENT/)
								siblingReadFile()
								await siblingGate
							}
							if (role === 4) {
								assert.match(serialized, /FOUNDATION_PERMISSION_ASSIGNMENT/)
								assert.match(serialized, /FOUNDATION_EXPLICIT_FOLLOWUP/)
								assert.equal(serialized.split("Tasklet resumed.").length - 1, 1)
							}
							const name = role === 1 && turn === 1 ? "execute_command" : role === 2 && turn === 1 ? "read_file" : "respond"
							const operation = role === 0 ? (turn === 1 || turn === 3 ? "progress" : "complete")
								: role === 3 && turn === 1 ? "progress" : "complete"
							yield {
								type: "tool_calls", tool_call: {
									call_id: `foundation-${role}-${turn}`, function: {
										name, arguments: JSON.stringify(name === "execute_command" ? { commands: ["touch foundation-permission-marker"] }
											: name === "read_file" ? { paths: ["assignment.txt"] }
												: { operation, text: role === 2 ? fullResult : `Foundation role ${role} turn ${turn}` }),
									},
								},
							}
							yield { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
						} finally {
							if (parent) parentRequests--
						}
					},
				} satisfies ApiHandler
			})

			function foundationRoot(reopening: boolean) {
				const params = parameters()
				const root = create({
					...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
					toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "read_file", "execute_command"] },
					vscodeTerminalExecutionMode: "backgroundExec",
					workingConfiguration: {
						...params.workingConfiguration,
						executionOptions: { ...params.workingConfiguration.executionOptions, vscodeTerminalExecutionMode: "backgroundExec" },
					},
					releaseTaskLock: async () => {
						assert.deepEqual(root.taskletHost!.listActive(), [])
						for (const record of root.taskletHost!.list()) assert.equal(record.outcomePersisted, true)
						lockReleases.push(reopening ? "reopened" : "original")
					},
					updateTaskHistory: async () => [], postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
					toolEnvironmentFactory: {
						create(config, toolName) {
							const env = surface.create(config, toolName)
							if (config.executionProfile !== "standalone") {
								assert.equal(env.orchestration.tasklets, undefined)
								return env
							}
							const controls = env.orchestration.tasklets!
							const recordResponse = env.responseObserver.recordResponse
							env.responseObserver.recordResponse = async (response) => {
								await recordResponse(response)
								if (response.operation !== "progress") return
								if (reopening) {
									assert.deepEqual(root.taskletHost!.listActive(), [])
									assert.equal(controls.inspect(childId).interactions[0].status, interrupt ? "retired" : "resolved")
									await assert.rejects(controls.resolveInteraction(childId, requestId, { operation: "approve" }), /not pending/)
									assert.equal(controls.inspect(siblingId).responses.at(-1)?.text, fullResult)
									const before = controls.inspect(childId)
									const resumed = await controls.resume(childId, "FOUNDATION_EXPLICIT_FOLLOWUP")
									assert.equal(resumed.id, childId)
									assert.equal(resumed.conversationUlid, before.conversationUlid)
									assert.equal((await waitForOutcome(root.taskletHost!, childId)).outcome?.kind, "completed")
									return
								}
								if (turns[0] === 1) {
									childId = (await controls.start({ title: "permission child", prompt: "FOUNDATION_PERMISSION_ASSIGNMENT" })).id
									siblingId = (await controls.start({ title: "private reader", prompt: "Read the private file, then report fully" })).id
									const wake = await controls.sleep({ taskletIds: [childId], timeoutMs: 5_000 })
									assert.equal(wake.reason, "event")
									requestId = (await waitForInteraction(root.taskletHost!, childId)).id
									await siblingRead
									assert.equal(controls.inspect(childId).interactions[0].status, "pending", "Sibling reads while the permission child is waiting")
									assert.equal(controls.inspect(siblingId).outcome, undefined)
									return
								}
								assert.equal(turns[0], 3, "Rejected completion continues the same serial parent loop")
								assert.deepEqual(lockReleases, [])
								assert.equal(controls.inspect(childId).outcome, undefined, "Completion must not interrupt children")
								assert.deepEqual(await controls.resolveInteraction(childId, requestId, { operation: "approve" }), { status: "requires_user_approval" })
								await assert.rejects(fs.stat(path.join(cwd, "foundation-permission-marker")), { code: "ENOENT" })
								if (interrupt) {
									assert.equal((await controls.interrupt(childId, "Parent explicitly stops the pending permission")).outcome?.kind, "interrupted")
								} else {
									const escalation = controls.resolveInteraction(childId, requestId, { operation: "escalate" })
									const card = await waitForRootCard(root)
									await root.submitCardResponse(card.id, DiracAskResponse.APPROVE)
									assert.deepEqual(await escalation, { status: "resolved" })
									assert.equal((await waitForOutcome(root.taskletHost!, childId)).outcome?.kind, "completed")
									await fs.unlink(path.join(cwd, "foundation-permission-marker"))
								}
								assert.equal(controls.inspect(siblingId).outcome, undefined, "Sibling survives permission resolution/interruption")
								assert.deepEqual(await controls.sleep({ taskletIds: [], timeoutMs: 5_000 }), { reason: "user_message" })
								userWoke = true
								releaseSibling()
								assert.equal((await waitForOutcome(root.taskletHost!, siblingId)).outcome?.kind, "completed")
							}
							return env
						},
					},
				})
				sandbox.stub(root as any, "waitForFollowUp").resolves(undefined)
				return root
			}

			const root = foundationRoot(false)
			const run = root.startTask("Supervise private children, then close and reopen their conversations")
			try {
				const deadline = Date.now() + 10_000
				while (!(turns[0] === 3 && root.taskletHost!.isSleeping)) {
					assert.ok(Date.now() < deadline, `Parent did not reach the user-wake sleep; turns: ${turns}`)
					await Promise.race([new Promise((resolve) => setTimeout(resolve, 5)), run.then((outcome) => assert.fail(JSON.stringify(outcome)))])
				}
				assert.equal(turns[0], 3, "Sleeping parent makes no idle model requests")
				await root.enqueueSteeringMessage("FOUNDATION_USER_GUIDANCE")
				assert.equal((await run).kind, "completed")
				const initialTokens = (interrupt ? 7 : 8) * 100 // Four parent turns, two reader turns, one/two permission-child turns.
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, initialTokens)
				await root.abortTask()
				await root.retirePersistence()
				assert.deepEqual(lockReleases, ["original"])
				const reopened = foundationRoot(true)
				assert.equal((await reopened.resumeTaskFromHistory(() => {
					assert.deepEqual(turns, [4, interrupt ? 1 : 2, 2, 0, 0])
					assert.equal(handlerNumber, 4, "Root restoration constructs no child engines")
					assert.deepEqual(reopened.taskletHost!.listActive(), [])
					assert.equal(reopened.taskletHost!.inspect(childId).outcome?.kind, interrupt ? "interrupted" : "completed")
					assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, initialTokens)
				}, { initialUserInput: { text: "Resume the selected child explicitly" } })).kind, "completed")
				await reopened.abortTask()
				await reopened.retirePersistence()
				assert.deepEqual(lockReleases, ["original", "reopened"])
				assert.equal(maxParentRequests, 1)
				assert.equal(parentInputs.length, 6)
				assert.deepEqual(turns, [4, interrupt ? 1 : 2, 2, 2, 1])
				const persistedRoot = (await getSavedPresentationHistory("root")).messages
				assert.equal(getApiMetrics(persistedRoot).totalTokensIn, initialTokens + 300)
				assert.equal(getApiMetrics(persistedRoot).totalTokensOut, (initialTokens + 300) / 5)
				const contributions = persistedRoot.flatMap((message) => message.content.type === DiracMessageType.CARD
					? [getTaskletUsage(message.content.card)].filter((usage) => usage !== undefined) : [])
				assert.deepEqual(contributions.map((usage) => usage.taskletId).sort(), [childId, siblingId].sort())
				const childTranscript = JSON.stringify(await reopened.taskletHost!.readTranscript(childId))
				assert.match(childTranscript, /FOUNDATION_EXPLICIT_FOLLOWUP/)
				assert.doesNotMatch(childTranscript, /PRIVATE_FILE_CONTENT|FOUNDATION_RESULT_END/)
				assert.match(JSON.stringify(await reopened.taskletHost!.readTranscript(siblingId)), /PRIVATE_FILE_CONTENT/)
				assert.equal(reopened.taskletHost!.inspect(siblingId).responses.at(-1)?.text, fullResult)
				await assert.rejects(fs.stat(path.join(cwd, "foundation-permission-marker")), { code: "ENOENT" })
				const rootPath = getTaskDirectoryPath("root")
				assert.deepEqual((await fs.readdir(path.join(rootPath, "tasklets"))).sort(), [childId, siblingId].sort())
				assert.deepEqual(await fs.readdir(path.dirname(rootPath)), ["root"], "No independent top-level tasklet directories")
			} finally {
				releaseSibling()
				await root.abortTask()
				await run
			}
		})
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

	describe("voluntary parent sleep", () => {
		type Controls = NonNullable<import("../tools/interfaces/IToolEnvironment").IOrchestrationTrait["tasklets"]>

		async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
			let timer!: ReturnType<typeof setTimeout>
			try {
				return await Promise.race([
					promise,
					new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5_000) }),
				])
			} finally {
				clearTimeout(timer)
			}
		}

		async function waitForSleep(root: Task) {
			const deadline = Date.now() + 5_000
			while (!root.taskletHost!.isSleeping) {
				assert.ok(Date.now() < deadline, "Executing parent did not enter sleep")
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		}

		async function createSleepingRoot(onProgress: (controls: Controls, root: Task) => Promise<void>) {
			const { SurfaceToolEnvironmentFactory } = await import("../tools/adapters/SurfaceAdapter")
			const surface = new SurfaceToolEnvironmentFactory()
			const modelPresets = await import("@core/models/modelProviderPresets")
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			const params = parameters()
			const root = create({
				...params, taskId: "root", executionProfile: "standalone", tasklet: undefined,
				releaseTaskLock: async () => { }, updateTaskHistory: async () => [],
				postStateToWebview: async () => { }, postPresentationToWebview: async () => { },
				toolEnvironmentFactory: {
					create(config, toolName) {
						const env = surface.create(config, toolName)
						if (config.executionProfile !== "standalone") {
							assert.equal(env.orchestration.tasklets, undefined, "Children cannot sleep the parent")
							return env
						}
						const controls = env.orchestration.tasklets!
						assert.ok(controls)
						const recordResponse = env.responseObserver.recordResponse
						env.responseObserver.recordResponse = async (response) => {
							await recordResponse(response)
							if (response.operation === "progress") await onProgress(controls, root)
						}
						return env
					},
				},
			})
			sandbox.stub(root as any, "waitForFollowUp").resolves(undefined)
			return root
		}

		it("keeps the executing parent paused until a real child's communication arrives, then delivers it on the serial next request", async () => {
			let releaseChild!: () => void
			let childEntered!: () => void
			const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
			const childStarted = new Promise<void>((resolve) => { childEntered = resolve })
			let childId = ""
			let woke = false
			nextTurn = async () => {
				if (requests.length === 1) return "progress"
				if (requests.length === 2) {
					childEntered()
					await childGate
				} else {
					assert.equal(woke, true, "No new parent request before sleep returns")
					assert.match(JSON.stringify(requests[2].messages), /Private assignment complete\./)
					assert.doesNotMatch(JSON.stringify(requests[2].messages), /taskletEventIds/)
				}
				return "complete"
			}
			const root = await createSleepingRoot(async (controls, parent) => {
				childId = (await controls.start({ title: "sleep worker", prompt: "Complete while the parent sleeps" })).id
				await bounded(childStarted, "Child provider did not start")
				assert.equal(requests.length, 2)
				const result = await controls.sleep({ taskletIds: [childId], timeoutMs: 5_000 })
				assert.equal(result.reason, "event")
				assert.ok(result.reason === "event")
				assert.equal(result.taskletId, childId)
				assert.equal(parent.taskletHost!.isSleeping, false)
				assert.equal(requests.length, 2, "Waking must not dispatch a concurrent parent request")
				await waitForOutcome(parent.taskletHost!, childId)
				const { loadTaskletEvents } = await import("@core/storage/taskStorage")
				const events = await loadTaskletEvents({ kind: "tasklet", rootTaskId: parent.taskId, taskletId: childId })
				assert.equal(events.find((event) => event.id === result.eventId)?.deliveredAt, undefined)
				assert.ok(events.some((event) => event.id === result.eventId), "Wake identifies persisted child communication")
				assert.deepEqual(await controls.sleep({ taskletIds: [childId], timeoutMs: 0 }), result,
					"Sleep does not consume or acknowledge communication")
				woke = true
			})
			const run = root.startTask("Wait voluntarily for the contained worker")
			try {
				await waitForSleep(root)
				assert.equal(requests.length, 2, "Parent has no second request while sleeping")
				assert.equal(root.taskletHost!.inspect(childId).outcome, undefined)
				// A deterministic microtask checkpoint, not a timing-based assertion.
				await Promise.resolve()
				assert.equal(root.taskletHost!.isSleeping, true)
				assert.equal(requests.length, 2)
				releaseChild()
				assert.equal((await bounded(run, "Parent did not finish after child wake")).kind, "completed")
				assert.equal(woke, true)
				assert.equal(requests.length, 3, "Exactly one serial parent continuation")
				assert.equal(root.taskletHost!.inspect(childId).outcome?.kind, "completed")
			} finally {
				releaseChild()
				await root.abortTask()
				await bounded(run, "Parent did not settle during cleanup")
			}
		})

		for (const input of ["chat with attachments", "already queued chat with attachments", "steering", "already queued steering", "contextual feedback"] as const) {
			it(`wakes the executing parent for ${input} despite an empty child filter and retains input for the next provider request`, async () => {
				const text = `SLEEP_USER_INPUT_${input.replaceAll(" ", "_")}`
				const image = "data:image/png;base64,iVBORw0KGgo="
				const attachment = path.join(cwd, "sleep-feedback.txt")
				await fs.writeFile(attachment, "SLEEP_ATTACHMENT_CONTENT\n")
				let woke = false
				nextTurn = async () => {
					if (requests.length === 1) return "progress"
					assert.equal(woke, true)
					const messages = JSON.stringify(requests[1].messages)
					assert.ok(messages.includes(text), "Accepted user input survives tool finalization")
					assert.doesNotMatch(messages, /OPAQUE_FEEDBACK_SOURCE/)
					if (input.includes("chat with attachments")) {
						assert.match(messages, /iVBORw0KGgo=/)
						assert.match(messages, /SLEEP_ATTACHMENT_CONTENT/)
					}
					return "complete"
				}
				const root = await createSleepingRoot(async (controls, parent) => {
					if (input === "already queued steering") await parent.enqueueSteeringMessage(text)
					if (input === "already queued chat with attachments") await parent.submitCardResponse("", DiracAskResponse.MESSAGE, text, [image], [attachment])
					assert.deepEqual(await controls.sleep({ taskletIds: [], timeoutMs: 5_000 }), { reason: "user_message" })
					assert.equal(parent.taskletHost!.isSleeping, false)
					assert.equal(requests.length, 1, "User wake must not start a second provider loop")
					assert.equal(parent.stateView.askResponse, undefined, "Sleep input is not an interaction response")
					assert.equal(parent.stateView.didRejectTool, false)
					if (input.includes("chat with attachments")) {
						assert.equal(parent.stateView.pendingUserMessage, text)
						assert.deepEqual(parent.stateView.pendingUserImages, [image])
						assert.deepEqual(parent.stateView.pendingUserFiles, [attachment])
					}
					// A later completion tool in this same assistant turn must not bypass
					// input that woke the wait (or arrived just before registration).
					const completion = await (parent as unknown as { commitAttemptCompletion(text: string): Promise<{ committed: boolean }> }).commitAttemptCompletion("Premature completion")
					assert.equal(completion.committed, false)
					woke = true
				})
				const run = root.startTask("Pause voluntarily for user guidance")
				try {
					if (!input.startsWith("already queued")) {
						await waitForSleep(root)
						assert.equal(requests.length, 1)
						assert.equal(root.stateView.lastWaitingCardId, undefined, "Voluntary sleep creates no approval card")
						if (input === "chat with attachments") {
							await root.submitCardResponse("", DiracAskResponse.MESSAGE, text, [image], [attachment])
						} else if (input === "steering") {
							await root.enqueueSteeringMessage(text)
						} else {
							assert.deepEqual(await root.submitContextualInput(
								{ text, references: ["OPAQUE_FEEDBACK_SOURCE"] }, { kind: "steering" }, () => { },
							), { persisted: true })
						}
					}
					assert.equal((await bounded(run, "User input did not resume parent")).kind, "completed")
					assert.equal(woke, true)
					assert.equal(requests.length, 2)
					assert.equal(root.stateView.pendingUserMessage, undefined)
					assert.equal(root.stateView.pendingUserImages, undefined)
					assert.equal(root.stateView.pendingUserFiles, undefined)
				} finally {
					await root.abortTask()
					await bounded(run, "Parent did not settle during input cleanup")
				}
			})
		}

		it("retains a second chat arriving during attachment extraction and rejects completion until it reaches the model", async () => {
			const extract = await import("@integrations/misc/extract-text")
			const processFiles = extract.processFilesIntoText
			let releaseRead!: () => void
			let enteredRead!: () => void
			const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
			const readEntered = new Promise<void>((resolve) => { enteredRead = resolve })
			const firstFile = path.join(cwd, "first-sleep-input.txt")
			const secondFile = path.join(cwd, "second-sleep-input.txt")
			await fs.writeFile(firstFile, "FIRST_ATTACHMENT_CONTENT")
			await fs.writeFile(secondFile, "SECOND_ATTACHMENT_CONTENT")
			sandbox.stub(extract, "processFilesIntoText").callsFake(async (files) => {
				if (files.includes(firstFile)) {
					enteredRead()
					await readGate
				}
				return processFiles(files)
			})
			nextTurn = async () => {
				if (requests.length === 1) return "progress"
				const messages = JSON.stringify(requests.at(-1)!.messages)
				assert.match(messages, /FIRST_CHAT|FIRST_ATTACHMENT_CONTENT/)
				if (requests.length === 2) {
					assert.doesNotMatch(messages, /SECOND_CHAT|SECOND_ATTACHMENT_CONTENT/)
				} else {
					assert.match(messages, /SECOND_CHAT/)
					assert.match(messages, /SECOND_ATTACHMENT_CONTENT/)
					assert.match(messages, /iVBORw0KGgo=/)
				}
				return "complete"
			}
			const root = await createSleepingRoot(async (controls) => {
				assert.deepEqual(await controls.sleep(), { reason: "user_message" })
			})
			const run = root.startTask("Sleep until user guidance")
			try {
				await waitForSleep(root)
				await root.submitCardResponse("", DiracAskResponse.MESSAGE, "FIRST_CHAT", undefined, [firstFile])
				await bounded(readEntered, "First attachment extraction did not start")
				await root.submitCardResponse("", DiracAskResponse.MESSAGE, "SECOND_CHAT", ["data:image/png;base64,iVBORw0KGgo="], [secondFile])
				releaseRead()
				assert.equal((await bounded(run, "Second input did not reach the parent")).kind, "completed")
				assert.equal(requests.length, 3, "Completion must reject until the second accepted batch reaches the model")
				assert.equal(root.stateView.pendingUserMessage, undefined)
			} finally {
				releaseRead()
				await root.abortTask()
				await bounded(run, "Parent did not settle after attachment input")
			}
		})

		it("continues the real serial request loop after a time-only sleep expires", async () => {
			let woke = false
			nextTurn = async () => requests.length === 1 ? "progress" : "complete"
			const root = await createSleepingRoot(async (controls, parent) => {
				assert.deepEqual(await controls.sleep({ taskletIds: [], timeoutMs: 0 }), { reason: "timeout" })
				assert.equal(parent.taskletHost!.isSleeping, false)
				assert.equal(requests.length, 1)
				woke = true
			})
			const run = root.startTask("Wait only for the supplied timeout")
			try {
				assert.equal((await bounded(run, "Timeout did not resume parent")).kind, "completed")
				assert.equal(woke, true)
				assert.equal(requests.length, 2)
			} finally {
				await root.abortTask()
				await bounded(run, "Parent did not settle after timeout")
			}
		})

		it("cancels environment sleep through root abort and removes the waiter without another provider request", async () => {
			expectLoggerErrors() // Cancelling the real executing tool is expected cancellation.
			let woke = false
			nextTurn = async () => "progress"
			const root = await createSleepingRoot(async (controls, parent) => {
				assert.deepEqual(await controls.sleep({ taskletIds: [], timeoutMs: 5_000 }), { reason: "cancelled" })
				assert.equal(parent.taskletHost!.isSleeping, false)
				assert.equal(parent.taskState.abortSignal.aborted, true)
				woke = true
			})
			const removeListener = sandbox.spy(root.taskState.abortSignal, "removeEventListener")
			const run = root.startTask("Abort while voluntarily sleeping")
			try {
				await waitForSleep(root)
				assert.equal(requests.length, 1)
				await bounded(root.abortTask(), "Root abort did not release environment sleep")
				assert.equal((await bounded(run, "Sleeping root did not cancel")).kind, "cancelled")
				assert.equal(woke, true)
				assert.equal(root.taskletHost!.isSleeping, false)
				sinon.assert.calledWith(removeListener, "abort", sinon.match.func)
				assert.deepEqual(await root.taskletHost!.sleep({ taskletIds: [], timeoutMs: 0 }), { reason: "cancelled" })
				root.taskletHost!.notifyUserMessage()
				assert.equal(requests.length, 1, "No late timeout/user wake may restart the aborted parent")
			} finally {
				await root.abortTask()
				await bounded(run, "Parent did not settle after abort")
			}
		})
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
			assert.equal(result.usage?.primary.tokensIn, 100, "Failed final persistence retains already observed primary spend")
			assert.equal(result.usage?.primary.tokensOut, 20)
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

	it("explicitly follows up a completed real tasklet under the same handle and restores task-local context", async () => {
		const host = createHost()
		const resumed = sandbox.spy(Task.prototype, "resumeTaskFromHistory")
		const child = await host.start({ title: "follow-up", prompt: "READ_BEFORE_FOLLOWUP" })
		try {
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			await updateTaskMetadata(address, (metadata) => { metadata.active_skill_ids = ["retained-tasklet-skill"] })
			const toolDirectory = path.join(getTaskDirectoryPath(address), "tools", "retained_tasklet_tool")
			await fs.mkdir(toolDirectory, { recursive: true })
			await fs.writeFile(path.join(toolDirectory, "dirac-tool.json"), JSON.stringify({
				schemaVersion: 1, id: "retained_tasklet_tool", name: "retained_tasklet_tool", scope: "task", entry: "tool.ts",
				createdBy: "dirac", createdAt: "2026-05-29T00:00:00.000Z",
			}))
			await fs.writeFile(path.join(toolDirectory, "tool.ts"), `export const spec = { id: "retained_tasklet_tool", name: "retained_tasklet_tool", description: "Retained context" }; export function create() { return { spec() { return spec }, supportedSurfaces() { return ["all"] }, async processCall() { return "retained" } } }`)
			const { UserToolLoader } = await import("../tools/discovery/UserToolLoader")
			const loaded = await UserToolLoader.loadWithDiagnostics(toolDirectory, "task")
			assert.ok(loaded.tool, loaded.error)
			let contextRestored = false
			nextTurn = async () => {
				const task = resumed.firstCall.thisValue as Task
				assert.deepEqual(task.stateView.activeSkillIds, ["retained-tasklet-skill"])
				assert.deepEqual(task.stateView.taskScopedToolIds, ["retained_tasklet_tool"])
				contextRestored = true
				return "complete"
			}
			const accepted = await host.resume(child.id, "PARENT_FOLLOWUP_ONLY")
			assert.equal(accepted.id, child.id)
			assert.equal(accepted.conversationUlid, child.conversationUlid)
			assert.equal(accepted.outcome, undefined)
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			assert.equal(requests.length, 3)
			assert.match(JSON.stringify(requests[2].messages), /READ_BEFORE_FOLLOWUP/)
			assert.match(JSON.stringify(requests[2].messages), /PRIVATE_FILE_CONTENT/)
			assert.match(JSON.stringify(requests[2]), /PINNED_PRIVATE_CONSTRAINT/)
			const latestInput = (requests[2].messages as any[]).at(-1).content
			assert.equal(JSON.stringify(latestInput).split("Tasklet resumed.").length - 1, 1)
			assert.match(JSON.stringify(latestInput), /PARENT_FOLLOWUP_ONLY/)
			assert.doesNotMatch(JSON.stringify(latestInput), /TASK RESUMPTION|isUserInput/)
			sinon.assert.calledOnce(resumed)
			const task = resumed.firstCall.thisValue as Task
			assert.equal(task.ulid, child.conversationUlid)
			assert.deepEqual(task.stateView.activeSkillIds, ["retained-tasklet-skill"])
			assert.equal(contextRestored, true)
			const transcript = JSON.stringify(await host.readTranscript(child.id))
			assert.match(transcript, /PRIVATE_FILE_CONTENT/)
			assert.match(transcript, /PARENT_FOLLOWUP_ONLY/)
			assert.equal(host.list().length, 1)
		} finally {
			await host.shutdown()
		}
	})

	for (const reopenRoot of [false, true]) {
		it(`keeps completed plaintext compaction effective during real tasklet follow-up ${reopenRoot ? "after root reconstruction" : "under the same host"}`, async () => {
			const root = createResolutionRoot()
			let host = root.taskletHost!
			nextTurn = async () => "complete"
			const child = await host.start({ title: "compacted child", prompt: "INITIAL_TASKLET_CONTEXT" })
			await waitForOutcome(host, child.id)
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			// Seed the persisted outcome of completed plaintext compaction, not the
			// Utility summarizer itself: retain the first pair and summary after [2, 3].
			await saveApiConversationHistory(address, [
				{ role: "user", content: "INITIAL_TASKLET_CONTEXT" },
				{ role: "assistant", content: "INITIAL_REPLY" },
				{ role: "user", content: "COMPACTED_AWAY_USER_CONTEXT" },
				{ role: "assistant", content: "COMPACTED_AWAY_ASSISTANT_CONTEXT" },
				{ role: "user", content: "RETAINED_PLAINTEXT_SUMMARY" },
				{ role: "assistant", content: "RETAINED_SUMMARY_ACKNOWLEDGEMENT" },
			])
			const presentation = await getSavedPresentationHistory(address)
			presentation.messages.at(-1)!.conversationHistoryDeletedRange = [2, 3]
			await saveDiracMessages(address, presentation.messages)
			assert.deepEqual((await getSavedPresentationHistory(address)).messages.at(-1)!.conversationHistoryDeletedRange, [2, 3])
			assert.deepEqual(await getSavedApiConversationProviderState(address), {})
			let finishRoot: (() => void) | undefined
			let rootRun: Promise<unknown> | undefined
			try {
				if (reopenRoot) {
					await root.messageStateHandler.overwriteApiConversationHistory([{ role: "user", content: [{ type: "text", text: "ROOT_CONTEXT" }] }])
					await root.abortTask()
					const reopenedRoot = createResolutionRoot()
					sandbox.stub(reopenedRoot as any, "waitForFollowUp").resolves(undefined)
					const modelPresets = await import("@core/models/modelProviderPresets")
					sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
					let rootEntered!: () => void
					const rootStarted = new Promise<void>((resolve) => { rootEntered = resolve })
					const rootGate = new Promise<void>((resolve) => { finishRoot = resolve })
					let rootRequest = true
					nextTurn = async () => {
						if (rootRequest) {
							rootRequest = false
							rootEntered()
							await rootGate
						}
						return "complete"
					}
					rootRun = reopenedRoot.resumeTaskFromHistory(undefined, { initialUserInput: { text: "ROOT_FOLLOWUP" } })
					await rootStarted
					host = reopenedRoot.taskletHost!
					assert.equal(host.inspect(child.id).outcome?.kind, "completed")
				}
				await host.resume(child.id, "PARENT_COMPACTED_FOLLOWUP")
				const result = await waitForOutcome(host, child.id)
				assert.equal(result.outcome?.kind, "completed", JSON.stringify(result))
				const dispatched = JSON.stringify(requests.at(-1)!.messages)
				assert.match(dispatched, /INITIAL_TASKLET_CONTEXT/)
				assert.match(dispatched, /RETAINED_PLAINTEXT_SUMMARY/)
				assert.match(dispatched, /PARENT_COMPACTED_FOLLOWUP/)
				assert.doesNotMatch(dispatched, /COMPACTED_AWAY_USER_CONTEXT|COMPACTED_AWAY_ASSISTANT_CONTEXT/)
				assert.deepEqual((await getSavedPresentationHistory(address)).messages.at(-1)!.conversationHistoryDeletedRange, [2, 3])
				assert.match(JSON.stringify(await host.readTranscript(child.id)), /COMPACTED_AWAY_USER_CONTEXT/)
			} finally {
				await host.shutdown()
				finishRoot?.()
				await rootRun
			}
		})
	}

	it("reconstructs a real root without starting its completed children and explicitly restores an opaque child checkpoint", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		nextTurn = async () => "complete"
		const child = await host.start({ title: "persisted child", prompt: "COMPLETED_BEFORE_ROOT_CLOSE" })
		await waitForOutcome(host, child.id)
		await root.messageStateHandler.overwriteApiConversationHistory([{ role: "user", content: [{ type: "text", text: "ROOT_REOPEN_CONTEXT" }] }])
		await root.messageStateHandler.flushPendingWrites()
		await root.abortTask()
		const reopenedRoot = createResolutionRoot()
		sandbox.stub(reopenedRoot as any, "waitForFollowUp").resolves(undefined)
		const modelPresets = await import("@core/models/modelProviderPresets")
		sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
		const requestsBeforeRootResume = requests.length
		let rootRestored = false
		const outcome = await reopenedRoot.resumeTaskFromHistory(() => {
			rootRestored = true
			assert.equal(requests.length, requestsBeforeRootResume, "Reconstruction must not start a child provider request")
			assert.deepEqual(reopenedRoot.taskletHost!.listActive(), [])
			assert.equal(reopenedRoot.taskletHost!.inspect(child.id).outcome?.kind, "completed")
		}, { initialUserInput: { text: "ROOT_FOLLOWUP" } })
		assert.equal(outcome.kind, "completed", JSON.stringify(outcome))
		assert.equal(rootRestored, true)
		assert.equal(requests.length, requestsBeforeRootResume + 1, "Only the root model ran")
		await reopenedRoot.abortTask()

		const reconstructed = createHost()
		try {
			await reconstructed.reconstruct()
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			const saved = await getSavedApiConversationState(address)
			const checkpoint = {
				providerId: "anthropic", modelId: "claude-opus-4-20250514", compactedThroughHistoryIndex: saved.messages.length - 1,
				input: [{ type: "compaction", encrypted_content: "PRIVATE_OPAQUE_CHILD_CHECKPOINT" }],
			}
			await saveApiConversationProviderState(address, { checkpoint })
			const buildApi = apiModule.buildApiHandler as sinon.SinonStub
			const handler = buildApi(parameters().workingConfiguration.apiConfiguration, "act") as ApiHandler
			const createMessage = handler.createMessage.bind(handler)
			// Capture the real request-loop dispatch options at the controlled provider boundary.
			let dispatchedOptions: unknown
			handler.createMessage = function (systemPrompt, messages, tools, options) {
				dispatchedOptions = structuredClone(options)
				return createMessage(systemPrompt, messages, tools, options)
			}
			buildApi.callsFake(() => handler)
			await reconstructed.resume(child.id, "FOLLOWUP_AFTER_RECONSTRUCTION")
			const result = await waitForOutcome(reconstructed, child.id)
			assert.equal(result.outcome?.kind, "completed", JSON.stringify(result))
			assert.equal(result.conversationUlid, child.conversationUlid)
			assert.deepEqual((dispatchedOptions as any).checkpoint, checkpoint)
			assert.deepEqual((await getSavedApiConversationProviderState(address)).checkpoint, checkpoint)
			const input = JSON.stringify(requests.at(-1)!.messages)
			assert.equal(input.split("Tasklet resumed.").length - 1, 1)
			assert.match(input, /FOLLOWUP_AFTER_RECONSTRUCTION/)
			assert.doesNotMatch(input, /COMPLETED_BEFORE_ROOT_CLOSE/)
			assert.match(JSON.stringify(await reconstructed.readTranscript(child.id)), /COMPLETED_BEFORE_ROOT_CLOSE/)
		} finally {
			await reconstructed.shutdown()
		}
	})

	it("reopens an interrupted real permission conversation without reactivating or replaying its command while a sibling completes", async () => {
		expectLoggerErrors() // Interrupting the actual command approval wait is expected cancellation.
		const root = createResolutionRoot()
		let turn = 0
		nextTurn = async () => ++turn === 1 ? "execute_command" : "complete"
		const child = await root.taskletHost!.start({ title: "permission wait", prompt: "REQUEST_COMMAND_ONCE" })
		const oldRequest = await waitForInteraction(root.taskletHost!, child.id)
		await root.abortTask()
		assert.equal(root.taskletHost!.inspect(child.id).interactions[0].status, "retired")
		const host = createHost()
		try {
			const beforeReconstruct = requests.length
			await host.reconstruct()
			assert.equal(requests.length, beforeReconstruct)
			assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
			assert.equal(host.inspect(child.id).interactions[0].status, "retired")
			await assert.rejects(host.resolveInteraction(child.id, oldRequest.id, { operation: "approve" }), /not pending/)
			const sibling = await host.start({ title: "independent", prompt: "SIBLING_AFTER_REOPEN" })
			assert.equal((await waitForOutcome(host, sibling.id)).outcome?.kind, "completed")
			await host.resume(child.id, "DO_NOT_EXECUTE_PREVIOUS_COMMAND")
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			assert.equal(requests.length, 3, "Reopening adds only the sibling turn and explicit resumed turn")
			const resumedInput = JSON.stringify(requests[2].messages)
			assert.match(resumedInput, /REQUEST_COMMAND_ONCE/)
			assert.match(resumedInput, /DO_NOT_EXECUTE_PREVIOUS_COMMAND/)
			assert.equal(resumedInput.split("Tasklet resumed.").length - 1, 1)
			assert.equal(host.inspect(child.id).interactions.filter((request) => request.status === "pending").length, 0)
			assert.equal(host.inspect(sibling.id).outcome?.kind, "completed")
			await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		} finally {
			await host.shutdown()
		}
	})

	describe("durable tasklet usage attribution", () => {
		it("counts two real children and the executing root once each in persisted root accounting", async () => {
			const root = createResolutionRoot()
			sandbox.stub(root as any, "waitForFollowUp").resolves(undefined)
			const modelPresets = await import("@core/models/modelProviderPresets")
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			let rootTurn = true
			const ids: string[] = []
			nextTurn = async () => {
				if (rootTurn) {
					rootTurn = false
					const children = await Promise.all([
						root.taskletHost!.start({ title: "first usage", prompt: "FIRST_USAGE" }),
						root.taskletHost!.start({ title: "second usage", prompt: "SECOND_USAGE" }),
					])
					ids.push(...children.map((child) => child.id))
					await Promise.all(ids.map((id) => waitForOutcome(root.taskletHost!, id)))
				}
				return "complete"
			}
			assert.equal((await root.startTask("ROOT_USAGE")).kind, "completed")
			const messages = root.messageStateHandler.getDiracMessages()
			const metrics = getApiMetrics(messages)
			assert.equal(metrics.totalTokensIn, 300)
			assert.equal(metrics.totalTokensOut, 60)
			const contributions = messages.flatMap((message) => message.content.type === DiracMessageType.CARD
				? [getTaskletUsage(message.content.card)].filter((usage) => usage !== undefined) : [])
			assert.deepEqual(contributions.map((usage) => usage.taskletId).sort(), ids.sort())
			for (const id of ids) {
				assert.equal(root.taskletHost!.inspect(id).usage?.primary.tokensIn, 100)
				assert.equal(root.taskletHost!.inspect(id).usage?.primary.tokensOut, 20)
			}
			const persisted = (await getSavedPresentationHistory("root")).messages
			assert.equal(getApiMetrics(persisted).totalTokensIn, 300)
			assert.equal(requests.length, 3)
		})

		it("adds only new primary spend when a completed real tasklet resumes under its stable handle", async () => {
			const root = createResolutionRoot()
			const host = root.taskletHost!
			nextTurn = async () => "complete"
			const child = await host.start({ title: "usage follow-up", prompt: "FIRST_USAGE_TURN" })
			assert.equal((await waitForOutcome(host, child.id)).usage?.primary.tokensIn, 100)
			await host.resume(child.id, "SECOND_USAGE_TURN")
			const resumed = await waitForOutcome(host, child.id)
			assert.equal(resumed.outcome?.kind, "completed")
			assert.equal(resumed.conversationUlid, child.conversationUlid)
			assert.equal(resumed.usage?.primary.tokensIn, 200)
			assert.equal(resumed.usage?.primary.tokensOut, 40)
			assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, 200)
			const cards = root.messageStateHandler.getDiracMessages().filter((message) =>
				message.content.type === DiracMessageType.CARD && getTaskletUsage(message.content.card))
			assert.equal(cards.length, 1, "Follow-up replaces the stable accounting projection")
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			const record = JSON.parse(await fs.readFile(path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord), "utf8"))
			assert.deepEqual(record.usage, resumed.usage)
		})

		it("preserves durable primary spend ahead of its transcript through reconstruction and explicit resumption", async () => {
			const root = createResolutionRoot()
			nextTurn = async () => "complete"
			const child = await root.taskletHost!.start({ title: "ahead of transcript", prompt: "PERSIST_TRANSCRIPT_USAGE" })
			await waitForOutcome(root.taskletHost!, child.id)
			await root.abortTask()
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			assert.equal(getApiMetrics((await getSavedPresentationHistory(address)).messages).totalTokensIn, 100)
			const recordPath = path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord)
			const record = JSON.parse(await fs.readFile(recordPath, "utf8"))
			record.usage.primary = {
				tokensIn: 200, tokensOut: 40, cacheWrites: 6, cacheReads: 8, cost: 1.25, reasoningTokens: 10,
			}
			await fs.writeFile(recordPath, JSON.stringify(record))

			const reopened = createResolutionRoot()
			const host = reopened.taskletHost!
			await host.reconstruct()
			await host.reconcileUsage()
			assert.equal(requests.length, 1, "Reconstruction does not run a provider")
			assert.equal(host.inspect(child.id).usage?.primary.tokensIn, 200)
			assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, 200)
			await host.resume(child.id, "INCUR_ONLY_ONE_NEW_REQUEST")
			const resumed = await waitForOutcome(host, child.id)
			assert.equal(resumed.outcome?.kind, "completed")
			assert.equal(resumed.conversationUlid, child.conversationUlid)
			assert.deepEqual(resumed.usage?.primary, {
				tokensIn: 300, tokensOut: 60, cacheWrites: 6, cacheReads: 8, cost: 1.25, reasoningTokens: 10,
			})
			const metrics = getApiMetrics(reopened.messageStateHandler.getDiracMessages())
			assert.equal(metrics.totalTokensIn, 300)
			assert.equal(metrics.totalTokensOut, 60)
			assert.equal(metrics.totalCacheWrites, 6)
			assert.equal(metrics.totalCacheReads, 8)
			assert.equal(metrics.totalCost, 1.25)
			assert.equal(metrics.totalReasoningTokens, 10)
			assert.deepEqual(JSON.parse(await fs.readFile(recordPath, "utf8")).usage, resumed.usage)
			assert.equal(requests.length, 2, "Only explicit resumption incurs another provider request")
		})

		it("retains incurred primary usage across interruption and counts only the resumed request anew", async () => {
			expectLoggerErrors() // Interrupting the real permission wait is expected tool cancellation.
			const root = createResolutionRoot()
			const host = root.taskletHost!
			nextTurn = async () => requests.length === 1 ? "execute_command" : "complete"
			const child = await host.start({ title: "interrupted usage", prompt: "REQUEST_USAGE_THEN_PERMISSION" })
			await waitForInteraction(host, child.id)
			const stopped = await host.interrupt(child.id, "Retain incurred spend")
			assert.equal(stopped.outcome?.kind, "interrupted")
			assert.equal(stopped.usage?.primary.tokensIn, 100)
			assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, 100)
			await host.resume(child.id, "Continue without the retired command")
			const resumed = await waitForOutcome(host, child.id)
			assert.equal(resumed.outcome?.kind, "completed")
			assert.equal(resumed.usage?.primary.tokensIn, 200)
			assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, 200)
			assert.equal(requests.length, 2)
		})

		it("restores root accounting after presentation loading without constructing or charging historical child runs again", async () => {
			const root = createResolutionRoot()
			nextTurn = async () => "complete"
			const child = await root.taskletHost!.start({ title: "durable usage", prompt: "PERSIST_USAGE" })
			await waitForOutcome(root.taskletHost!, child.id)
			await root.messageStateHandler.overwriteApiConversationHistory([{ role: "user", content: [{ type: "text", text: "ROOT_REOPEN_USAGE" }] }])
			await root.abortTask()
			const reopened = createResolutionRoot()
			sandbox.stub(reopened as any, "waitForFollowUp").resolves(undefined)
			const modelPresets = await import("@core/models/modelProviderPresets")
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			let restored = false
			assert.equal((await reopened.resumeTaskFromHistory(() => {
				restored = true
				assert.equal(requests.length, 1, "Reconstruction does not run child providers")
				assert.deepEqual(reopened.taskletHost!.listActive(), [])
				assert.equal(reopened.taskletHost!.inspect(child.id).usage?.primary.tokensIn, 100)
				assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, 100)
			}, { initialUserInput: { text: "ROOT_ONLY_NEW_USAGE" } })).kind, "completed")
			assert.equal(restored, true)
			assert.equal(requests.length, 2)
			assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, 200)
			assert.equal(getApiMetrics((await getSavedPresentationHistory("root")).messages).totalTokensIn, 200)
		})

		for (const invalidSummary of [false, true]) {
			it(`retains actual Utility compaction ${invalidSummary ? "failed-summary" : "successful-summary"} spend through real tasklet resumption`, async () => {
				const root = createResolutionRoot()
				const host = root.taskletHost!
				const started = sandbox.spy(Task.prototype, "startTask")
				const utilityHandler = {
					getModel: () => ({ id: "controlled-utility", info: { contextWindow: 200_000, maxTokens: 8192, supportsPromptCache: false } }),
					async *createMessage(): ApiStream {
						yield { type: "usage", inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, totalCost: 0.5 }
						yield { type: "text", text: invalidSummary ? "" : "Continue the private assignment under the parent's constraints." }
					},
				} as ApiHandler
				let generated = false
				nextTurn = async () => {
					if (!generated) {
						generated = true
						const task = started.firstCall.thisValue as Task
						const summary = (task as any).localConversationCompaction.generateSummary(
							{ provider: "anthropic", modelId: "controlled-utility" }, () => utilityHandler,
							createDefaultTextCondensationTemplateRegistry(), undefined, [],
						)
						if (invalidSummary) await assert.rejects(summary, /empty|output/i)
						else assert.match(await summary, /private assignment/)
					}
					return "complete"
				}
				const child = await host.start({ title: "Utility usage", prompt: "INCUR_UTILITY_USAGE" })
				const first = await waitForOutcome(host, child.id)
				assert.equal(first.outcome?.kind, "completed")
				assert.equal(first.usage?.primary.tokensIn, 100)
				assert.deepEqual(first.usage?.utility, {
					tokensIn: 11, tokensOut: 7, cacheWrites: 1, cacheReads: 2, cost: 0.5, reasoningTokens: 3,
				})
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, 111)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalCost, 0.5)
				await host.resume(child.id, "FOLLOWUP_WITHOUT_NEW_UTILITY_USAGE")
				const second = await waitForOutcome(host, child.id)
				assert.deepEqual(second.usage?.utility, first.usage?.utility)
				assert.equal(second.usage?.primary.tokensIn, 200)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalTokensIn, 211)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalCost, 0.5)
			})
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
