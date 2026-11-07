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
import {
	getSavedApiConversationState,
	getSavedApiConversationProviderState,
	getSavedPresentationHistory,
	saveApiConversationProviderState,
	saveApiConversationHistory,
	saveDiracMessages,
} from "@core/storage/conversationHistory"
import { GlobalFileNames } from "@core/storage/fileNames"
import { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { updateTaskMetadata } from "@core/storage/taskStorage"
import * as checkpointFactory from "@integrations/checkpoints/factory"
import { ErrorService } from "@/services/error/ErrorService"
import { HostProvider } from "@/hosts/host-provider"
import { SETTINGS_DEFAULTS, type Settings } from "@/shared/storage/state-keys"
import type { Mode } from "@/shared/storage/types"
import { DiracAskResponse } from "@/shared/WebviewMessage"
import { CardKind, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import * as notifications from "@integrations/notifications"
import * as retryPolicy from "@core/api/ApiRequestRetryPolicy"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { Task, TaskletHost, type TaskParams, type TaskletTaskOptions } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import * as taskLocks from "../TaskLockUtils"
import { SqliteLockManager } from "@core/locks/SqliteLockManager"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { getApiMetrics } from "@shared/getApiMetrics"
import { getTaskletUsage } from "@shared/taskletUsage"
import { createDefaultTextCondensationTemplateRegistry } from "@core/text-condensation/templates"
import { AgentConfigLoader, type AgentBaseConfig } from "../tools/subagent/AgentConfigLoader"
import * as skillsModule from "@core/context/instructions/user-instructions/skills"
import type { DiracStorageMessage } from "@shared/messages/content"
import { TaskletsTool } from "../tools/modules/use_subagents/UseSubagentsTool"
import { ToolExecutorCoordinator } from "../tools/ToolExecutorCoordinator"
import { GoalCoordinatorToolEnvironmentFactory } from "@core/goal/GoalCoordinatorEnvironment"
import { GoalLoop } from "@core/goal/GoalLoop"
import { GoalStore } from "@core/goal/GoalStore"
import { GoalTaskFactory } from "@core/goal/GoalTaskFactory"
import { createGoalHistoryItem } from "@core/goal/GoalHistory"
import * as modelProviderPresets from "@core/models/modelProviderPresets"
import { SurfaceAdapter } from "../tools/adapters/SurfaceAdapter"
import type { IGoalTrait } from "../tools/interfaces/IToolEnvironment"
import type { HistoryItem } from "@shared/HistoryItem"

type Request = { mode: Mode; model: string; systemPrompt: string; messages: unknown; tools: string[] }
type ProviderToolCall = {
	name: string
	args: Record<string, unknown>
	usage?: Extract<import("@core/api/transform/stream").ApiStreamChunk, { type: "usage" }>
}

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
	let requestLimit: number
	let nextTurn:
		| ((
			mode: Mode,
			request: Request,
		) => Promise<
			| "progress"
			| "plan"
			| "complete"
			| "question"
			| "read_file"
			| "execute_command"
			| "condense"
			| "allowed_skill"
			| "excluded_skill"
		>)
		| undefined
	let nextTool: ((request: Request) => Promise<ProviderToolCall>) | undefined

	function rejectCall(name: string) {
		const spy = sandbox.stub().callsFake(() => {
			throw new Error(`Tasklet escaped to ${name}`)
		})
		forbidden.push(spy)
		return spy
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tasks = []
		requests = []
		forbidden = []
		nextTurn = undefined
		nextTool = undefined
		requestLimit = 3
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
				setShellIntegrationTimeout() { },
				setTerminalReuseEnabled() { },
				setTerminalOutputLineLimit() { },
				setDefaultTerminalProfile() { },
				getTerminals: () => [],
				disposeAll: async () => { },
			})) as any,
		})
		sandbox.stub(HostProvider, "env" as any).value({ getHostVersion: async () => ({ platform: "linux", diracType: 0 }) })
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: async () => ({ paths: [] }),
			getVisibleTabs: async () => ({ paths: [] }),
			showMessage: rejectCall("host message"),
		})
		// No checkpoint capability is disabled in production or in the working configuration.
		sandbox.stub(checkpointFactory, "buildCheckpointManager").returns({
			isEnabled: () => true,
			initialize: async () => { },
			commit: async () => undefined,
			saveCheckpoint: async () => { },
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
		sandbox.stub(ErrorService, "get").returns({
			toDiracError: (error: unknown) => {
				throw error
			},
		} as unknown as ErrorService)
		sandbox.stub(taskLocks, "acquireTaskLock").callsFake(rejectCall("root lock acquisition"))
		sandbox.stub(SqliteLockManager.prototype, "registerFolderLock").callsFake(rejectCall("SQLite lock acquisition"))
		sandbox.stub(SqliteLockManager.prototype, "releaseFolderLockByTarget").callsFake(rejectCall("SQLite lock release"))
		sandbox.stub(apiModule, "buildApiHandler").callsFake((configuration, mode) => {
			const model = (mode === "plan" ? configuration.planModeApiModelId : configuration.actModeApiModelId)!
			const handler: ApiHandler = {
				getModel: () => ({
					id: model,
					info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false },
				}),
				async *createMessage(systemPrompt, messages, tools): ApiStream {
					const request = {
						mode,
						model,
						systemPrompt,
						messages: structuredClone(messages),
						tools: (tools ?? []).map((tool) => (tool as { name: string }).name),
					}
					requests.push(request)
					assert.ok(requests.length <= requestLimit, "Unexpected retry/request after controlled completion")
					if (nextTool) {
						const callId = `scripted-${requests.length}`
						const call = await nextTool(request)
						assert.ok(request.tools.includes(call.name), `Controlled provider tool ${call.name} must be advertised`)
						yield {
							type: "tool_calls",
							tool_call: { call_id: callId, function: { name: call.name, arguments: JSON.stringify(call.args) } },
						}
						yield call.usage ?? { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
						return
					}
					const operation = (await nextTurn?.(mode, request)) ?? (requests.length === 1 ? "read_file" : "complete")
					yield {
						type: "tool_calls",
						tool_call: {
							call_id: `call-${requests.length}`,
							function: {
								name:
									operation === "allowed_skill" || operation === "excluded_skill"
										? "use_skill"
										: operation === "read_file" || operation === "execute_command" || operation === "condense"
											? operation
											: "respond",
								arguments: JSON.stringify(
									operation === "allowed_skill" || operation === "excluded_skill"
										? { skill_name: operation }
										: operation === "read_file"
											? { paths: ["assignment.txt"] }
											: operation === "execute_command"
												? { commands: ["touch permission-bypass-marker"] }
												: operation === "condense"
													? { context: "Private continuation summary" }
													: {
														operation,
														text:
															operation === "complete"
																? "Private assignment complete."
																: "Private Plan analysis.",
													},
								),
							},
						},
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
				...SETTINGS_DEFAULTS,
				mode,
				enableCheckpointsSetting: true,
				subagentsEnabled: true,
				autoApprovalSettings: { ...SETTINGS_DEFAULTS.autoApprovalSettings!, enableNotifications: false },
				toolToggles: { read_file: true, execute_command: true },
			} as Settings,
			apiConfiguration: {
				planModeApiProvider: "anthropic",
				actModeApiProvider: "anthropic",
				planModeApiModelId: "claude-sonnet-4-20250514",
				actModeApiModelId: "claude-opus-4-20250514",
			},
			workspaceConfiguration: {} as any,
			executionOptions: {
				terminalReuseEnabled: true,
				vscodeTerminalExecutionMode: "vscodeTerminal",
				multiRootEnabled: false,
			},
		})
	}

	function parameters(mode: Mode = "act"): TaskParams {
		const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: createTaskletId() }
		return {
			controller: {
				updateBackgroundCommandState: rejectCall("controller background state"),
				toggleActModeForYoloMode: rejectCall("controller mode"),
				getWorkspaceManager: rejectCall("controller workspace"),
			} as any,
			updateTaskHistory: rejectCall("root history"),
			postStateToWebview: rejectCall("root state"),
			postPresentationToWebview: rejectCall("root presentation"),
			reinitExistingTaskFromId: rejectCall("root reinit"),
			cancelTask: rejectCall("root cancellation"),
			updateBackgroundCommandState: rejectCall("root background state"),
			switchToActMode: rejectCall("root mode"),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd,
			stateManager,
			workingConfiguration: configuration(mode),
			task: "Complete a private assignment.",
			taskId: address.taskletId,
			executionProfile: "tasklet",
			pinnedContext: "PINNED_PRIVATE_CONSTRAINT",
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "read_file"] },
			tasklet: {
				// Controlled answers exercise legacy execution/resource cases, not production host authorization.
				counterparty: {
					recordResponse: sandbox.stub().resolves(),
					requestInteraction: sandbox
						.stub()
						.resolves({ response: DiracAskResponse.APPROVE, action: DiracAskResponse.APPROVE }),
				},
				storageAddress: address,
				postStateToOwner: sandbox.stub().resolves(),
				withMutationAuthorization: (_toolName, mutation) => mutation(),
				retainMutationUntil: () => { },
				postPresentationToOwner: sandbox.stub().resolves(),
				updateBackgroundCommandState: sandbox.stub(),
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
		const files = [
			GlobalFileNames.apiConversationHistoryOperations,
			GlobalFileNames.apiConversationProviderState,
			GlobalFileNames.uiMessageOperations,
			GlobalFileNames.taskMetadata,
			"settings.json",
		]
		return Promise.all(
			files.map(async (name) => {
				const file = path.join(base, name)
				const contents = `preserve:${JSON.stringify(address)}:${name}\n`
				await fs.writeFile(file, contents)
				return { file, contents }
			}),
		)
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

	function createHost(params = parameters(), getParentHistory?: TaskletTaskOptions["getParentHistory"]) {
		const options: TaskletTaskOptions = {
			controller: params.controller,
			cwd,
			stateManager,
			workingConfiguration: params.workingConfiguration,
			shellIntegrationTimeout: params.shellIntegrationTimeout,
			terminalReuseEnabled: params.terminalReuseEnabled,
			terminalOutputLineLimit: params.terminalOutputLineLimit,
			defaultTerminalProfile: params.defaultTerminalProfile,
			vscodeTerminalExecutionMode: params.vscodeTerminalExecutionMode,
			toolSelectionPolicy: params.toolSelectionPolicy,
			pinnedContext: params.pinnedContext,
			getParentHistory,
		}
		return new TaskletHost(
			{
				taskId: "root",
				executionProfile: "standalone",
				authorizePermission: rejectCall("unconfigured owner authorization"),
				assertPermissionAllowed: rejectCall("unconfigured owner authority"),
				escalateInteraction: rejectCall("unconfigured owner escalation"),
				hasPendingUserInput: () => false,
				withMutationAuthorization: (_toolName, mutation) => mutation(),
				retainMutationUntil: () => { },
			},
			options,
		)
	}

	function deferred<T>() {
		let resolve!: (value: T) => void
		const promise = new Promise<T>((settle) => {
			resolve = settle
		})
		return { promise, resolve }
	}

	async function createGoalExecution(status: "paused" | "achieved" = "paused") {
		const acquisition = taskLocks.acquireTaskLock as sinon.SinonStub
		acquisition.restore()
		// Successful foreground turns may remember model presets; this fixture never changes user preferences.
		sandbox.stub(modelProviderPresets, "recordSuccessfulModelProviderPreset")
		requestLimit = 20
		const store = new GoalStore()
		let record = await store.create("root", "01M0TW092EXA0KHTW38ZXJ1GCQ", "ROOT_GOAL_ASSIGNMENT")
		if (status === "achieved") {
			await store.transition("root", { status: "working" })
			record = await store.transition("root", { status: "achieved" })
		}
		const history: HistoryItem[] = [createGoalHistoryItem(record, "ROOT_GOAL_ASSIGNMENT", cwd)]
		sandbox.stub(stateManager, "getGlobalStateKey").callsFake((key) => (key === "taskHistory" ? history : undefined))
		const factory = new GoalTaskFactory({
			controller: parameters().controller as any,
			stateManager,
			cwd,
			workspaceManager: undefined as any,
			workingConfiguration: configuration("act"),
			postCoordinatorState: async () => { },
		})
		const created = sandbox.spy(factory, "create")
		const loop = new GoalLoop({
			goalId: "root",
			initialDisplayText: "ROOT_GOAL_ASSIGNMENT",
			store,
			createTaskFactory: () => factory,
			stateManager,
			updateHistory: async (item) => {
				history[0] = item
				return history
			},
			postState: async () => { },
			workspaceRootPath: cwd,
		})
		return { loop, store, history, created }
	}

	function isGoalRequest(request: Request) {
		return /# GOAL (?:COORDINATOR|FOLLOW-UP)/.test(request.systemPrompt)
	}

	for (const execution of ["coordinator", "paused follow-up", "achieved follow-up"] as const) {
		it(`dispatches generic, named, verification and inspection tools through a real Goal ${execution}`, async () => {
			const h = await createGoalExecution(execution === "achieved follow-up" ? "achieved" : "paused")
			const profile: AgentBaseConfig = {
				name: "goal-reviewer",
				description: "Controlled Goal reviewer",
				tools: [],
				systemPrompt: "NAMED_GOAL_REVIEWER_INSTRUCTIONS",
			}
			const loader = Object.assign(Object.create(AgentConfigLoader.prototype), {
				cachedConfigs: new Map<string, AgentBaseConfig>(),
				cachedAgentToolNames: new Map<string, string>(),
				cachedToolNameToAgentName: new Map<string, string>(),
			}) as AgentConfigLoader
			sandbox.stub(AgentConfigLoader, "getInstance").returns(loader)
			let rootTurn = 0
			let genericId = ""
			let namedId = ""
			let verificationId = ""
			const toolResults = (request: Request) =>
				(request.messages as DiracStorageMessage[])
					.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
					.flatMap((block) =>
						block.type === "tool_result" && typeof block.content === "string" ? [block.content] : [],
					)
			nextTool = async (request) => {
				if (!isGoalRequest(request)) {
					for (const forbiddenTool of [
						"use_subagents",
						"use_subagent_goal_reviewer",
						"tasklets",
						"verify_goal",
						"update_goal",
						"block_goal",
					]) {
						assert.equal(request.tools.includes(forbiddenTool), false, forbiddenTool)
					}
					assert.match(request.systemPrompt, /# CONTAINED TASKLET/)
					return { name: "respond", args: { operation: "complete", text: "GOAL_PRIVATE_WORK_COMPLETE" } }
				}
				for (const name of ["tasklets", "verify_goal", "update_goal", "block_goal"])
					assert.ok(request.tools.includes(name), `Goal must advertise ${name}`)
				assert.ok(request.tools.includes(rootTurn === 0 ? "use_subagents" : "use_subagent_goal_reviewer"))
				for (const name of [
					"start_task",
					"list_tasks",
					"send_task_message",
					"cancel_task",
					"read_task_transcript",
					"resolve_task_interaction",
					"wait_for_goal_events",
				]) {
					assert.equal(request.tools.includes(name), false, `Retired tool ${name}`)
				}
				const root = h.loop.coordinator!
				const turn = ++rootTurn
				if (turn === 1) {
					// Keep this request's generic native schema, then advertise the named
					// profile on the next request. Dispatch and both children remain real.
					loader["cachedConfigs"].set(profile.name, profile)
					loader["cachedAgentToolNames"].set(profile.name, "use_subagent_goal_reviewer")
					loader["cachedToolNameToAgentName"].set("use_subagent_goal_reviewer", profile.name)
					const executor = (root as any).toolExecutor
					executor.markToolsDirty("manual_refresh")
					return {
						name: "use_subagents",
						args: { subagents: [{ task_title: "Generic Goal worker", prompt: "GENERIC_GOAL_ASSIGNMENT" }] },
					}
				}
				if (turn === 2 || turn === 3) {
					const result = JSON.parse(toolResults(request).at(-1)!).subagents[0]
					assert.equal(result.accepted, true)
					assert.equal(result.outcome, undefined, "Public spawn returns acceptance, not assignment completion")
					assert.match(result.id, /^tasklet_[0-9a-f-]{36}$/)
					assert.equal((await waitForOutcome(root.taskletHost!, result.id)).outcome?.kind, "completed")
					if (turn === 2) {
						genericId = result.id
						return {
							name: "use_subagent_goal_reviewer",
							args: { task_title: "Named Goal reviewer", prompt: "NAMED_GOAL_ASSIGNMENT" },
						}
					}
					namedId = result.id
					return { name: "verify_goal", args: { focus: "VERIFY_CURRENT_GOAL_FOCUS" } }
				}
				if (turn === 4) {
					const verification = JSON.parse(toolResults(request).at(-1)!)
					verificationId = verification.id
					assert.equal(verification.purpose, "goal_verification")
					assert.match(verification.prompt, /ROOT_GOAL_ASSIGNMENT/)
					assert.match(verification.prompt, /VERIFY_CURRENT_GOAL_FOCUS/)
					assert.ok(verification.prompt.includes(genericId) && verification.prompt.includes(namedId))
					assert.equal((await waitForOutcome(root.taskletHost!, verificationId)).outcome?.kind, "completed")
					return { name: "tasklets", args: { operation: "inspect", tasklet_id: verificationId } }
				}
				assert.equal(turn, 5, "No retry or additional parent loop after public completion")
				const inspection = JSON.parse(toolResults(request).at(-1)!)
				assert.equal(inspection.items[0].id, verificationId)
				assert.equal(inspection.items[0].outcome.kind, "completed")
				assert.equal(inspection.items[0].outcome.summary, "GOAL_PRIVATE_WORK_COMPLETE")
				const view = await h.loop.inspect()
				assert.equal("children" in view, false)
				assert.equal(view.latestVerification?.id, verificationId)
				assert.equal(view.latestVerification?.status, "completed")
				assert.equal("pendingInteractionCount" in view, false)
				return { name: "respond", args: { operation: "complete", text: "GOAL_PUBLIC_SUPERVISION_COMPLETE" } }
			}
			try {
				if (execution === "coordinator") await h.loop.start()
				else await h.loop.sendMessage("Explicit public Goal follow-up")
				await h.loop["runtime"]!.settlement!
				assert.equal(rootTurn, 5)
				assert.equal(requests.filter((request) => !isGoalRequest(request)).length, 3)
				assert.ok(requests.some((request) => request.systemPrompt.includes("NAMED_GOAL_REVIEWER_INSTRUCTIONS")))
				assert.equal((await h.store.read("root")).status, execution === "paused follow-up" ? "paused" : "achieved")
				const saved = await h.loop.inspect()
				assert.equal(saved.latestVerification?.id, verificationId, "Verification purpose survives disk-only inspection")
				assert.equal("children" in saved, false)
			} finally {
				await h.loop.cancelCurrentExecution()
			}
		})
	}

	for (const execution of ["coordinator", "paused follow-up", "achieved follow-up"] as const) {
		it(`changes only pursuing Goal user-wait status during shared escalation for ${execution}`, async () => {
			const h = await createGoalExecution(execution === "achieved follow-up" ? "achieved" : "paused")
			const rootEntered = deferred<void>()
			const rootGate = deferred<void>()
			let childTurn = 0
			nextTurn = async (_mode, request) => {
				if (isGoalRequest(request)) {
					rootEntered.resolve()
					await rootGate.promise
					return "complete"
				}
				return ++childTurn === 1 ? "question" : childTurn <= 3 ? "execute_command" : "complete"
			}
			try {
				if (execution === "coordinator") await h.loop.start()
				else await h.loop.sendMessage("Explicit escalation follow-up")
				await rootEntered.promise
				const root = h.loop.coordinator!
				const host = root.taskletHost!
				const expectedStatus =
					execution === "coordinator" ? "working" : execution === "paused follow-up" ? "paused" : "achieved"
				await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
				const child = await host.start({ title: "Goal permission worker", prompt: "GOAL_CHILD_INTERACTION_ASSIGNMENT" })
				const question = await waitForInteraction(host, child.id)
				assert.equal((await h.store.read("root")).status, expectedStatus, "Child-local question is not a user wait")
				assert.equal(root.stateView.lastWaitingCardId, undefined)
				await host.resolveInteraction(child.id, question.id, {
					operation: "answer",
					response: {
						action: DiracAskResponse.MESSAGE,
						response: DiracAskResponse.MESSAGE,
						text: "GOAL_PARENT_ANSWER",
					},
				})
				const permission = await waitForInteraction(host, child.id)
				assert.equal(permission.permissionOperation?.kind, "commands")
				await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: false } })
				assert.equal((await h.store.read("root")).status, expectedStatus)
				assert.deepEqual(await host.resolveInteraction(child.id, permission.id, { operation: "approve" }), {
					status: "requires_user_approval",
				})
				const escalation = host.resolveInteraction(child.id, permission.id, { operation: "escalate" })
				const card = await waitForRootCard(root)
				assert.equal((await h.store.read("root")).status, execution === "coordinator" ? "waiting" : expectedStatus)
				assert.notEqual(card.id, permission.card.id)
				await root.submitCardResponse(card.id, DiracAskResponse.REJECT)
				assert.deepEqual(await escalation, { status: "resolved" })
				assert.equal((await h.store.read("root")).status, expectedStatus)
				const nextPermission = await waitForInteraction(host, child.id)
				assert.notEqual(nextPermission.id, permission.id)
				assert.deepEqual(await host.resolveInteraction(child.id, nextPermission.id, { operation: "approve" }), {
					status: "requires_user_approval",
				})
				await host.resolveInteraction(child.id, nextPermission.id, { operation: "reject" })
				assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
				await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
				const settlement = h.loop["runtime"]!.settlement!
				rootGate.resolve()
				await settlement
				assert.equal((await h.store.read("root")).status, execution === "coordinator" ? "achieved" : expectedStatus)
			} finally {
				rootGate.resolve()
				await h.loop.cancelCurrentExecution()
			}
		})
	}

	for (const unknownSource of ["none", "root primary", "root Utility", "child primary", "child Utility"] as const) {
		it(`counts shared Goal usage once across reconstruction and explicit child resume (${unknownSource} unavailable)`, async () => {
			expectLoggerErrors() // Pausing deliberately releases controlled provider chunks after cancellation.
			const h = await createGoalExecution()
			const started = sandbox.spy(Task.prototype, "startTask")
			let rootEntered = deferred<void>()
			let rootGate = deferred<void>()
			let rootTurn = 0
			let addChildUtility = true
			const knownUsage = {
				type: "usage" as const,
				inputTokens: 100,
				outputTokens: 20,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0,
				stopReason: "tool_use",
			}
			const utilityHandler = {
				getModel: () => ({
					id: "controlled-goal-utility",
					info: { contextWindow: 200_000, maxTokens: 8192, supportsPromptCache: false },
				}),
				async *createMessage(): ApiStream {
					yield unknownSource === "child Utility"
						? { type: "usage", inputTokens: 11, outputTokens: 7 }
						: {
							type: "usage",
							inputTokens: 11,
							outputTokens: 7,
							reasoningTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalCost: 0,
						}
					yield { type: "text", text: "Continue under the Goal parent's assignment and current constraints." }
				},
			} as ApiHandler
			const rootUtilityHandler = {
				...utilityHandler,
				async *createMessage(): ApiStream {
					yield unknownSource === "root Utility"
						? { type: "usage", inputTokens: 11, outputTokens: 7 }
						: {
							type: "usage",
							inputTokens: 11,
							outputTokens: 7,
							reasoningTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalCost: 0,
						}
					yield { type: "text", text: "Continue the Goal objective without replaying contained work." }
				},
			} as ApiHandler
			const incurUtility = async (task: Task, handler: ApiHandler) => {
				assert.ok(
					await (task as any).localConversationCompaction.generateSummary(
						{ provider: "anthropic", modelId: "controlled-goal-utility" },
						() => handler,
						createDefaultTextCondensationTemplateRegistry(),
						undefined,
						[],
					),
				)
			}
			nextTool = async (request) => {
				if (isGoalRequest(request)) {
					const usage =
						unknownSource === "root primary"
							? { type: "usage" as const, inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
							: knownUsage
					if (++rootTurn === 1)
						return {
							name: "respond",
							args: { operation: "progress", text: "Accounting scenario in progress" },
							usage,
						}
					rootEntered.resolve()
					await rootGate.promise
					return { name: "respond", args: { operation: "complete", text: "Goal accounting complete" }, usage }
				}
				if (addChildUtility) {
					addChildUtility = false
					await incurUtility(started.lastCall.thisValue as Task, utilityHandler)
				}
				return {
					name: "respond",
					args: { operation: "complete", text: "Accounted private work complete" },
					usage:
						unknownSource === "child primary"
							? { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
							: knownUsage,
				}
			}
			const assertAvailability = (accounting: import("@shared/goal").GoalAccounting) => {
				for (const field of ["cost", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
					assert.equal(
						accounting[field],
						unknownSource === "none" ? 0 : undefined,
						`${field}: known zero must not replace unavailable usage`,
					)
				}
			}
			try {
				await h.loop.start()
				await rootEntered.promise
				const original = h.loop.coordinator!
				const child = await original.taskletHost!.start({
					title: "Accounted Goal worker",
					prompt: "GOAL_ACCOUNTING_PRIVATE_ASSIGNMENT",
				})
				await waitForOutcome(original.taskletHost!, child.id)
				await incurUtility(original, rootUtilityHandler)
				await original.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				const whileParentWaiting = await h.store.read("root")
				assert.equal(
					whileParentWaiting.accounting.inputTokens,
					222,
					"Completed child and both Utility uses are accounted without another parent request",
				)
				assert.equal(whileParentWaiting.accounting.outputTokens, 54)
				assert.equal(whileParentWaiting.accounting.totalTokens, 276)
				assertAvailability(whileParentWaiting.accounting)
				const pause = h.loop.pause()
				rootGate.resolve()
				await pause
				const paused = await h.store.read("root")
				const beforeResume = paused.accounting.inputTokens!
				const beforeOutput = paused.accounting.outputTokens!
				assert.equal(paused.status, "paused")
				assertAvailability(paused.accounting)
				const requestsBeforeResume = requests.length
				rootEntered = deferred<void>()
				rootGate = deferred<void>()
				await h.loop.resume()
				await rootEntered.promise
				const resumed = h.loop.coordinator!
				assert.notEqual(resumed.taskletHost, original.taskletHost)
				assert.equal(
					requests.length,
					requestsBeforeResume + 1,
					"Only the explicit root resumes; restoring children incurs nothing",
				)
				assert.equal(resumed.taskletHost!.inspect(child.id).outcome?.kind, "completed")
				assert.equal((await h.store.read("root")).accounting.inputTokens, beforeResume)
				assertAvailability((await h.store.read("root")).accounting)
				await incurUtility(resumed, rootUtilityHandler)
				await resumed.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				assert.equal(
					(await h.store.read("root")).accounting.inputTokens,
					beforeResume + 11,
					"A fresh coordinator records its own Utility use without replacing prior incurred spend",
				)
				await resumed.taskletHost!.resume(child.id, "EXPLICIT_ACCOUNTED_GOAL_CHILD_FOLLOWUP")
				const resumedChild = await waitForOutcome(resumed.taskletHost!, child.id)
				assert.equal(resumedChild.usage?.primary.tokensIn, 200)
				assert.equal(resumedChild.usage?.utility.tokensIn, 11, "Same-ID resume retains rather than recharges Utility")
				const afterChild = await h.store.read("root")
				assert.equal(afterChild.accounting.inputTokens, beforeResume + 111)
				assert.equal(afterChild.accounting.outputTokens, beforeOutput + 27)
				assert.equal(
					Object.keys(afterChild.accountingSources).length,
					3,
					"One root lifetime snapshot plus separate per-execution root Utility sources",
				)
				assert.ok(Object.keys(afterChild.accountingSources).every((id) => id === "goal" || id.startsWith("goal/aux:")))
				assertAvailability(afterChild.accounting)
				await resumed.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				assert.deepEqual(
					(await h.store.read("root")).accounting,
					afterChild.accounting,
					"Repeated snapshots replace the same cumulative sources",
				)
				const repause = h.loop.pause()
				rootGate.resolve()
				await repause
				const beforeFollowUp = (await h.store.read("root")).accounting.inputTokens!
				rootEntered = deferred<void>()
				rootGate = deferred<void>()
				await h.loop.sendMessage("Explicit accounting follow-up without new child work")
				await rootEntered.promise
				assert.equal((await h.store.read("root")).accounting.inputTokens, beforeFollowUp)
				assert.equal(
					requests.filter((request) => !isGoalRequest(request)).length,
					2,
					"Follow-up never restarts historical children",
				)
				const followUpSettlement = h.loop["runtime"]!.settlement!
				rootGate.resolve()
				await followUpSettlement
				const followed = await h.store.read("root")
				assert.equal(followed.status, "paused")
				assert.equal(
					followed.accounting.inputTokens,
					beforeFollowUp + 100,
					"Follow-up adds only its newly incurred root request",
				)
				assertAvailability(followed.accounting)
			} finally {
				rootGate.resolve()
				await h.loop.cancelCurrentExecution()
			}
		})
	}

	for (const executionProfile of ["goal_coordinator", "goal_followup"] as const) {
		it(`owns contained real Tasks for ${executionProfile} without inheriting Goal controls`, async () => {
			const params = parameters()
			const createGoalTrait = sandbox.stub().callsFake(() => {
				throw new Error("A contained Task acquired Goal controls")
			})
			const root = create({
				...params,
				taskId: "root",
				executionProfile,
				tasklet: undefined,
				toolEnvironmentFactory: new GoalCoordinatorToolEnvironmentFactory(createGoalTrait),
				updateTaskHistory: async () => [],
				postStateToWebview: async () => { },
				postPresentationToWebview: async () => { },
			})
			nextTurn = async () => "complete"
			const host = root.taskletHost!
			assert.ok(host)
			const child = await host.start({ title: "private", prompt: "PRIVATE_GOAL_CHILD_ASSIGNMENT" })
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			assert.equal(child.rootTaskId, "root")
			assert.equal(child.configuration?.timeoutSeconds, 600)
			assert.match(requests[0].systemPrompt, /# CONTAINED TASKLET/)
			assert.equal(requests[0].mode, "act")
			sinon.assert.notCalled(createGoalTrait)
			await fs.stat(getTaskDirectoryPath({ kind: "tasklet", rootTaskId: "root", taskletId: child.id }))
			assert.deepEqual(await fs.readdir(path.dirname(getTaskDirectoryPath("root"))), ["root"])
			await root.retirePersistence()
		})
	}

	for (const operation of ["pause", "stop"] as const) {
		it(`joins real Goal children and outcome writes before ${operation} releases ownership`, async () => {
			expectLoggerErrors() // Controlled provider chunks return after cancellation.
			const h = await createGoalExecution()
			const providerGate = deferred<void>()
			const rootEntered = deferred<void>()
			const childEntered = deferred<void>()
			nextTurn = async (_mode, request) => {
				if (isGoalRequest(request)) rootEntered.resolve()
				else childEntered.resolve()
				await providerGate.promise
				return "complete"
			}
			const storage = await import("@core/storage/taskStorage")
			const saveRecord = storage.saveTaskletRecord
			const writeEntered = deferred<void>()
			const writeGate = deferred<void>()
			sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
				if (record.outcome) {
					writeEntered.resolve()
					await writeGate.promise
				}
				await saveRecord(record)
			})
			let closing: Promise<unknown> | undefined
			try {
				await h.loop.start()
				await rootEntered.promise
				const root = h.loop.coordinator!
				const host = root.taskletHost!
				const child = await host.start({ title: "owned", prompt: "PRIVATE_GOAL_CHILD_ASSIGNMENT" })
				await childEntered.promise
				closing = h.loop[operation]()
				providerGate.resolve()
				await writeEntered.promise
				await assert.rejects(taskLocks.acquireTaskLock(getTaskDirectoryPath("root")), /another Dirac instance/)
				await assert.rejects(host.start({ title: "late", prompt: "Do not launch" }), /shutting down/)
				assert.equal(h.loop.hasRunningCoordinator, true)
				assert.equal(host.inspect(child.id).outcomePersisted, false)
				writeGate.resolve()
				await closing
				assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
				assert.equal(host.inspect(child.id).outcomePersisted, true)
				assert.equal((await h.store.read("root")).status, operation === "pause" ? "paused" : "stopped")
				assert.equal(h.loop.hasRunningCoordinator, false)
				const release = await taskLocks.acquireTaskLock(getTaskDirectoryPath("root"))
				await release()
			} finally {
				providerGate.resolve()
				writeGate.resolve()
				await closing
				await h.loop.cancelCurrentExecution()
			}
		})
	}

	it("retains real Goal ownership when a contained outcome cannot be persisted", async () => {
		expectLoggerErrors()
		const h = await createGoalExecution()
		const acquisition = sandbox.spy(taskLocks, "acquireTaskLock")
		const rootGate = deferred<void>()
		const rootEntered = deferred<void>()
		nextTurn = async (_mode, request) => {
			if (isGoalRequest(request)) {
				rootEntered.resolve()
				await rootGate.promise
				return "complete"
			}
			return "question"
		}
		await h.loop.start()
		const release = await acquisition.firstCall.returnValue
		try {
			await rootEntered.promise
			const root = h.loop.coordinator!
			const child = await root.taskletHost!.start({ title: "failed writer", prompt: "PRIVATE_UNPERSISTED_GOAL_CHILD" })
			await waitForInteraction(root.taskletHost!, child.id)
			const storage = await import("@core/storage/taskStorage")
			const saveRecord = storage.saveTaskletRecord
			sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
				if (record.outcome) throw new Error("contained outcome disk failure")
				await saveRecord(record)
			})
			const containsWriteFailure = (error: unknown): boolean =>
				error instanceof AggregateError
					? error.errors.some(containsWriteFailure)
					: error instanceof Error && error.message.includes("contained outcome disk failure")
			const settlement = assert.rejects(h.loop["runtime"]!.settlement!, containsWriteFailure)
			const closing = assert.rejects(h.loop.pause(), containsWriteFailure)
			rootGate.resolve()
			await Promise.all([settlement, closing])
			assert.equal(root.taskletHost!.inspect(child.id).outcomePersisted, false)
			assert.match(root.taskletHost!.inspect(child.id).settlementError!.message, /contained outcome disk failure/)
			assert.equal(h.loop.hasRunningCoordinator, true)
			await assert.rejects(taskLocks.acquireTaskLock(getTaskDirectoryPath("root")), /another Dirac instance/)
		} finally {
			rootGate.resolve()
			// Only test teardown releases this deliberately failed owner's retained lock.
			await release()
		}
	})

	it("reconstructs a resumed Goal host without restarting its private conversation", async () => {
		expectLoggerErrors()
		const h = await createGoalExecution()
		const rootGate = deferred<void>()
		const rootEntered = deferred<void>()
		nextTurn = async (_mode, request) => {
			if (isGoalRequest(request)) {
				rootEntered.resolve()
				await rootGate.promise
			}
			return "complete"
		}
		try {
			await h.loop.start()
			await rootEntered.promise
			const original = h.loop.coordinator!
			const child = await original.taskletHost!.start({ title: "retained", prompt: "PRIVATE_ORIGINAL_GOAL_ASSIGNMENT" })
			await waitForOutcome(original.taskletHost!, child.id)
			const pause = h.loop.pause()
			rootGate.resolve()
			await pause
			const resumedGate = deferred<void>()
			const resumedEntered = deferred<void>()
			nextTurn = async (_mode, request) => {
				if (isGoalRequest(request)) {
					resumedEntered.resolve()
					await resumedGate.promise
				}
				return "complete"
			}
			try {
				await h.loop.resume()
				await resumedEntered.promise
				const resumed = h.loop.coordinator!
				assert.notEqual(resumed, original)
				assert.notEqual(resumed.taskletHost, original.taskletHost)
				assert.equal(resumed.taskId, original.taskId)
				assert.equal(resumed.ulid, original.ulid)
				assert.equal(requests.filter((request) => !isGoalRequest(request)).length, 1)
				assert.equal(resumed.taskletHost!.inspect(child.id).outcome?.kind, "completed")
				await resumed.taskletHost!.resume(child.id, "PRIVATE_EXPLICIT_GOAL_CHILD_FOLLOWUP")
				await waitForOutcome(resumed.taskletHost!, child.id)
				assert.equal(requests.filter((request) => !isGoalRequest(request)).length, 2)
				const transcript = await resumed.taskletHost!.readTranscript(child.id)
				assert.match(JSON.stringify(transcript.conversation), /PRIVATE_ORIGINAL_GOAL_ASSIGNMENT/)
				assert.match(JSON.stringify(transcript.conversation), /PRIVATE_EXPLICIT_GOAL_CHILD_FOLLOWUP/)
			} finally {
				const closing = h.loop.pause()
				resumedGate.resolve()
				await closing
			}
		} finally {
			rootGate.resolve()
			await h.loop.cancelCurrentExecution()
		}
	})

	for (const status of ["paused", "achieved"] as const) {
		it(`lets an explicit ${status} Goal follow-up use children without changing pursuit status`, async () => {
			const h = await createGoalExecution(status)
			const rootGate = deferred<void>()
			const rootEntered = deferred<void>()
			nextTurn = async (_mode, request) => {
				if (isGoalRequest(request)) {
					rootEntered.resolve()
					await rootGate.promise
				}
				return "complete"
			}
			try {
				await h.loop.sendMessage("Explicit follow-up work")
				await rootEntered.promise
				const root = h.loop.coordinator!
				assert.equal(root.executionProfile, "goal_followup")
				const child = await root.taskletHost!.start({ title: "follow-up child", prompt: "PRIVATE_FOLLOWUP_ASSIGNMENT" })
				await waitForOutcome(root.taskletHost!, child.id)
				assert.equal((await h.store.read("root")).status, status)
				const settlement = h.loop["runtime"]!.settlement!
				rootGate.resolve()
				await settlement
				assert.equal((await h.store.read("root")).status, status)
				assert.equal(h.loop.hasRunningCoordinator, false)
				const release = await taskLocks.acquireTaskLock(getTaskDirectoryPath("root"))
				await release()
			} finally {
				rootGate.resolve()
				await h.loop.cancelCurrentExecution()
			}
		})
	}

	it("rejects Goal completion and blocking while contained starts or interactions remain active", async () => {
		expectLoggerErrors()
		const h = await createGoalExecution()
		const rootGate = deferred<void>()
		const rootEntered = deferred<void>()
		nextTurn = async (_mode, request) => {
			if (isGoalRequest(request)) {
				rootEntered.resolve()
				await rootGate.promise
				return "complete"
			}
			return "question"
		}
		try {
			await h.loop.start()
			await rootEntered.promise
			const runtime = h.loop["runtime"]!
			const root = runtime.coordinator
			const executor = (root as any).toolExecutor
			const surface = new SurfaceAdapter(executor.asToolConfig(), "respond")
			const goal: IGoalTrait = h.created.firstCall.args[0].environmentFactory.create(executor.asToolConfig(), "respond")
				.goal!
			const storage = await import("@core/storage/taskStorage")
			const saveRecord = storage.saveTaskletRecord
			const writeEntered = deferred<void>()
			const writeGate = deferred<void>()
			const save = sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
				if (!record.configuration || !record.outcome) {
					writeEntered.resolve()
					await writeGate.promise
				}
				await saveRecord(record)
			})
			const starting = root.taskletHost!.start({ title: "active child", prompt: "PRIVATE_WAITING_GOAL_ASSIGNMENT" })
			await writeEntered.promise
			try {
				const completion = await goal.commitCompletion("too early")
				assert.equal(completion.committed, false)
				assert.match(completion.error!, /active child/)
				await assert.rejects(goal.blockGoal("Cannot continue"), /Active tasklets:.*active child/)
				assert.equal(h.loop["requestedEnd"], undefined)
			} finally {
				writeGate.resolve()
			}
			const child = await starting
			await waitForInteraction(root.taskletHost!, child.id)
			assert.equal((await goal.commitCompletion("still too early")).committed, false)
			await assert.rejects(goal.blockGoal("Still active"), new RegExp(child.id))
			assert.equal(root.taskletHost!.inspect(child.id).outcome, undefined)
			save.restore()
			await root.taskletHost!.interrupt(child.id, "Parent stopped the work")
			assert.deepEqual(await h.loop["commitCompletion"](surface, "Goal completed"), { committed: true })
			await assert.rejects(root.taskletHost!.start({ title: "late", prompt: "Do not launch" }), /shutting down/)
			rootGate.resolve()
			await runtime.settlement
			assert.equal((await h.store.read("root")).status, "achieved")
		} finally {
			rootGate.resolve()
			await h.loop.cancelCurrentExecution()
		}
	})

	it("rechecks contained admission when Goal blocking races a new child", async () => {
		expectLoggerErrors()
		const h = await createGoalExecution()
		const rootGate = deferred<void>()
		const rootEntered = deferred<void>()
		nextTurn = async (_mode, request) => {
			if (isGoalRequest(request)) {
				rootEntered.resolve()
				await rootGate.promise
				return "complete"
			}
			return "question"
		}
		try {
			await h.loop.start()
			await rootEntered.promise
			const runtime = h.loop["runtime"]!
			const root = runtime.coordinator
			const config = (root as any).toolExecutor.asToolConfig()
			const goal = h.created.firstCall.args[0].environmentFactory.create(config, "block_goal").goal!
			const transitionEntered = deferred<void>()
			const transitionGate = deferred<void>()
			const holdingTransition = h.loop["lifecycleMutex"].withLock(async () => {
				transitionEntered.resolve()
				await transitionGate.promise
			})
			await transitionEntered.promise
			const blocked = assert.rejects(goal.blockGoal("Cannot continue"), /Active tasklets:.*racing child/)
			const starting = root.taskletHost!.start({ title: "racing child", prompt: "PRIVATE_RACING_ASSIGNMENT" })
			transitionGate.resolve()
			await holdingTransition
			await blocked
			const child = await starting
			await waitForInteraction(root.taskletHost!, child.id)
			assert.equal(h.loop["requestedEnd"], undefined)
			assert.equal(root.taskletHost!.inspect(child.id).outcome, undefined)
			await root.taskletHost!.interrupt(child.id, "Parent stopped the work")
			await goal.blockGoal("No work remains active")
			await assert.rejects(root.taskletHost!.start({ title: "late", prompt: "Do not launch" }), /shutting down/)
			rootGate.resolve()
			await runtime.settlement
			assert.equal((await h.store.read("root")).status, "blocked")
		} finally {
			rootGate.resolve()
			await h.loop.cancelCurrentExecution()
		}
	})

	for (const includeHistory of [undefined, false, true]) {
		it(`starts a real Task with ${includeHistory === true ? "an independent parent history snapshot" : `no inherited history (${includeHistory})`}`, async () => {
			const parentHistory: { messages: DiracStorageMessage[]; deletedRange?: [number, number] } = {
				messages: [
					{ role: "user", content: [{ type: "text", text: "PARENT_HISTORY_PRIVATE_CONTEXT" }] },
					{ role: "assistant", content: [{ type: "text", text: "PARENT_HISTORY_PRIOR_ANSWER" }] },
				],
			}
			const originalHistory = structuredClone(parentHistory)
			const getParentHistory = sandbox.stub().returns(parentHistory)
			const host = createHost(parameters(), getParentHistory)
			try {
				const child = await host.start({ title: "history", prompt: "CHILD_HISTORY_ASSIGNMENT", includeHistory })
				assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
				assert.deepEqual(parentHistory, originalHistory, "child tool results and completion must not mutate the parent")
				assert.equal(getParentHistory.callCount, includeHistory === true ? 1 : 0)
				assert.equal(child.configuration?.timeoutSeconds, 600)
				for (const request of requests) {
					const serialized = JSON.stringify(request.messages)
					assert.equal(serialized.includes("PARENT_HISTORY_PRIVATE_CONTEXT"), includeHistory === true)
					assert.equal(serialized.includes("PARENT_HISTORY_PRIOR_ANSWER"), includeHistory === true)
					assert.match(serialized, /CHILD_HISTORY_ASSIGNMENT/)
				}
				assert.match(JSON.stringify(requests[1].messages), /PRIVATE_FILE_CONTENT/)
				const transcript = await host.readTranscript(child.id)
				assert.equal(
					JSON.stringify(transcript.conversation).includes("PARENT_HISTORY_PRIVATE_CONTEXT"),
					includeHistory === true,
				)
				assert.doesNotMatch(JSON.stringify(transcript.presentation), /PARENT_HISTORY_PRIVATE_CONTEXT/)
				assert.doesNotMatch(
					JSON.stringify(await host.query(child.id, { view: "transcript" })),
					/PARENT_HISTORY_PRIVATE_CONTEXT|PARENT_HISTORY_PRIOR_ANSWER/,
				)
				if (includeHistory === true) {
					parentHistory.messages[0].content = "PARENT_HISTORY_REPLACED_AFTER_START"
					await host.resume(child.id, "CHILD_HISTORY_FOLLOWUP")
					assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
					assert.equal(
						getParentHistory.callCount,
						1,
						"resume restores the child transcript, never recaptures parent history",
					)
					assert.match(JSON.stringify(requests[2].messages), /PARENT_HISTORY_PRIVATE_CONTEXT/)
					assert.match(JSON.stringify(requests[2].messages), /PRIVATE_FILE_CONTENT/)
					assert.match(JSON.stringify(requests[2].messages), /CHILD_HISTORY_FOLLOWUP/)
					assert.doesNotMatch(JSON.stringify(requests[2].messages), /PARENT_HISTORY_REPLACED_AFTER_START/)
					assert.doesNotMatch(
						JSON.stringify(await host.query(child.id, { view: "transcript" })),
						/PARENT_HISTORY_PRIVATE_CONTEXT|PARENT_HISTORY_PRIOR_ANSWER/,
					)
				}
			} finally {
				await host.shutdown()
			}
		})
	}

	it("applies a named profile prompt, skills, model and tool scope to real provider requests", async () => {
		const profile: AgentBaseConfig = {
			name: "controlled-reviewer",
			description: "Controlled profile",
			systemPrompt: "NAMED_PROFILE_PRIVATE_INSTRUCTIONS",
			skills: ["allowed_skill"],
			tools: ["use_skill", "read_file"],
			modelId: "claude-sonnet-4-20250514",
		}
		const loader = AgentConfigLoader.getInstance()
		sandbox.stub(loader, "ready").resolves()
		sandbox.stub(loader, "getCachedConfig").withArgs(profile.name).returns(profile)
		const skills = await Promise.all(
			["allowed_skill", "excluded_skill"].map(async (name) => {
				const skillPath = path.join(directory, name, "SKILL.md")
				await fs.mkdir(path.dirname(skillPath), { recursive: true })
				await fs.writeFile(
					skillPath,
					`---\nname: ${name}\ndescription: Fixture skill\n---\n${name.toUpperCase()}_PRIVATE_INSTRUCTIONS\n`,
				)
				return { name, description: "Fixture skill", path: skillPath, source: "global" as const }
			}),
		)
		sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves(skills)
		const params = parameters()
		params.toolSelectionPolicy = { mode: "exact", toolIds: ["respond", "use_skill", "read_file", "execute_command"] }
		nextTurn = async () => (requests.length === 1 ? "allowed_skill" : requests.length === 2 ? "excluded_skill" : "complete")
		const host = createHost(params)
		try {
			const child = await host.start({
				title: "profile",
				prompt: "PROFILE_ASSIGNMENT",
				agentName: profile.name,
				timeoutSeconds: 120,
			})
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			assert.equal(requests.length, 3)
			for (const request of requests) {
				assert.equal(request.model, profile.modelId)
				assert.match(request.systemPrompt, /NAMED_PROFILE_PRIVATE_INSTRUCTIONS/)
				assert.match(request.systemPrompt, /PINNED_PRIVATE_CONSTRAINT/)
				assert.match(request.systemPrompt, /120 seconds/)
				assert.deepEqual(request.tools.sort(), ["read_file", "respond", "use_skill"])
			}
			assert.match(JSON.stringify(requests[1].messages), /ALLOWED_SKILL_PRIVATE_INSTRUCTIONS/)
			assert.match(JSON.stringify(requests[2].messages), /Skill \\"excluded_skill\\" not found/)
			assert.doesNotMatch(JSON.stringify(requests[2].messages), /EXCLUDED_SKILL_PRIVATE_INSTRUCTIONS/)
		} finally {
			await host.shutdown()
		}
	})

	async function waitForInteraction(host: TaskletHost, id: string) {
		const deadline = Date.now() + 5_000
		while (!host.inspect(id).interactions.some((request) => request.status === "pending")) {
			assert.ok(Date.now() < deadline, `No owner request: ${JSON.stringify(host.inspect(id))}`)
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		return host.inspect(id).interactions.find((request) => request.status === "pending")!
	}

	function createResolutionRoot(executionProfile: "standalone" | "goal_coordinator" | "goal_followup" = "standalone") {
		const params = parameters()
		return create({
			...params,
			taskId: "root",
			executionProfile,
			tasklet: undefined,
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "execute_command"] },
			vscodeTerminalExecutionMode: "backgroundExec",
			workingConfiguration: {
				...params.workingConfiguration,
				executionOptions: {
					...params.workingConfiguration.executionOptions,
					vscodeTerminalExecutionMode: "backgroundExec",
				},
			},
			releaseTaskLock: async () => { },
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
		})
	}

	for (const profile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
		for (const useUtilityModel of [false, true]) {
			it(`inherits changed parent preferences at the next child request, including resume (${profile}, Utility=${useUtilityModel})`, async () => {
				const root = createResolutionRoot(profile)
				await root.applyWorkingConfigurationUpdate({
					settings: {
						backgroundEditEnabled: false,
						preferredLanguage: "English",
						utilityModelSelection: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
					},
				})
				const host = root.taskletHost!
				let turn = 0
				let childTask!: Task
				let secondRequest!: Request
				let toolBackgroundEdit: boolean | undefined
				nextTurn = async (_mode, request) => {
					if (++turn === 1) {
						const [owned] = [...(host as any).children.values()]
						childTask = owned.task
						assert.equal(childTask.getWorkingConfiguration().settings.backgroundEditEnabled, false)
						await root.applyWorkingConfigurationUpdate({
							settings: {
								backgroundEditEnabled: true,
								preferredLanguage: "French - Français",
								lowVerbosityEnabled: false,
								enableParallelToolCalling: true,
								mode: profile === "standalone" ? "plan" : "act",
							},
							workspaceConfiguration: { localSkillsToggles: { disabledSkill: false } },
						})
						assert.equal(childTask.getWorkingConfiguration().settings.backgroundEditEnabled, false,
							"An in-flight request retains its immutable settings")
						return "progress"
					}
					secondRequest = request
					toolBackgroundEdit = (childTask as any).toolExecutor.asToolConfig().backgroundEditEnabled
					return "complete"
				}
				const record = await host.start({ title: "Preference worker", prompt: "Check preferences", useUtilityModel })
				assert.equal((await waitForOutcome(host, record.id)).outcome?.kind, "completed")
				const settings = childTask.getWorkingConfiguration().settings
				assert.equal(settings.backgroundEditEnabled, true)
				assert.equal(toolBackgroundEdit, true, "The next tool environment uses the inherited preference")
				assert.equal(settings.lowVerbosityEnabled, false)
				assert.equal(settings.enableParallelToolCalling, true)
				assert.equal(settings.mode, "act")
				assert.equal(childTask.getWorkingConfiguration().workspaceConfiguration.localSkillsToggles?.disabledSkill, false)
				assert.match(secondRequest.systemPrompt, /Speak in fr\./)
				assert.equal(secondRequest.model,
					useUtilityModel || profile === "standalone" ? "claude-sonnet-4-20250514" : "claude-opus-4-20250514",
					"Act execution preserves explicit Utility selection or the parent's active model")
				await root.applyWorkingConfigurationUpdate({ settings: { backgroundEditEnabled: false } })
				nextTurn = async () => {
					const [owned] = [...(host as any).children.values()]
					assert.equal(owned.task.getWorkingConfiguration().settings.backgroundEditEnabled, false)
					return "complete"
				}
				await host.resume(record.id, "Check the latest preferences")
				assert.equal((await waitForOutcome(host, record.id)).outcome?.kind, "completed")
			})
		}
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
			const siblingGate = new Promise<void>((resolve) => {
				releaseSibling = resolve
			})
			let siblingReadFile!: () => void
			const siblingRead = new Promise<void>((resolve) => {
				siblingReadFile = resolve
			})
			const lockReleases: string[] = []
			let parentRequests = 0
			let maxParentRequests = 0
			const buildApi = apiModule.buildApiHandler as sinon.SinonStub
			buildApi.callsFake(() => {
				const role = handlerNumber++ // Original root, permission child, sibling, reopened root, resumed child.
				assert.ok(role < turns.length, "Reconstruction must not construct historical children")
				return {
					getModel: () => ({
						id: "claude-opus-4-20250514",
						info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false },
					}),
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
							if (role === 0 && turn === 2)
								assert.ok(serialized.includes(requestId), "Parent model receives the permission request")
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
							const name =
								role === 1 && turn === 1 ? "execute_command" : role === 2 && turn === 1 ? "read_file" : "respond"
							const operation =
								role === 0
									? turn === 1 || turn === 3
										? "progress"
										: "complete"
									: role === 3 && turn === 1
										? "progress"
										: "complete"
							yield {
								type: "tool_calls",
								tool_call: {
									call_id: `foundation-${role}-${turn}`,
									function: {
										name,
										arguments: JSON.stringify(
											name === "execute_command"
												? { commands: ["touch foundation-permission-marker"] }
												: name === "read_file"
													? { paths: ["assignment.txt"] }
													: {
														operation,
														text:
															role === 2 ? fullResult : `Foundation role ${role} turn ${turn}`,
													},
										),
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
					...params,
					taskId: "root",
					executionProfile: "standalone",
					tasklet: undefined,
					toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "read_file", "execute_command"] },
					vscodeTerminalExecutionMode: "backgroundExec",
					workingConfiguration: {
						...params.workingConfiguration,
						executionOptions: {
							...params.workingConfiguration.executionOptions,
							vscodeTerminalExecutionMode: "backgroundExec",
						},
					},
					releaseTaskLock: async () => {
						assert.deepEqual(root.taskletHost!.listActive(), [])
						for (const record of root.taskletHost!.list()) assert.equal(record.outcomePersisted, true)
						lockReleases.push(reopening ? "reopened" : "original")
					},
					updateTaskHistory: async () => [],
					postStateToWebview: async () => { },
					postPresentationToWebview: async () => { },
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
									assert.equal(
										root.taskletHost!.inspect(childId).interactions[0].status,
										interrupt ? "retired" : "resolved",
									)
									const [retry] = await controls.message([
										{
											taskletId: childId,
											type: "permission_decision",
											replyTo: requestId,
											decision: "approve",
										},
									])
									assert.equal(retry.status, interrupt ? "stale" : "failed")
									assert.equal(
										(root.taskletHost!.inspect(siblingId).outcome as { kind: "completed"; response: string })
											.response,
										fullResult,
									)
									const before = root.taskletHost!.inspect(childId)
									const resumed = await controls.resume(childId, "FOUNDATION_EXPLICIT_FOLLOWUP")
									assert.equal(resumed.id, childId)
									assert.equal(resumed.conversationUlid, before.conversationUlid)
									assert.equal((await waitForOutcome(root.taskletHost!, childId)).outcome?.kind, "completed")
									return
								}
								if (turns[0] === 1) {
									childId = (
										await controls.start({
											title: "permission child",
											prompt: "FOUNDATION_PERMISSION_ASSIGNMENT",
										})
									).id
									siblingId = (
										await controls.start({
											title: "private reader",
											prompt: "Read the private file, then report fully",
										})
									).id
									const wake = await controls.sleep({ taskletIds: [childId], timeoutMs: 5_000 })
									assert.equal(wake.reason, "event")
									requestId = (await waitForInteraction(root.taskletHost!, childId)).id
									await siblingRead
									assert.equal(
										root.taskletHost!.inspect(childId).interactions[0].status,
										"pending",
										"Sibling reads while the permission child is waiting",
									)
									assert.equal(root.taskletHost!.inspect(siblingId).outcome, undefined)
									return
								}
								assert.equal(turns[0], 3, "Rejected completion continues the same serial parent loop")
								assert.deepEqual(lockReleases, [])
								assert.equal(
									root.taskletHost!.inspect(childId).outcome,
									undefined,
									"Completion must not interrupt children",
								)
								assert.equal(
									(
										await controls.message([
											{
												taskletId: childId,
												type: "permission_decision",
												replyTo: requestId,
												decision: "approve",
											},
										])
									)[0].status,
									"requires_user_approval",
								)
								await assert.rejects(fs.stat(path.join(cwd, "foundation-permission-marker")), { code: "ENOENT" })
								if (interrupt) {
									assert.equal(
										(await controls.interrupt(childId, "Parent explicitly stops the pending permission"))
											.outcome?.kind,
										"interrupted",
									)
								} else {
									const escalation = controls.message([
										{
											taskletId: childId,
											type: "permission_decision",
											replyTo: requestId,
											decision: "escalate",
										},
									])
									const card = await waitForRootCard(root)
									await root.submitCardResponse(card.id, DiracAskResponse.APPROVE)
									assert.equal((await escalation)[0].status, "resolved")
									assert.equal((await waitForOutcome(root.taskletHost!, childId)).outcome?.kind, "completed")
									await fs.unlink(path.join(cwd, "foundation-permission-marker"))
								}
								assert.equal(
									root.taskletHost!.inspect(siblingId).outcome,
									undefined,
									"Sibling survives permission resolution/interruption",
								)
								assert.deepEqual(await controls.sleep({ taskletIds: [], timeoutMs: 5_000 }), {
									reason: "user_message",
								})
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
					await Promise.race([
						new Promise((resolve) => setTimeout(resolve, 5)),
						run.then((outcome) => assert.fail(JSON.stringify(outcome))),
					])
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
				assert.equal(
					(
						await reopened.resumeTaskFromHistory(
							() => {
								assert.deepEqual(turns, [4, interrupt ? 1 : 2, 2, 0, 0])
								assert.equal(handlerNumber, 4, "Root restoration constructs no child engines")
								assert.deepEqual(reopened.taskletHost!.listActive(), [])
								assert.equal(
									reopened.taskletHost!.inspect(childId).outcome?.kind,
									interrupt ? "interrupted" : "completed",
								)
								assert.equal(
									getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn,
									initialTokens,
								)
							},
							{ initialUserInput: { text: "Resume the selected child explicitly" } },
						)
					).kind,
					"completed",
				)
				await reopened.abortTask()
				await reopened.retirePersistence()
				assert.deepEqual(lockReleases, ["original", "reopened"])
				assert.equal(maxParentRequests, 1)
				assert.equal(parentInputs.length, 6)
				assert.deepEqual(turns, [4, interrupt ? 1 : 2, 2, 2, 1])
				const persistedRoot = (await getSavedPresentationHistory("root")).messages
				assert.equal(getApiMetrics(persistedRoot).totalTokensIn, initialTokens + 300)
				assert.equal(getApiMetrics(persistedRoot).totalTokensOut, (initialTokens + 300) / 5)
				const contributions = persistedRoot.flatMap((message) =>
					message.content.type === DiracMessageType.CARD
						? [getTaskletUsage(message.content.card)].filter((usage) => usage !== undefined)
						: [],
				)
				assert.deepEqual(contributions.map((usage) => usage.taskletId).sort(), [childId, siblingId].sort())
				const childTranscript = JSON.stringify(await reopened.taskletHost!.readTranscript(childId))
				assert.match(childTranscript, /FOUNDATION_EXPLICIT_FOLLOWUP/)
				assert.doesNotMatch(childTranscript, /PRIVATE_FILE_CONTENT|FOUNDATION_RESULT_END/)
				assert.match(JSON.stringify(await reopened.taskletHost!.readTranscript(siblingId)), /PRIVATE_FILE_CONTENT/)
				assert.equal(
					(reopened.taskletHost!.inspect(siblingId).outcome as { kind: "completed"; response: string }).response,
					fullResult,
				)
				await assert.rejects(fs.stat(path.join(cwd, "foundation-permission-marker")), { code: "ENOENT" })
				const rootPath = getTaskDirectoryPath("root")
				assert.deepEqual((await fs.readdir(path.join(rootPath, "tasklets"))).sort(), [childId, siblingId].sort())
				assert.deepEqual(
					await fs.readdir(path.dirname(rootPath)),
					["root"],
					"No independent top-level tasklet directories",
				)
			} finally {
				releaseSibling()
				await root.abortTask()
				await run
			}
		})
	}

	it("dispatches public provider tasklet calls through real parent and child Tasks", async () => {
		const modelPresets = await import("@core/models/modelProviderPresets")
		sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
		const fullResult = `PUBLIC_RESULT_START ${"private detail ".repeat(1000)} PUBLIC_RESULT_END`
		let releaseChild!: () => void
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve
		})
		let releaseCompletion!: () => void
		const completionGate = new Promise<void>((resolve) => {
			releaseCompletion = resolve
		})
		let childAnswered!: () => void
		const answerReceived = new Promise<void>((resolve) => {
			childAnswered = resolve
		})
		let childId = ""
		let questionId = ""
		let handlerNumber = 0
		const turns = [0, 0]
		const parentInputs: string[] = []

		async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
			let timer!: ReturnType<typeof setTimeout>
			try {
				return await Promise.race([
					promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`${label}; turns: ${turns}`)), 5_000)
					}),
				])
			} finally {
				clearTimeout(timer)
			}
		}

		function toolOutput(messages: DiracStorageMessage[], callId: string): string {
			const result = messages
				.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
				.find((block) => block.type === "tool_result" && block.tool_use_id === callId)
			assert.ok(result?.type === "tool_result", `Missing public tool result ${callId}`)
			return typeof result.content === "string"
				? result.content
				: (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n")
		}

		const buildApi = apiModule.buildApiHandler as sinon.SinonStub
		buildApi.callsFake(() => {
			const role = handlerNumber++
			assert.ok(role < 2, "Both engines must be real Tasks, with no replacement child")
			return {
				getModel: () => ({
					id: "claude-opus-4-20250514",
					info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false },
				}),
				async *createMessage(_systemPrompt, messages, tools): ApiStream {
					const turn = ++turns[role]
					const history = messages as DiracStorageMessage[]
					const serialized = JSON.stringify(history)
					const advertised = (tools ?? []).map((tool) => (tool as { name: string }).name)
					let name = "respond"
					let args: Record<string, unknown> = { operation: "complete", text: fullResult }
					if (role === 0) {
						assert.ok(turn <= 6, "Unexpected parent retry or request after completion")
						parentInputs.push(serialized)
						assert.ok(advertised.includes("use_subagents") && advertised.includes("tasklets"))
						assert.doesNotMatch(serialized, /PRIVATE_FILE_CONTENT|taskletEventIds/)
						if (turn < 6) assert.doesNotMatch(serialized, /PUBLIC_RESULT_END/)
						if (turn === 1) {
							name = "use_subagents"
							args = {
								subagents: [
									{
										task_title: "Public question worker",
										prompt: "Read assignment.txt, ask PUBLIC_CHILD_QUESTION, then report fully",
										include_history: true,
									},
								],
							}
						} else if (turn === 2) {
							const accepted = JSON.parse(toolOutput(history, "public-0-1")).subagents
							assert.equal(accepted.length, 1)
							assert.equal(accepted[0].accepted, true)
							assert.equal(accepted[0].outcome, undefined, "Acceptance precedes assignment completion")
							childId = accepted[0].id
							assert.match(childId, /^tasklet_[0-9a-f-]{36}$/)
							assert.deepEqual(root.taskletHost!.listActive(), [{ id: childId, title: "Public question worker" }])
							releaseChild()
							await waitForInteraction(root.taskletHost!, childId)
							args = { operation: "complete", text: "Premature public completion" }
						} else if (turn === 3) {
							assert.match(toolOutput(history, "public-0-2"), /Active tasklets:/)
							assert.ok(toolOutput(history, "public-0-2").includes(childId))
							const communication = history
								.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
								.find(
									(block) =>
										block.type === "text" &&
										block.text.includes("[Tasklet communication:") &&
										block.text.includes('"type":"interaction"'),
								)
							assert.ok(
								communication?.type === "text",
								"Question must reach the parent provider, not an internal control callback",
							)
							assert.match(communication.text, /PUBLIC_CHILD_QUESTION/)
							assert.ok(communication.text.includes(childId))
							questionId = JSON.parse(communication.text.slice(communication.text.indexOf("\n") + 1)).request.id
							assert.ok(questionId)
							name = "tasklets"
							args = {
								operation: "message",
								messages: [
									{ tasklet_id: childId, type: "reply", reply_to: questionId, text: "PUBLIC_PARENT_ANSWER" },
								],
							}
						} else if (turn === 4) {
							assert.equal(JSON.parse(toolOutput(history, "public-0-3"))[0].status, "resolved")
							await bounded(answerReceived, "Child did not receive the public answer")
							releaseCompletion()
							assert.equal((await waitForOutcome(root.taskletHost!, childId)).outcome?.kind, "completed")
							args = { operation: "progress", text: "Inspect the retained result next" }
						} else if (turn === 5) {
							assert.match(serialized, /PUBLIC_RESULT_START/)
							assert.match(serialized, /preview only/)
							name = "tasklets"
							args = { operation: "inspect", tasklet_id: childId, view: "assignment" }
						} else {
							const inspection = JSON.parse(toolOutput(history, "public-0-5"))
							assert.equal(inspection.items[0].id, childId, "Public inspection retains the accepted stable ID")
							assert.equal(inspection.items[0].outcome.kind, "completed")
							assert.equal(
								inspection.items[0].outcome.response,
								fullResult,
								"Assignment inspection retains the exact committed result",
							)
							assert.equal(root.taskletHost!.inspect(childId).interactions[0].status, "resolved")
							args = { operation: "complete", text: "Public supervision complete" }
						}
					} else {
						assert.ok(turn <= 3, "Unexpected child request")
						assert.ok(!advertised.includes("use_subagents") && !advertised.includes("tasklets"))
						if (turn === 1) {
							assert.match(serialized, /Supervise a worker through public tools/)
							assert.ok(
								!history.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use")),
								"The executing parent's unanswered spawn call must not enter the child's first provider request",
							)
							await childGate
							name = "read_file"
							args = { paths: ["assignment.txt"] }
						} else if (turn === 2) {
							assert.match(serialized, /PRIVATE_FILE_CONTENT/)
							args = { operation: "question", text: "PUBLIC_CHILD_QUESTION" }
						} else {
							assert.match(serialized, /PUBLIC_PARENT_ANSWER/)
							childAnswered()
							await completionGate
						}
					}
					assert.ok(advertised.includes(name), `Provider call ${name} must be advertised`)
					yield {
						type: "tool_calls",
						tool_call: {
							call_id: `public-${role}-${turn}`,
							function: { id: `public-${role}-${turn}`, name, arguments: JSON.stringify(args) },
						},
					}
					yield { type: "usage", inputTokens: 100, outputTokens: 20, stopReason: "tool_use" }
				},
			} satisfies ApiHandler
		})
		const params = parameters()
		const root = create({
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "read_file", "use_subagents", "tasklets"] },
			releaseTaskLock: async () => { },
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
		})
		// Only skip the user follow-up wait; tool discovery, dispatch and both engines are real.
		sandbox.stub(root as any, "waitForFollowUp").resolves(undefined)
		const run = root.startTask("Supervise a worker through public tools")
		try {
			assert.equal((await bounded(run, "Public provider supervision did not complete")).kind, "completed")
			assert.deepEqual(turns, [6, 3])
			assert.equal(handlerNumber, 2)
			assert.deepEqual(root.taskletHost!.listActive(), [])
			assert.equal(parentInputs.length, 6)
		} finally {
			releaseChild()
			releaseCompletion()
			await root.abortTask()
			await run
		}
	})

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
		const siblingGate = new Promise<void>((resolve) => {
			releaseSibling = resolve
		})
		const siblingStarted = new Promise<void>((resolve) => {
			siblingEntered = resolve
		})
		const parentMessages: string[] = []
		const siblingMessages: string[] = []
		let handlerNumber = 0
		const buildApi = apiModule.buildApiHandler as sinon.SinonStub
		buildApi.callsFake(() => {
			const role = handlerNumber++
			let turn = 0
			return {
				getModel: () => ({
					id: "claude-opus-4-20250514",
					info: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true, supportsPromptCache: false },
				}),
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
							assert.match(serialized, /preview only/)
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
						const operation =
							role === 0
								? currentTurn < 4
									? "progress"
									: "complete"
								: role === 1
									? currentTurn === 2
										? "question"
										: "complete"
									: currentTurn === 1
										? "progress"
										: "complete"
						const text =
							role === 1 ? (currentTurn === 2 ? "CHILD_QUESTION" : fullResult) : `role ${role} turn ${currentTurn}`
						yield {
							type: "tool_calls",
							tool_call: {
								call_id: `call-${role}-${currentTurn}`,
								function: {
									name: read ? "read_file" : "respond",
									arguments: JSON.stringify(read ? { paths: ["assignment.txt"] } : { operation, text }),
								},
							},
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
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			releaseTaskLock: async () => { },
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
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
							childId = (
								await controls.start({
									title: "question worker",
									prompt: "Read privately then ask CHILD_QUESTION",
								})
							).id
							questionId = (await waitForInteraction(root.taskletHost!, childId)).id
							siblingId = (await controls.start({ title: "running sibling", prompt: "Work independently" })).id
							await siblingStarted
							assert.equal(parentMessages.length, 1, "Child events must not start another parent loop")
							return
						}
						if (rootTurn === 2) {
							assert.equal(controls.list().totalItems, 2)
							assert.equal(root.taskletHost!.inspect(siblingId).outcome, undefined)
							assert.match(
								JSON.stringify(await controls.inspect(childId, { view: "transcript" })),
								/PRIVATE_FILE_CONTENT/,
							)
							assert.equal(
								(
									await controls.message([{ taskletId: siblingId, type: "guidance", text: "SIBLING_STEERING" }])
								)[0].status,
								"queued",
							)
							assert.equal(
								(
									await controls.message([
										{ taskletId: childId, type: "reply", replyTo: questionId, text: "PARENT_ANSWER" },
									])
								)[0].status,
								"resolved",
							)
							await waitForOutcome(root.taskletHost!, childId)
							assert.equal(root.taskletHost!.inspect(siblingId).outcome, undefined)
							return
						}
						assert.equal(rootTurn, 3)
						assert.equal(root.taskletHost!.inspect(siblingId).outcome, undefined)
						assert.equal(
							(root.taskletHost!.inspect(childId).outcome as { kind: "completed"; response: string }).response,
							fullResult,
						)
						const transcript = JSON.stringify((await root.taskletHost!.readTranscript(childId)).conversation)
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
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(label)), 5_000)
					}),
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
				...params,
				taskId: "root",
				executionProfile: "standalone",
				tasklet: undefined,
				releaseTaskLock: async () => { },
				updateTaskHistory: async () => [],
				postStateToWebview: async () => { },
				postPresentationToWebview: async () => { },
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
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve
			})
			const childStarted = new Promise<void>((resolve) => {
				childEntered = resolve
			})
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
				assert.ok(
					events.some((event) => event.id === result.eventId),
					"Wake identifies persisted child communication",
				)
				assert.deepEqual(
					await controls.sleep({ taskletIds: [childId], timeoutMs: 0 }),
					result,
					"Sleep does not consume or acknowledge communication",
				)
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

		for (const input of [
			"chat with attachments",
			"already queued chat with attachments",
			"steering",
			"already queued steering",
			"contextual feedback",
		] as const) {
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
					if (input === "already queued chat with attachments")
						await parent.submitCardResponse("", DiracAskResponse.MESSAGE, text, [image], [attachment])
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
					const completion = await (
						parent as unknown as { commitAttemptCompletion(text: string): Promise<{ committed: boolean }> }
					).commitAttemptCompletion("Premature completion")
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
							assert.deepEqual(
								await root.submitContextualInput(
									{ text, references: ["OPAQUE_FEEDBACK_SOURCE"] },
									{ kind: "steering" },
									() => { },
								),
								{ persisted: true },
							)
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
			const readGate = new Promise<void>((resolve) => {
				releaseRead = resolve
			})
			const readEntered = new Promise<void>((resolve) => {
				enteredRead = resolve
			})
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
				await root.submitCardResponse(
					"",
					DiracAskResponse.MESSAGE,
					"SECOND_CHAT",
					["data:image/png;base64,iVBORw0KGgo="],
					[secondFile],
				)
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
			nextTurn = async () => (requests.length === 1 ? "progress" : "complete")
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
		nextTurn = async () => (++turn === 1 ? "question" : "complete")
		const child = await host.start({ title: "question", prompt: "Ask privately" })
		const request = await waitForInteraction(host, child.id)
		assert.equal(request.permissionOperation, undefined)
		const sibling = await host.start({ title: "sibling", prompt: "Finish independently" })
		assert.equal((await waitForOutcome(host, sibling.id)).outcome?.kind, "completed")
		assert.equal(host.inspect(child.id).interactions[0].status, "pending")
		assert.deepEqual(
			await host.resolveInteraction(child.id, request.id, {
				operation: "answer",
				response: {
					action: DiracAskResponse.MESSAGE,
					response: DiracAskResponse.MESSAGE,
					text: "PRIVATE_PARENT_ANSWER",
				},
			}),
			{ status: "resolved" },
		)
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		assert.match(JSON.stringify(requests[2].messages), /PRIVATE_PARENT_ANSWER/)
		assert.equal(root.stateView.lastWaitingCardId, undefined)
		assert.equal(requests.length, 3)
	})

	it("rejects a real command without executing it and resumes the child conversation", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => (++turn === 1 ? "execute_command" : "complete")
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
		nextTurn = async () => (++turn === 1 ? "execute_command" : "complete")
		const child = await host.start({ title: "command", prompt: "Ask command permission" })
		const request = await waitForInteraction(host, child.id)
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: false } })
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), {
			status: "requires_user_approval",
		})
		await assert.rejects(fs.stat(path.join(cwd, "permission-bypass-marker")), { code: "ENOENT" })
		assert.equal(host.inspect(child.id).interactions[0].status, "pending")
		await root.applyWorkingConfigurationUpdate({ settings: { yoloModeToggled: true } })
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), { status: "resolved" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		await fs.access(path.join(cwd, "permission-bypass-marker"))
		assert.equal(root.stateView.lastWaitingCardId, undefined)
	})

	it("executes an approved read-only child command under a strict-Plan parent", async () => {
		const root = createResolutionRoot()
		await root.applyWorkingConfigurationUpdate({ settings: { mode: "plan", strictPlanModeEnabled: true } })
		let turn = 0
		nextTool = async () => ++turn === 1
			? { name: "execute_command", args: { commands: ["printf strict-plan-command-ok"] } }
			: { name: "respond", args: { operation: "complete", text: "Read-only review finished" } }
		const host = root.taskletHost!
		const child = await host.start({ title: "read-only command", prompt: "Run the approved read-only command" })
		const request = await waitForInteraction(host, child.id)
		const escalation = host.resolveInteraction(child.id, request.id, { operation: "escalate" })
		const card = await waitForRootCard(root)
		await root.submitCardResponse(card.id, DiracAskResponse.APPROVE)
		assert.deepEqual(await escalation, { status: "resolved" })
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		const transcript = await host.readTranscript(child.id)
		assert.ok(transcript.presentation.some((message) =>
			message.content.type === DiracMessageType.CARD &&
			message.content.card.status === CardStatus.SUCCESS &&
			String(message.content.card.rawOutput?.output).includes("strict-plan-command-ok"),
		), "The actual command output, not only the requested command, must contain the marker")
		assert.doesNotMatch(JSON.stringify(transcript), /Plan Mode does not permit file mutations/)
	})

	it("keeps the current parent mutation ceiling and background lease on an Act child", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => (++turn === 1 ? "question" : "complete")
		const record = await host.start({ title: "mutation boundary", prompt: "Wait for guidance" })
		const request = await waitForInteraction(host, record.id)
		const child = host["children"].get(record.id)!.task!
		const callbacks = (child as any).toolExecutor.asToolConfig().callbacks
		const completion = deferred<void>()
		try {
			await callbacks.withMutationAuthorization("edit_file", async () => callbacks.retainMutationUntil(completion.promise))
			let transitioned = false
			const transition = root
				.applyWorkingConfigurationUpdate({ settings: { mode: "plan", strictPlanModeEnabled: true } })
				.then(() => {
					transitioned = true
				})
			await new Promise((resolve) => setImmediate(resolve))
			assert.equal(transitioned, false, "The parent's mutation lease covers a child's detached background work")
			completion.resolve()
			await transition
			assert.equal(child.getWorkingConfiguration().settings.mode, "act")
			const mutation = sandbox.stub().resolves()
			await assert.rejects(callbacks.withMutationAuthorization("edit_file", mutation), /Plan Mode/)
			sinon.assert.notCalled(mutation)
			await host.resolveInteraction(record.id, request.id, {
				operation: "answer",
				response: {
					action: DiracAskResponse.MESSAGE,
					response: DiracAskResponse.MESSAGE,
					text: "Finish read-only",
				},
			})
			assert.equal((await waitForOutcome(host, record.id)).outcome?.kind, "completed")
		} finally {
			completion.resolve()
			await root.abortTask()
		}
	})

	it("escalates a real command through root input without granting approval to the next operation", async () => {
		const root = createResolutionRoot()
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => (++turn <= 2 ? "execute_command" : "complete")
		const child = await host.start({ title: "command", prompt: "Ask command permission twice" })
		const request = await waitForInteraction(host, child.id)
		assert.deepEqual(await host.resolveInteraction(child.id, request.id, { operation: "approve" }), {
			status: "requires_user_approval",
		})
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
		assert.deepEqual(await host.resolveInteraction(child.id, next.id, { operation: "approve" }), {
			status: "requires_user_approval",
		})
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
		nextTurn = async () => (++turn === 1 ? "execute_command" : "complete")
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
		// The public mapping must preserve Retry's response classification, not only its action.
		const executor = (root as any).toolExecutor
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(new TaskletsTool())
		executor.activeRequestRuntime = {
			requestId: "public-resolution",
			workingConfiguration: root.getWorkingConfiguration(),
			api: root.api,
		}
		const result = await coordinator.execute(executor.asToolConfig(coordinator), {
			type: "tool_use",
			name: "tasklets",
			isComplete: true,
			params: {
				operation: "message",
				messages: [{ tasklet_id: child.id, type: "reply", reply_to: request.id, action: "approve" }],
			},
		})
		assert.equal(JSON.parse(result as string)[0].status, "resolved")
		assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
		assert.equal(requests.length, 2)
		assert.equal(root.stateView.lastWaitingCardId, undefined)
	})

	it("retains directed progress and completion without emitting routine presentation as communication", async () => {
		let turn = 0
		nextTurn = async () => (++turn === 1 ? "progress" : "complete")
		const host = createHost()
		try {
			const child = await host.start({ title: "updates", prompt: "Report privately" })
			const result = await waitForOutcome(host, child.id)
			assert.equal(result.outcome?.kind, "completed")
			assert.deepEqual(
				result.responses.map((response) => response.operation),
				["progress"],
			)
			assert.deepEqual(result.interactions, [])
			assert.ok((await host.readTranscript(child.id)).presentation.length > result.responses.length)
			result.responses[0].text = "mutated snapshot"
			assert.notEqual(host.inspect(child.id).responses[0].text, "mutated snapshot")
		} finally {
			await host.shutdown()
		}
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
				executionOptions: {
					terminalReuseEnabled: true,
					vscodeTerminalExecutionMode: "vscodeTerminal",
					multiRootEnabled: false,
				},
				settings: {
					...SETTINGS_DEFAULTS,
					mode: "act",
					hooksEnabled: false,
					yoloModeToggled: true,
					toolToggles: { read_file: true, execute_command: true },
					autoApprovalSettings: { ...SETTINGS_DEFAULTS.autoApprovalSettings!, enableNotifications: true },
				} as Settings,
			})
			let turn = 0
			nextTurn = async () => (++turn === 1 ? operation : "complete")
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
			} finally {
				await host.shutdown()
			}
		})
	}

	it("routes real runtime authentication intervention to the owner and retires it on interruption", async () => {
		expectLoggerErrors()
		nextTurn = async () => {
			throw new Error("authentication failed: controlled provider")
		}
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
		} finally {
			await host.shutdown()
		}
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
			assert.deepEqual(
				result.responses.map((response) => response.operation),
				[],
			)
			assert.match(JSON.stringify(await host.readTranscript(child.id)), /API Error \(Retrying\)/)
		} finally {
			await host.shutdown()
		}
	})

	it("cancels a running root and its running child without changing ordinary root lock lifetime", async () => {
		expectLoggerErrors()
		const params = parameters()
		const release = sandbox.stub().resolves()
		const root = create({
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			releaseTaskLock: release,
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
		})
		let releaseProviders!: () => void
		let enteredRoot!: () => void
		let enteredChild!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseProviders = resolve
		})
		const rootEntered = new Promise<void>((resolve) => {
			enteredRoot = resolve
		})
		const childEntered = new Promise<void>((resolve) => {
			enteredChild = resolve
		})
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

	for (const failWrite of [false, true]) {
		it(`blocks real root completion while child outcome persistence ${failWrite ? "fails" : "is pending"}`, async () => {
			if (failWrite) expectLoggerErrors() // The final outcome write deliberately fails.
			const root = createResolutionRoot()
			const host = root.taskletHost!
			const storage = await import("@core/storage/taskStorage")
			const originalSave = storage.saveTaskletRecord
			const entered = deferred<void>()
			const releaseWrite = deferred<void>()
			sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
				if (record.outcome) {
					entered.resolve()
					await releaseWrite.promise
					if (failWrite) throw new Error("controlled final outcome write failure")
				}
				await originalSave(record)
			})
			nextTurn = async () => "complete"
			const child = await host.start({ title: "settling child", prompt: "Finish this assignment" })
			try {
				await entered.promise
				assert.ok(host.inspect(child.id).outcome)
				assert.equal(host.inspect(child.id).outcomePersisted, false)
				assert.deepEqual(host.listActive(), [{ id: child.id, title: "settling child" }])
				const pending = await (root as any).commitAttemptCompletion("too soon")
				assert.equal(pending.committed, false)
				assert.match(pending.error, /Active tasklets/)
				releaseWrite.resolve()
				if (failWrite) {
					await assert.rejects(host["children"].get(child.id)!.settlement!, /controlled final outcome write failure/)
					const failed = await (root as any).commitAttemptCompletion("not durable")
					assert.equal(failed.committed, false)
					assert.match(failed.error, /Tasklet settlement failed.*controlled final outcome write failure/)
				} else {
					await waitForOutcome(host, child.id)
					assert.deepEqual(host.listActive(), [])
					assert.equal((await (root as any).commitAttemptCompletion("durable result")).committed, true)
				}
			} finally {
				releaseWrite.resolve()
				if (failWrite) {
					await assert.rejects(root.abortTask(), /Tasklet shutdown failed/)
					tasks.splice(tasks.indexOf(root), 1)
				}
			}
		})
	}

	it("accepts lifecycle continuation without an unidentified permission decision", async () => {
		const root = createResolutionRoot()
		await assert.rejects(root.submitCardResponse("", DiracAskResponse.APPROVE), /exact card ID/)
		await root.submitCardResponse("", DiracAskResponse.MESSAGE)
		assert.equal(root.stateView.askResponse, DiracAskResponse.MESSAGE)
		assert.equal(root.stateView.askResponseCardId, undefined)
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
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			releaseTaskLock: release,
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
		})
		const host = root.taskletHost!
		assert.ok(host)
		let releaseProviders!: () => void
		let enteredBoth!: () => void
		const providers = new Promise<void>((resolve) => {
			releaseProviders = resolve
		})
		const entered = new Promise<void>((resolve) => {
			enteredBoth = resolve
		})
		let turns = 0
		nextTurn = async () => {
			if (++turns === 2) enteredBoth()
			await providers
			return "complete"
		}
		let releaseRecord!: () => void
		let writingRecord!: () => void
		const recordGate = new Promise<void>((resolve) => {
			releaseRecord = resolve
		})
		const recordEntered = new Promise<void>((resolve) => {
			writingRecord = resolve
		})
		const storage = await import("@core/storage/taskStorage")
		const originalSave = storage.saveTaskletRecord
		const save = sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (record.outcome) {
				writingRecord()
				await recordGate
			}
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
			} finally {
				await deletionLock()
			}
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
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			toolSelectionPolicy: { mode: "exact", toolIds: ["respond", "execute_command"] },
			releaseTaskLock: release,
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
		})
		const host = root.taskletHost!
		let turn = 0
		nextTurn = async () => (++turn === 1 ? "execute_command" : "complete")
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
			await Promise.all([assert.rejects(root.abortTask(), /Tasklet shutdown failed/), failedEscalation])
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
			...params,
			taskId: "root",
			executionProfile: "standalone",
			tasklet: undefined,
			releaseTaskLock: release,
			updateTaskHistory: async () => [],
			postStateToWebview: async () => { },
			postPresentationToWebview: async () => { },
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
			await assert.rejects(host["children"].get(first.id)!.settlement!, /child transcript disk failure/)
			const second = await host.start({ title: "sibling", prompt: "Sibling completes independently" })
			await waitForOutcome(host, second.id)
			assert.equal(host.inspect(first.id).outcome?.kind, "failed")
			assert.match(host.inspect(first.id).settlementError!.message, /child transcript disk failure/)
			assert.equal(host.inspect(second.id).outcome?.kind, "completed")
			assert.equal(host.inspect(second.id).outcomePersisted, true)
			const completion = await (root as any).commitAttemptCompletion("not durable")
			assert.equal(completion.committed, false)
			assert.match(completion.error, /Tasklet settlement failed.*child transcript disk failure/)
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
			await assert.rejects(host["children"].get(record.id)!.settlement!, /final transcript flush failed/)
			const result = host.inspect(record.id)
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
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const firstEntered = new Promise<void>((resolve) => {
			enteredFirst = resolve
		})
		const secondEntered = new Promise<void>((resolve) => {
			enteredSecond = resolve
		})
		let turn = 0
		nextTurn = async () => {
			turn++
			if (turn === 1) {
				enteredFirst()
				await firstGate
				return "complete"
			}
			if (turn === 2) {
				enteredSecond()
				await secondGate
				return "progress"
			}
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
			const record = JSON.parse(
				await fs.readFile(path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord), "utf8"),
			)
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
			await updateTaskMetadata(address, (metadata) => {
				metadata.active_skill_ids = ["retained-tasklet-skill"]
			})
			const toolDirectory = path.join(getTaskDirectoryPath(address), "tools", "retained_tasklet_tool")
			await fs.mkdir(toolDirectory, { recursive: true })
			await fs.writeFile(
				path.join(toolDirectory, "dirac-tool.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "retained_tasklet_tool",
					name: "retained_tasklet_tool",
					scope: "task",
					entry: "tool.ts",
					createdBy: "dirac",
					createdAt: "2026-05-29T00:00:00.000Z",
				}),
			)
			await fs.writeFile(
				path.join(toolDirectory, "tool.ts"),
				`export const spec = { id: "retained_tasklet_tool", name: "retained_tasklet_tool", description: "Retained context" }; export function create() { return { spec() { return spec }, supportedSurfaces() { return ["all"] }, async processCall() { return "retained" } } }`,
			)
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
			assert.deepEqual(
				(await getSavedPresentationHistory(address)).messages.at(-1)!.conversationHistoryDeletedRange,
				[2, 3],
			)
			assert.deepEqual(await getSavedApiConversationProviderState(address), {})
			let finishRoot: (() => void) | undefined
			let rootRun: Promise<unknown> | undefined
			try {
				if (reopenRoot) {
					await root.messageStateHandler.overwriteApiConversationHistory([
						{ role: "user", content: [{ type: "text", text: "ROOT_CONTEXT" }] },
					])
					await root.abortTask()
					const reopenedRoot = createResolutionRoot()
					sandbox.stub(reopenedRoot as any, "waitForFollowUp").resolves(undefined)
					const modelPresets = await import("@core/models/modelProviderPresets")
					sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
					let rootEntered!: () => void
					const rootStarted = new Promise<void>((resolve) => {
						rootEntered = resolve
					})
					const rootGate = new Promise<void>((resolve) => {
						finishRoot = resolve
					})
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
				assert.deepEqual(
					(await getSavedPresentationHistory(address)).messages.at(-1)!.conversationHistoryDeletedRange,
					[2, 3],
				)
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
		await root.messageStateHandler.overwriteApiConversationHistory([
			{ role: "user", content: [{ type: "text", text: "ROOT_REOPEN_CONTEXT" }] },
		])
		await root.messageStateHandler.flushPendingWrites()
		await root.abortTask()
		const reopenedRoot = createResolutionRoot()
		sandbox.stub(reopenedRoot as any, "waitForFollowUp").resolves(undefined)
		const modelPresets = await import("@core/models/modelProviderPresets")
		sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
		const requestsBeforeRootResume = requests.length
		let rootRestored = false
		const outcome = await reopenedRoot.resumeTaskFromHistory(
			() => {
				rootRestored = true
				assert.equal(requests.length, requestsBeforeRootResume, "Reconstruction must not start a child provider request")
				assert.deepEqual(reopenedRoot.taskletHost!.listActive(), [])
				assert.equal(reopenedRoot.taskletHost!.inspect(child.id).outcome?.kind, "completed")
			},
			{ initialUserInput: { text: "ROOT_FOLLOWUP" } },
		)
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
				providerId: "anthropic",
				modelId: "claude-opus-4-20250514",
				compactedThroughHistoryIndex: saved.messages.length - 1,
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
		nextTurn = async () => (++turn === 1 ? "execute_command" : "complete")
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
		it("publishes child accounting while the parent sleeps and the active count stays unchanged", async () => {
			const root = createResolutionRoot()
			const host = root.taskletHost!
			const publish = sandbox.stub(root as any, "postPresentationToWebview").resolves()
			const completion = deferred<TaskRunOutcome>()
			const start = sandbox.stub(Task.prototype, "startTask").returns(completion.promise)
			const child = await host.start({ title: "Active usage", prompt: "Keep working" })
			const childTask = start.firstCall.thisValue as Task
			const cancellation = new AbortController()
			const sleeping = host.sleep({ taskletIds: [child.id] }, cancellation.signal)
			publish.resetHistory()
			try {
				await childTask.messageStateHandler.addToDiracMessages({
					id: "active-usage", ts: 1,
					content: { type: DiracMessageType.API_STATUS, status: { tokensIn: 100, tokensOut: 20, cost: 0.5 } },
				})
				await host["children"].get(child.id)!.recordWrites
				sinon.assert.calledOnce(publish)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalCost, 0.5)
				assert.equal(host.observationSummary().activeCount, 1)
				assert.equal(host.inspect(child.id).outcome, undefined)
				assert.equal(host.isSleeping, true, "Accounting publication does not create child communication")

				await childTask.messageStateHandler.patchApiStatusById("active-usage", { tokensIn: 200, cost: 1 })
				await host["children"].get(child.id)!.recordWrites
				sinon.assert.calledTwice(publish)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalCost, 1)
				assert.equal(host.observationSummary().activeCount, 1)
				assert.equal(host.isSleeping, true)
			} finally {
				cancellation.abort()
				await sleeping
				completion.resolve({ kind: "completed", response: "Done", completedAt: 123 })
				await waitForOutcome(host, child.id)
			}
		})

		it("keeps accounting publication failures informational through child settlement", async () => {
			expectLoggerErrors()
			const root = createResolutionRoot()
			const host = root.taskletHost!
			const publish = sandbox.stub(root as any, "postPresentationToWebview").resolves()
			const completion = deferred<TaskRunOutcome>()
			const start = sandbox.stub(Task.prototype, "startTask").returns(completion.promise)
			const child = await host.start({ title: "Usage publication failure", prompt: "Work" })
			const childTask = start.firstCall.thisValue as Task
			publish.resetHistory()
			publish.rejects(new Error("Controlled accounting publication failure"))
			try {
				await childTask.messageStateHandler.addToDiracMessages({
					id: "failed-publication-usage", ts: 1,
					content: { type: DiracMessageType.API_STATUS, status: { tokensIn: 100, tokensOut: 20, cost: 0.5 } },
				})
				await host["children"].get(child.id)!.recordWrites
				sinon.assert.calledOnce(publish)
				assert.equal(getApiMetrics(root.messageStateHandler.getDiracMessages()).totalCost, 0.5)
				assert.equal(host.inspect(child.id).settlementError, undefined)
			} finally {
				completion.resolve({ kind: "completed", response: "Done", completedAt: 123 })
			}
			const settled = await waitForOutcome(host, child.id)
			assert.equal(settled.outcome?.kind, "completed")
			assert.equal(settled.settlementError, undefined)
			assert.equal(host.observationSummary().activeCount, 0)
			const saved = (await getSavedPresentationHistory("root")).messages
			assert.equal(getApiMetrics(saved).totalCost, 0.5)
		})

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
			const contributions = messages.flatMap((message) =>
				message.content.type === DiracMessageType.CARD
					? [getTaskletUsage(message.content.card)].filter((usage) => usage !== undefined)
					: [],
			)
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
			const cards = root.messageStateHandler
				.getDiracMessages()
				.filter((message) => message.content.type === DiracMessageType.CARD && getTaskletUsage(message.content.card))
			assert.equal(cards.length, 1, "Follow-up replaces the stable accounting projection")
			const address = { kind: "tasklet" as const, rootTaskId: "root", taskletId: child.id }
			const record = JSON.parse(
				await fs.readFile(path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord), "utf8"),
			)
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
				tokensIn: 200,
				tokensOut: 40,
				cacheWrites: 6,
				cacheReads: 8,
				cost: 1.25,
				reasoningTokens: 10,
			}
			await fs.writeFile(recordPath, JSON.stringify(record))

			const reopened = createResolutionRoot()
			const host = reopened.taskletHost!
			await host.reconstruct()
			await host.reconcileRootProjection()
			assert.equal(requests.length, 1, "Reconstruction does not run a provider")
			assert.equal(host.inspect(child.id).usage?.primary.tokensIn, 200)
			assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, 200)
			await host.resume(child.id, "INCUR_ONLY_ONE_NEW_REQUEST")
			const resumed = await waitForOutcome(host, child.id)
			assert.equal(resumed.outcome?.kind, "completed")
			assert.equal(resumed.conversationUlid, child.conversationUlid)
			assert.deepEqual(resumed.usage?.primary, {
				tokensIn: 300,
				tokensOut: 60,
				cacheWrites: 6,
				cacheReads: 8,
				cost: 1.25,
				reasoningTokens: 10,
				usageObserved: true,
				usageAvailability: {
					inputTokens: true,
					outputTokens: true,
					cacheWrites: false,
					cacheReads: false,
					cost: false,
					reasoningTokens: false,
				},
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
			nextTurn = async () => (requests.length === 1 ? "execute_command" : "complete")
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
			await root.messageStateHandler.overwriteApiConversationHistory([
				{ role: "user", content: [{ type: "text", text: "ROOT_REOPEN_USAGE" }] },
			])
			await root.abortTask()
			const reopened = createResolutionRoot()
			sandbox.stub(reopened as any, "waitForFollowUp").resolves(undefined)
			const modelPresets = await import("@core/models/modelProviderPresets")
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			let restored = false
			assert.equal(
				(
					await reopened.resumeTaskFromHistory(
						() => {
							restored = true
							assert.equal(requests.length, 1, "Reconstruction does not run child providers")
							assert.deepEqual(reopened.taskletHost!.listActive(), [])
							assert.equal(reopened.taskletHost!.inspect(child.id).usage?.primary.tokensIn, 100)
							assert.equal(getApiMetrics(reopened.messageStateHandler.getDiracMessages()).totalTokensIn, 100)
						},
						{ initialUserInput: { text: "ROOT_ONLY_NEW_USAGE" } },
					)
				).kind,
				"completed",
			)
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
					getModel: () => ({
						id: "controlled-utility",
						info: { contextWindow: 200_000, maxTokens: 8192, supportsPromptCache: false },
					}),
					async *createMessage(): ApiStream {
						yield {
							type: "usage",
							inputTokens: 11,
							outputTokens: 7,
							reasoningTokens: 3,
							cacheReadTokens: 2,
							cacheWriteTokens: 1,
							totalCost: 0.5,
						}
						yield {
							type: "text",
							text: invalidSummary ? "" : "Continue the private assignment under the parent's constraints.",
						}
					},
				} as ApiHandler
				let generated = false
				nextTurn = async () => {
					if (!generated) {
						generated = true
						const task = started.firstCall.thisValue as Task
						const summary = (task as any).localConversationCompaction.generateSummary(
							{ provider: "anthropic", modelId: "controlled-utility" },
							() => utilityHandler,
							createDefaultTextCondensationTemplateRegistry(),
							undefined,
							[],
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
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 1,
					cacheReads: 2,
					cost: 0.5,
					reasoningTokens: 3,
					usageObserved: true,
					usageAvailability: {
						inputTokens: true,
						outputTokens: true,
						cacheWrites: true,
						cacheReads: true,
						cost: true,
						reasoningTokens: true,
					},
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
		const preserved = (
			await Promise.all([seedPreservedArtifacts({ kind: "task", taskId: "root" }), seedPreservedArtifacts(sibling)])
		).flat()
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
		const presentation = (await getSavedPresentationHistory(address)).messages
		assert.match(JSON.stringify(presentation), /Read from assignment.txt/)
		assert.equal(
			presentation.some(
				(message) =>
					message.content.type === DiracMessageType.CARD && message.content.card.kind === CardKind.TASK_COMPLETION,
			),
			false,
			"Private tasklets report completion to their counterparty, not through foreground completion cards",
		)
		sinon.assert.neverCalledWithMatch(params.tasklet!.counterparty.recordResponse as sinon.SinonStub, {
			operation: "complete",
		})
		assert.deepEqual(
			await getSavedApiConversationProviderState(address),
			task.messageStateHandler.getApiConversationProviderState(),
		)
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

	it("rejects Plan construction and mode changes for contained Tasks without changing parent configuration", async () => {
		assert.throws(() => create(parameters("plan")), /Act-mode/)
		const params = parameters()
		const original = structuredClone(params.workingConfiguration)
		const task = create(params)
		await assert.rejects(task.applyWorkingConfigurationUpdate({ settings: { mode: "plan" } }), /Act/)
		assert.equal(task.getWorkingConfiguration().settings.mode, "act")
		assert.deepEqual(params.workingConfiguration, original)
		nextTurn = async () => "complete"
		assert.equal((await task.startTask(params.task)).kind, "completed")
		assert.deepEqual(
			requests.map(({ mode }) => mode),
			["act"],
		)
	})

	it("forces a Plan parent's real child to Act while preserving the active Plan model on start and resume", async () => {
		const params = parameters("plan")
		const original = structuredClone(params.workingConfiguration)
		const host = createHost(params)
		nextTurn = async () => "complete"
		try {
			const child = await host.start({ title: "Read-only review", prompt: "Finish the review" })
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			await host.resume(child.id, "Follow up")
			assert.equal((await waitForOutcome(host, child.id)).outcome?.kind, "completed")
			assert.deepEqual(
				requests.map(({ mode }) => mode),
				["act", "act"],
			)
			assert.deepEqual(
				requests.map(({ model }) => model),
				["claude-sonnet-4-20250514", "claude-sonnet-4-20250514"],
			)
			assert.deepEqual(params.workingConfiguration, original)
		} finally {
			await host.shutdown()
		}
	})

	it("rejects missing bindings, mismatched identity, and root lock ownership before execution", () => {
		const params = parameters()
		assert.throws(() => new Task({ ...params, tasklet: undefined }), /private owner bindings/)
		assert.throws(() => new Task({ ...params, executionProfile: "standalone" }), /private owner bindings/)
		assert.throws(() => new Task({ ...params, taskId: createTaskletId() }), /identity/)
		assert.throws(() => new Task({ ...params, releaseTaskLock: rejectCall("root lock release") }), /root Task lock/)
		assert.throws(
			() =>
				new Task({
					...params,
					tasklet: {
						...params.tasklet!,
						storageAddress: {
							...params.tasklet!.storageAddress,
							rootTaskId: "../escape",
						},
					},
				}),
			/rootTaskId|Invalid/,
		)
		assert.equal(requests.length, 0)
	})
})
