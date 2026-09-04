import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import { DiracToolSet, PromptRegistry } from "@core/prompts/system-prompt"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import { SubagentTrajectoryEventType } from "@shared/subagents"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { ApiFormat } from "@/shared/proto/dirac/models"
import { Logger } from "@/shared/services/Logger"
import { DiracDefaultTool } from "@/shared/tools"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { TaskState } from "../../../TaskState"
import { ListFilesTool, list_files_spec } from "../../modules/list_files"
import { RespondTool, respondSpec } from "../../modules/respond/RespondTool"
import { SubagentBuilder } from "../SubagentBuilder"
import { SubagentRunner } from "../SubagentRunner"
import { SubagentRunRecorder } from "../SubagentRunRecorder"
import { SubagentToolExecutor } from "../SubagentToolExecutor"

function initializeHostProvider() {
	HostProvider.reset()
	HostProvider.initialize(
		"extension",
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		{
			workspaceClient: {},
			envClient: {
				getHostVersion: async () => ({ platform: "test" }),
			},
			windowClient: {},
			diffClient: {},
		} as never,
		() => undefined,
		async () => "",
		async () => "",
		"",
		"",
		async (_cwd: string) => undefined,
	)
}

function createTaskConfig(): TaskConfig {
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/tmp",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		lowVerbosityEnabled: true,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		context: {},
		taskState: new TaskState(),
		messageState: {},
		providerId: "anthropic",
		model: {
			id: "anthropic/claude-sonnet-4.5",
			info: {
				contextWindow: 200_000,
				apiFormat: ApiFormat.ANTHROPIC_CHAT,
				supportsPromptCache: true,
			},
		},
		supportsNativeWebSearch: false,
		services: {},
		browserSettings: {},
		focusChainSettings: {},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeCommands: false },
		},
		autoApprover: { shouldAutoApproveTool: sinon.stub().returns([false, false]) },
		callbacks: {
			say: sinon.stub().resolves(undefined),
			ask: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
			saveCheckpoint: sinon.stub().resolves(),
			sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			executeCommandTool: sinon.stub().resolves([false, "ok"]),
			cancelRunningCommandTool: sinon.stub().resolves(false),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
			updateFCListFromToolResponse: sinon.stub().resolves(),
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
			shouldAutoApproveToolWithPath: sinon.stub().resolves(false),
			resolveToolPathPermission: sinon.stub().resolves("utility_eligible"),
			postStateToWebview: sinon.stub().resolves(),
			cancelTask: sinon.stub().resolves(),
			applyLatestBrowserSettings: sinon.stub().resolves(undefined),
			switchToActMode: sinon.stub().resolves(false),
			setActiveHookExecution: sinon.stub().resolves(),
			clearActiveHookExecution: sinon.stub().resolves(),
			getActiveHookExecution: sinon.stub().resolves(undefined),
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			createSubagentRuntime: () => {
				const handler = coreApi.buildApiHandler({ actModeApiProvider: "anthropic" } as any, "act")
				return {
					providerId: "anthropic",
					model: structuredClone(handler.getModel()),
					supportsNativeWebSearch: handler.supportsNativeWebSearch?.() === true,
					createMessage: handler.createMessage.bind(handler),
					abort: () => handler.abort?.(),
				}
			},
		},
		coordinator: {
			getHandler: sinon.stub().callsFake((toolName: DiracDefaultTool) => {
				if (toolName === DiracDefaultTool.LIST_FILES) {
					return {
						execute: sinon.stub().resolves("ok"),
						getDescription: sinon.stub().returns("list_files"),
					}
				}

				return undefined
			}),
		},
	} as unknown as TaskConfig
}

function createTaskConfigWithListFilesSnapshot(): TaskConfig {
	const config = createTaskConfig()
	config.activeToolSnapshot = {
		inventoryVersion: 1,
		requestId: "test-main-snapshot",
		promptVisibleSpecs: [list_files_spec, respondSpec],
		inventoryEnabledTools: [
			{
				id: DiracDefaultTool.LIST_FILES,
				name: DiracDefaultTool.LIST_FILES,
				source: "builtin",
				exposure: { kind: "configurable" },
				spec: list_files_spec,
				factory: () => new ListFilesTool(),
				modulePath: "modules/list_files/tool.ts",
			},
			{
				id: DiracDefaultTool.RESPOND,
				name: DiracDefaultTool.RESPOND,
				source: "builtin",
				exposure: { kind: "configurable" },
				spec: respondSpec,
				factory: () => new RespondTool(),
				modulePath: "modules/respond/tool.ts",
			},
		],
		activeSkillIds: [],
		nativeTools: [{ name: "list_files" } as any, { name: DiracDefaultTool.RESPOND } as any],
		coordinator: config.coordinator as any,
		executableToolNames: new Set([DiracDefaultTool.LIST_FILES, DiracDefaultTool.RESPOND]),
		dynamicSubagentToolNames: new Set(),
	}
	return config
}

function stubApiHandler(createMessage: sinon.SinonStub, abort = sinon.stub()): sinon.SinonStub {
	sinon.stub(coreApi, "buildApiHandler").returns({
		abort,
		getModel: () => ({
			id: "anthropic/claude-sonnet-4.5",
			info: {
				contextWindow: 200_000,
				apiFormat: ApiFormat.ANTHROPIC_CHAT,
				supportsPromptCache: true,
			},
		}),
		createMessage,
	} as never)
	return abort
}

describe("SubagentRunner", () => {
	afterEach(() => {
		sinon.restore()
		HostProvider.reset()
	})

	for (const terminal of ["failed", "cancelled"] as const) {
		it(`retains reported request cost when a stream is ${terminal}`, async () => {
			if (terminal === "failed") expectLoggerErrors()
			const config = createTaskConfigWithListFilesSnapshot()
			const createMessage = sinon.stub().callsFake(async function* () {
				yield { type: "usage", inputTokens: 10, outputTokens: 0, totalCost: 0.1 }
				if (terminal === "cancelled") config.taskState.abort = true
				yield { type: "usage", inputTokens: 0, outputTokens: 5, totalCost: 0.2 }
				throw new Error("stream interrupted")
			})
			sinon.stub(PromptRegistry.getInstance(), "get").resolves("system prompt")
			sinon.stub(skills, "getOrDiscoverSkills").resolves([])
			stubApiHandler(createMessage)
			initializeHostProvider()
			const costs: number[] = []
			const result = await new SubagentRunner(config).run("Research", (update) => {
				if (update.stats) costs.push(update.stats.totalCost)
			})
			assert.equal(result.status, terminal)
			assert.equal(result.stats.totalCost, 0.2)
			assert.equal(result.stats.inputTokens, 10)
			assert.equal(result.stats.outputTokens, 5)
			assert.ok(costs.includes(0.2))
			sinon.assert.calledOnce(createMessage)
		})
	}


	it("keeps inherited Utility permission handling live", () => {
		let enabled = true
		const permissionDecisionBinding = {
			service: { decide: sinon.stub() },
			configurationRevision: 1,
		}
		const baseConfig = createTaskConfig()
		const taskMessenger = { createCard: sinon.stub() }
			; (baseConfig as any).taskMessenger = taskMessenger
		Object.defineProperty(baseConfig, "permissionDecisionBinding", {
			configurable: true,
			get: () => (enabled ? permissionDecisionBinding : undefined),
		})
		const harness = {
			baseConfig,
			runtime: {
				providerId: baseConfig.providerId,
				model: baseConfig.model,
				supportsNativeWebSearch: baseConfig.supportsNativeWebSearch,
			},
			options: { agentIdentity: undefined },
			runState: { activeCommandExecutions: 0 },
			markActivity: sinon.stub(),
		}
		const subagentConfig = (SubagentRunner.prototype as any).createSubagentTaskConfig.call(
			harness,
			new TaskState(),
			baseConfig.coordinator,
		)

		assert.equal(subagentConfig.permissionDecisionBinding, permissionDecisionBinding)
		assert.equal(subagentConfig.taskMessenger, taskMessenger)
		enabled = false
		assert.equal(subagentConfig.permissionDecisionBinding, undefined)
	})

	it("emits native tool_use blocks with matching tool_result tool_use_id across turns", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_1",
						name: DiracDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const assistantMessage = conversation[1] as {
				role: string
				content: Array<{ type?: string;[key: string]: unknown }>
			}
			assert.equal(assistantMessage.role, "assistant")

			const toolUse = assistantMessage.content.find((block) => block.type === "tool_use")
			assert.ok(toolUse)
			assert.equal(toolUse.id, "toolu_subagent_1")
			assert.equal(toolUse.name, DiracDefaultTool.LIST_FILES)

			const userMessage = conversation[2] as { role: string; content: Array<{ type?: string;[key: string]: unknown }> }
			assert.equal(userMessage.role, "user")
			const toolResult = userMessage.content.find((block) => block.type === "tool_result")
			assert.ok(toolResult)
			assert.equal(toolResult.tool_use_id, "toolu_subagent_1")

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.equal(context.lowVerbosityEnabled, true)
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-subagent-transcript-"))
		const recorder = await SubagentRunRecorder.create({
			taskId: "task-1",
			agent: { id: 1, name: "Transcript Agent" },
			taskTitle: "Record tool activity",
			prompt: "List files",
			timeoutSeconds: 600,
			includeHistory: false,
			taskDirectory,
			runId: "transcript",
		})

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot(), "subagent", { recorder })
		const updates: any[] = []
		const result = await runner.run("List files", (update) => {
			updates.push(update)
		})

		assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
		assert.equal(result.result, "done")
		assert.equal(createMessage.callCount, 2)
		assert.ok(
			updates.some(
				(update) =>
					update.trajectoryEvent?.type === SubagentTrajectoryEventType.TOOL &&
					update.trajectoryEvent.text.startsWith(DiracDefaultTool.LIST_FILES),
			),
		)
		assert.ok(updates.some((update) => update.trajectoryEvent?.type === SubagentTrajectoryEventType.TOOL_RESULT))
		await recorder.flush()
		const transcript = await fs.readFile(recorder.getPaths().transcriptPath, "utf8")
		assert.match(transcript, /tool_call/)
		assert.match(transcript, /toolu_subagent_1/)
		assert.match(transcript, /tool_result/)
		assert.match(transcript, /event \d+ · terminal/)
		await fs.rm(taskDirectory, { recursive: true, force: true })
	})

	it("syncs activated skills to the parent before a completed tool turn returns", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skill_complete_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: DiracDefaultTool.RESPOND } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		sinon.stub(SubagentToolExecutor.prototype, "executeToolCalls").callsFake(async (_calls, state, _snapshot, stats) => {
			state.activeSkillIds = ["web-search"]
			return { completed: { result: "done", stats }, toolResultBlocks: [] }
		})
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfigWithListFilesSnapshot()

		const result = await new SubagentRunner(config).run("Search", () => { })

		assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
		assert.deepEqual(config.taskState.activeSkillIds, ["web-search"])
	})

	it("delivers all accepted progress updates before normal completion", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: { function: { id: "call-1", name: DiracDefaultTool.LIST_FILES, arguments: "{}" } },
			}
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "call-2",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any, { name: "respond" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const delivered: string[] = []
		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("List files", async (update) => {
			await new Promise((resolve) => setTimeout(resolve, 5))
			if (update.trajectoryEvent) delivered.push(update.trajectoryEvent.type)
			if (update.status === SubagentExecutionStatus.COMPLETED) delivered.push("completed")
		})

		assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
		assert.deepEqual(delivered, [
			SubagentTrajectoryEventType.TOOL,
			SubagentTrajectoryEventType.TOOL_RESULT,
			SubagentTrajectoryEventType.TOOL,
			"completed",
		])
	})

	// Regression: run() must not await recorder.flush() — a slow/stuck append must not delay terminal completion.
	it("does not block terminal completion on a slow recorder flush (fire-and-forget)", async () => {
		expectLoggerErrors()
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: { function: { id: "call-1", name: DiracDefaultTool.LIST_FILES, arguments: "{}" } },
			}
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "call-2",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any, { name: "respond" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-subagent-flush-"))
		const recorder = await SubagentRunRecorder.create({
			taskId: "task-flush",
			agent: { id: 1, name: "Flush Agent" },
			taskTitle: "Verify fire-and-forget flush",
			prompt: "List files",
			timeoutSeconds: 600,
			includeHistory: false,
			taskDirectory,
			runId: "flush",
		})
		// Stub flush to hang — if run() awaited it, this test would never resolve.
		let resolveFlush: () => void = () => { }
		const flushPromise = new Promise<void>((resolve) => {
			resolveFlush = resolve
		})
		const flushStub = sinon.stub(recorder, "flush").returns(flushPromise)

		try {
			const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot(), "subagent", { recorder })
			const result = await runner.run("List files", () => { })

			assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
			assert.equal(result.result, "done")
			assert.ok(flushStub.called, "recorder.flush was called")
		} finally {
			resolveFlush()
			await flushPromise
			await new Promise((resolve) => setImmediate(resolve))
			await fs.rm(taskDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it("returns after the drain timeout when a progress observer never settles", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: { function: { id: "call-1", name: DiracDefaultTool.LIST_FILES, arguments: "{}" } },
			}
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "call-2",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any, { name: "respond" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
			const resultPromise = runner.run("List files", (update) => {
				if (!update.trajectoryEvent) return
				return new Promise<void>(() => { })
			})
			await clock.tickAsync(0)
			await clock.tickAsync(10_000)
			const result = await resultPromise

			assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
			assert.equal(result.result, "done")
		} finally {
			clock.restore()
		}
	})

	it("passes prior request token totals into the next-turn compaction check", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "usage",
				inputTokens: 11,
				outputTokens: 7,
				cacheWriteTokens: 3,
				cacheReadTokens: 2,
			}
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_previous_tokens_1",
						name: DiracDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_previous_tokens_complete_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const shouldCompactStub = sinon.stub(runner as any, "shouldCompactBeforeNextRequest").callsFake((...args: unknown[]) => {
			const [previousRequestTotalTokens] = args
			assert.equal(previousRequestTotalTokens, 23)
			return false
		})

		const result = await runner.run("List files", () => { })

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.callCount, 2)
		assert.equal(shouldCompactStub.callCount, 1)
	})

	it("falls back to non-native result blocks if structured tool calls appear while native mode is disabled", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_2",
						name: DiracDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const lastMessage = conversation[conversation.length - 1] as {
				role: string
				content: Array<{ type?: string;[key: string]: unknown }>
			}

			assert.equal(lastMessage.role, "user")
			assert.ok(lastMessage.content.every((block) => block.type === "text"))
			assert.equal(
				lastMessage.content.some((block) => block.type === "tool_result"),
				false,
			)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_2",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		sinon.stub(DiracToolSet, "convertSpecsToNativeTools").returns([])
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("List files", () => { })

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.callCount, 2)
	})

	it("retries empty assistant turns with a no-tools-used nudge before failing", async () => {
		let apiCallCount = 0
		const createMessage = sinon.stub().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			apiCallCount++
			if (apiCallCount === 1) {
				// First call: empty response (yields nothing)
				return
			}

			// Second call: verify nudge was added, then succeed
			const lastAssistant = conversation[1] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(lastAssistant.role, "assistant")
			assert.equal(lastAssistant.content[0]?.type, "text")
			assert.equal(lastAssistant.content[0]?.text, "Failure: I did not provide a response.")

			const lastUser = conversation[2] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(lastUser.role, "user")
			assert.equal(lastUser.content[0]?.type, "text")
			assert.match(lastUser.content[0]?.text || "", /did not include any tool calls/i)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_3",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		sinon.stub(DiracToolSet, "convertSpecsToNativeTools").returns([])
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("List files", () => { })

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.callCount, 2)
	})

	it("retries initial stream failures before failing", async () => {
		expectLoggerErrors()
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})
		createMessage.onThirdCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const runPromise = runner.run("List files", () => { })
		await clock.runAllAsync()
		const result = await runPromise
		clock.restore()

		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 3)
		assert.match(result.error || "", /stream_initialization_failed/i)
	})

	it("fails context window errors", async () => {
		expectLoggerErrors()
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield* []
			const contextError = new Error("context length exceeded")
				; (contextError as Error & { status: number }).status = 400
			throw contextError
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("Huge prompt", () => { })

		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 1)
		assert.match(result.error || "", /context length exceeded/i)
	})

	it("compacts and retries a statusless Codex context-window error", async () => {
		const requestConversationLengths: number[] = []
		const createMessage = sinon.stub().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			requestConversationLengths.push(conversation.length)
			const callNumber = requestConversationLengths.length

			if (callNumber <= 2) {
				yield {
					type: "tool_calls",
					tool_call: {
						function: {
							id: `toolu_subagent_context_${callNumber}`,
							name: DiracDefaultTool.LIST_FILES,
							arguments: JSON.stringify({ path: ".", recursive: false }),
						},
					},
				}
				return
			}

			if (callNumber === 3) {
				throw new Error(
					"Codex API stream error: Your input exceeds the context window of this model. Please adjust your input and try again.",
				)
			}

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_context_complete",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("Inspect the repository", () => { })

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.deepEqual(requestConversationLengths, [1, 3, 5, 3])
	})

	it("uses the configured task api handler for subagent requests", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_4",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("List files", () => { })

		assert.equal(result.status, "completed")
		assert.equal(createMessage.callCount, 1)
	})

	it("filters available skills to configured skills when subagent skills are configured", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_filtered_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["allowed-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["allowed-skill"])
		sinon.stub(skills, "getOrDiscoverSkills").resolves([
			{ name: "allowed-skill", description: "Allowed", path: "/skills/allowed/SKILL.md", source: "project" },
			{ name: "other-skill", description: "Other", path: "/skills/other/SKILL.md", source: "project" },
		])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("Run task", () => { })

		assert.equal(result.status, "completed")
		assert.equal(createMessage.callCount, 1)
	})

	it("uses all available skills when subagent skills are not configured", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_unconfigured_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["alpha-skill", "beta-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(undefined)
		sinon.stub(skills, "getOrDiscoverSkills").resolves([
			{ name: "alpha-skill", description: "Alpha", path: "/skills/alpha/SKILL.md", source: "project" },
			{ name: "beta-skill", description: "Beta", path: "/skills/beta/SKILL.md", source: "project" },
		])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("Run task", () => { })

		assert.equal(result.status, "completed")
		assert.equal(createMessage.callCount, 1)
	})

	it("logs a warning when a configured skill is not available", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_missing_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const warnStub = sinon.stub(Logger, "warn")
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["present-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["present-skill", "missing-skill"])
		sinon
			.stub(skills, "getOrDiscoverSkills")
			.resolves([{ name: "present-skill", description: "Present", path: "/skills/present/SKILL.md", source: "project" }])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("Run task", () => { })

		assert.equal(result.status, "completed")
		assert.equal(createMessage.callCount, 1)
		sinon.assert.calledWith(warnStub, "[SubagentRunner] Configured skill 'missing-skill' not found for subagent run.")
	})

	it("includes workspace metadata only in the initial user message", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const initialUser = conversation[0] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(initialUser.role, "user")
			const initialTexts = initialUser.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n")
			assert.match(initialTexts, /# Workspace Configuration/)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_workspace_1",
						name: DiracDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const followUpUser = conversation[2] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(followUpUser.role, "user")
			const followUpTexts = followUpUser.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n")
			assert.equal(followUpTexts.includes("# Workspace Configuration"), false)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_workspace_complete_1",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "done" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
		const result = await runner.run("List files", () => { })

		assert.equal(result.status, "completed")
		assert.equal(result.result, "done")
		assert.equal(createMessage.callCount, 2)
	})

	it("returns after the wrap-up deadline when the API stream ignores abort", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			await new Promise<void>(() => { })
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").resolves("system prompt")
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		const abort = stubApiHandler(createMessage)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const updates: any[] = []
			const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
			const runPromise = runner.run(
				"Never settles",
				(update) => {
					updates.push(update)
				},
				1,
			)
			await clock.tickAsync(91_000)
			const result = await runPromise

			assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
			assert.match(result.result || "", /timed out after 1 seconds and could not finish wrapping up within 90 seconds/i)
			sinon.assert.called(abort)
			assert.ok(updates.some((update) => update.isWrappingUp))
			assert.ok(updates.some((update) => update.status === SubagentExecutionStatus.COMPLETED))
		} finally {
			clock.restore()
		}
	})

	it("preserves the request cache while wrapping up and blocks further research", async () => {
		let stopInitialStream!: () => void
		let markInitialStreamStarted!: () => void
		const initialStreamStarted = new Promise<void>((resolve) => {
			markInitialStreamStarted = resolve
		})
		const abort = sinon.stub().callsFake(() => stopInitialStream())
		const createMessage = sinon.stub()
		let initialSystemPrompt: string | undefined
		let initialNativeTools: unknown

		createMessage.onFirstCall().callsFake(async function* (
			systemPrompt: string,
			_conversation: unknown[],
			nativeTools: unknown,
		) {
			initialSystemPrompt = systemPrompt
			initialNativeTools = nativeTools
			await new Promise<void>((resolve) => {
				stopInitialStream = resolve
				markInitialStreamStarted()
			})
		})
		createMessage.onSecondCall().callsFake(async function* (
			systemPrompt: string,
			conversation: unknown[],
			nativeTools: unknown,
		) {
			assert.equal(systemPrompt, initialSystemPrompt)
			assert.strictEqual(nativeTools, initialNativeTools)
			assert.equal(conversation.length, 2)
			const finalInstruction = conversation.at(-1) as { role: string; content: Array<{ text?: string }> }
			assert.equal(finalInstruction.role, "user")
			assert.match(finalInstruction.content[0]?.text || "", /research deadline has elapsed/i)
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_wrap_up_research",
						name: DiracDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onThirdCall().callsFake(async function* (
			systemPrompt: string,
			conversation: unknown[],
			nativeTools: unknown,
		) {
			assert.equal(systemPrompt, initialSystemPrompt)
			assert.strictEqual(nativeTools, initialNativeTools)
			const deniedResearchResult = conversation.at(-1) as {
				role: string
				content: Array<{ type?: string; content?: string }>
			}
			assert.equal(deniedResearchResult.role, "user")
			assert.match(deniedResearchResult.content[0]?.content || "", /research is no longer available/i)
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_wrap_up_complete",
						name: DiracDefaultTool.RESPOND,
						arguments: JSON.stringify({ operation: ResponseOperation.COMPLETE, text: "partial report" }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		const getPrompt = sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage, abort)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const updates: any[] = []
			const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
			const runPromise = runner.run(
				"Investigate",
				(update) => {
					updates.push(update)
				},
				1,
			)
			await initialStreamStarted
			await clock.tickAsync(1_000)
			await clock.tickAsync(100)
			const result = await runPromise

			assert.equal(result.status, SubagentExecutionStatus.COMPLETED)
			assert.equal(result.result, "partial report")
			assert.equal(createMessage.callCount, 3)
			assert.equal(getPrompt.callCount, 1)
			assert.ok(updates.some((update) => update.isWrappingUp))
		} finally {
			clock.restore()
		}
	})

	it("returns cancelled when the parent task is cancelled even if the API stream never settles", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			await new Promise<void>(() => { })
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").resolves("system prompt")
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		const abort = stubApiHandler(createMessage)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const config = createTaskConfigWithListFilesSnapshot()
			const runner = new SubagentRunner(config)
			const runPromise = runner.run("Never settles", () => { })
			await clock.tickAsync(0)
			config.taskState.abort = true
			await clock.tickAsync(50)
			const result = await runPromise

			assert.equal(result.status, SubagentExecutionStatus.CANCELLED)
			assert.match(result.error || "", /parent task was cancelled/i)
			sinon.assert.called(abort)
		} finally {
			clock.restore()
		}
	})

	// Regression: on timeout/parent-cancel, the terminal phase must transition
	// to "cancelled" — not stay "cancelling". The enterPhase call in
	// recordTerminal was dropped during the FB-15c extraction.
	it("reports cancelled phase on parent cancel, not cancelling", async () => {
		expectLoggerErrors()
		const createMessage = sinon.stub().callsFake(async function* () {
			await new Promise<void>(() => { })
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").resolves("system prompt")
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		const abort = stubApiHandler(createMessage)
		initializeHostProvider()

		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const config = createTaskConfigWithListFilesSnapshot()
			const updates: any[] = []
			const runner = new SubagentRunner(config)
			const runPromise = runner.run("Never settles", (update) => {
				updates.push(update)
			})
			await clock.tickAsync(0)
			config.taskState.abort = true
			await clock.tickAsync(50)
			const result = await runPromise

			assert.equal(result.status, SubagentExecutionStatus.CANCELLED)
			// Progress must show a terminal "cancelled" phase, not "cancelling".
			const cancelledUpdates = updates.filter((u) => u.status === SubagentExecutionStatus.CANCELLED)
			assert.ok(cancelledUpdates.length > 0, "should have at least one cancelled status update")
			assert.ok(
				cancelledUpdates.every((u) => u.phase === "cancelled"),
				`expected phase "cancelled", got phases: ${cancelledUpdates.map((u: any) => u.phase).join(", ")}`,
			)
		} finally {
			clock.restore()
		}
	})

	it("records first-chunk liveness warnings without waiting for the overall timeout", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			await new Promise<void>(() => { })
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").resolves("system prompt")
		sinon.stub(skills, "getOrDiscoverSkills").resolves([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-subagent-liveness-"))
		const recorder = await SubagentRunRecorder.create({
			taskId: "task-liveness",
			agent: { id: 1, name: "Liveness Agent" },
			taskTitle: "Observe first chunk",
			prompt: "Wait for the first provider chunk",
			timeoutSeconds: 600,
			includeHistory: false,
			taskDirectory,
			runId: "liveness",
		})
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		try {
			const config = createTaskConfigWithListFilesSnapshot()
			const updates: any[] = []
			const runPromise = new SubagentRunner(config, "subagent", { recorder }).run("Wait", (update) => {
				updates.push(update)
			})
			await clock.tickAsync(0)
			await clock.tickAsync(30_000)

			assert.ok(updates.some((update) => update.phase === "awaiting_first_provider_chunk"))
			assert.ok(updates.some((update) => update.isStalled === true))
			config.taskState.abort = true
			await clock.tickAsync(50)
			const result = await runPromise
			await recorder.flush()

			assert.equal(result.status, SubagentExecutionStatus.CANCELLED)
			const diagnostics = await fs.readFile(recorder.getPaths().diagnosticsPath, "utf8")
			assert.match(diagnostics, /awaiting_first_provider_chunk/)
			assert.match(diagnostics, /liveness_warning/)
			assert.match(diagnostics, /inactiveForMs/)
		} finally {
			clock.restore()
			await fs.rm(taskDirectory, { recursive: true, force: true })
		}
	})
})
