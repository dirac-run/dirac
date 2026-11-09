import { setHostCapabilities } from "@hosts/host-capabilities"
import { strict as assert } from "node:assert"
import * as diracRules from "@core/context/instructions/user-instructions/dirac-rules"
import * as externalRules from "@core/context/instructions/user-instructions/external-rules"
import { RuleContextBuilder } from "@core/context/instructions/user-instructions/RuleContextBuilder"
import * as skills from "@core/context/instructions/user-instructions/skills"
import { DiracToolSet } from "@core/prompts/system-prompt"
import * as systemPrompt from "@core/prompts/system-prompt"
import * as disk from "@core/storage/disk"
import { subagents_spec } from "@core/task/tools/modules/subagents/SubagentsTool"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { buildApiRequestParams, type TaskRequestBuilderContext } from "../TaskRequestBuilder"
import type { TaskRequestRuntime } from "../runtime/TaskRequestRuntime"

const providerInfo = {
	providerId: "anthropic",
	model: { id: "primary-model", info: { supportsPromptCache: false } },
	mode: "act",
} as const

const nativeTools = [{ name: "native-tool" }] as any[]
const fullHistory = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: "second" },
]
const deletedRange: [number, number] = [0, 0]

describe("TaskRequestBuilder", () => {
	let sandbox: sinon.SinonSandbox
	let configuredAgents: any[]

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		configuredAgents = []
		sandbox.stub(HostProvider, "env" as any).value({
			getHostVersion: sandbox.stub().resolves({ platform: "test", diracType: 0 }),
		})
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: sandbox.stub().resolves({ paths: [] }),
			getVisibleTabs: sandbox.stub().resolves({ paths: [] }),
		})
		sandbox.stub(diracRules, "refreshDiracRulesToggles").resolves({ globalToggles: {}, localToggles: {} })
		sandbox.stub(diracRules, "getGlobalDiracRules").resolves({ instructions: undefined, activatedConditionalRules: [] })
		sandbox.stub(diracRules, "getLocalDiracRules").resolves({ instructions: undefined, activatedConditionalRules: [] })
		sandbox.stub(externalRules, "refreshExternalRulesToggles").resolves({
			windsurfLocalToggles: {},
			cursorLocalToggles: {},
			agentsLocalToggles: {},
		})
		sandbox.stub(externalRules, "getLocalCursorRules").resolves([undefined, undefined])
		sandbox.stub(externalRules, "getLocalWindsurfRules").resolves(undefined)
		sandbox.stub(externalRules, "getLocalAgentsRules").resolves(undefined)
		sandbox.stub(RuleContextBuilder.prototype, "buildEvaluationContext").resolves({})
		sandbox.stub(skills, "getOrDiscoverSkills").resolves([])
		sandbox.stub(disk, "ensureRulesDirectoryExists").resolves("/tmp/rules")
		sandbox.stub(disk, "ensureTaskDirectoryExists").resolves("/tmp/task")
		sandbox.stub(systemPrompt, "getSystemPrompt").resolves({ systemPrompt: "built system prompt" })
	})

	afterEach(() => {
		sandbox.restore()
		setHostCapabilities(undefined)
	})

	function createContext(
		utilityModelSelection: unknown,
		overrides: {
			mode?: "plan" | "act"
			providerId?: string
			modelId?: string
			browserSettings?: Record<string, unknown>
			preferredLanguage?: string
			requestId?: string
			revision?: number
		} = {},
	) {
		let capturedPromptContext: SystemPromptContext | undefined
		const writePromptMetadataArtifacts = sandbox.stub().resolves()
		const getGlobalSettingsKey = sandbox.stub().callsFake((key: string) => {
			if (key === "utilityModelSelection") return utilityModelSelection
			if (key === "subagentsEnabled") return true
			return undefined
		})
		const getSnapshotForRequest = sandbox.stub().callsFake(async (context: SystemPromptContext) => {
			capturedPromptContext = context
			return {
				inventoryVersion: 1,
				requestId: overrides.requestId ?? "request-1",
				configurationRevision: overrides.revision ?? 1,
				promptVisibleSpecs: [],
				inventoryEnabledTools: [],
				activeSkillIds: [],
				nativeTools,
				coordinator: {},
				executableToolNames: new Set(),
			}
		})
		const context = {
			executionProfile: "standalone",
			getPinnedContext: async () => undefined,
			taskId: "task-1",
			cwd: "/tmp/workspace",
			terminalExecutionMode: "backgroundExec",
			api: {},
			stateManager: {
				getGlobalSettingsKey,
				getSystemDefaultSettingsKey: sandbox.stub().callsFake((key: string) => key === "subagentRoles" ? configuredAgents : undefined),
				getGlobalStateKey: sandbox.stub().returns(undefined),
				getWorkspaceStateKey: sandbox.stub().returns(undefined),
			},
			messageStateHandler: {
				getApiConversationHistory: sandbox.stub().returns(fullHistory),
				getDiracMessages: sandbox.stub().returns([]),
			},
			taskMessenger: { upsertText: sandbox.stub().resolves() },
			toolExecutor: {
				getSnapshotForRequest,
				activateSnapshot: sandbox.stub(),
			},
			contextManager: {
				getNewContextMessagesAndMetadata: sandbox.stub().resolves({
					truncatedConversationHistory: fullHistory.map((message) => ({ ...message })),
					updatedConversationHistoryDeletedRange: false,
					conversationHistoryDeletedRange: deletedRange,
				}),
			},
			apiConversationManager: {
				scheduleProviderConversationCompaction: sandbox.stub().resolves(),
				prepareTranscriptInstructions: sandbox.stub().callsFake(async (instructions: string) => instructions),
			},
			diracIgnoreController: { yoloMode: false, diracIgnoreContent: undefined },
			taskState: {
				availableSkills: [],
				useNativeToolCalls: false,
				conversationHistoryDeletedRange: deletedRange,
			},
			getCurrentProviderInfo: () => providerInfo,
			isParallelToolCallingEnabled: () => false,
			writePromptMetadataArtifacts,
		} as unknown as TaskRequestBuilderContext
		const requestMode = overrides.mode ?? "act"
		const requestProviderId = overrides.providerId ?? "anthropic"
		const requestModelId = overrides.modelId ?? providerInfo.model.id
		const requestRuntime = {
			requestId: overrides.requestId ?? "request-1",
			api: {
				getModel: () => ({ ...providerInfo.model, id: requestModelId }),
				supportsNativeWebSearch: () => false,
			},
			workingConfiguration: {
				revision: overrides.revision ?? 1,
				settings: new Proxy(
					{},
					{
						get: (_target, key) =>
							(
								({
									mode: requestMode,
									utilityModelSelection,
									subagentsEnabled: true,
									browserSettings: overrides.browserSettings ?? {},
									preferredLanguage: overrides.preferredLanguage ?? "English",
									globalSkillsToggles: {},
									utilityModelEnabled: false,
									utilityModelUseCondense: true,
									yoloModeToggled: false,
									diracWebToolsEnabled: false,
									enableParallelToolCalling: false,
									useAutoCondense: false,
								}) as any
							)[key as any],
					},
				),
				apiConfiguration: {
					actModeApiProvider: requestProviderId,
					planModeApiProvider: requestProviderId,
				},
				workspaceConfiguration: { localSkillsToggles: {} },
				executionOptions: {
					terminalReuseEnabled: true,
					vscodeTerminalExecutionMode: "backgroundExec",
					multiRootEnabled: false,
				},
			},
		} as unknown as TaskRequestRuntime
		return { context, requestRuntime, getCapturedPromptContext: () => capturedPromptContext, writePromptMetadataArtifacts }
	}

	function genericSubagentProperties(context: SystemPromptContext): Record<string, unknown> {
		const [spec] = DiracToolSet.withSubagentRoleSpecs([subagents_spec], context)
		const subagents = spec.parameters?.find((parameter) => parameter.name === "assignments")
		return subagents?.items?.properties ?? {}
	}

	for (const contained of [false, true]) {
		it(`forwards ${contained ? "contained" : "legacy"} storage to context assembly`, async () => {
			const { context, requestRuntime } = createContext(undefined)
			if (contained)
				context.storageAddress = {
					kind: "tasklet",
					rootTaskId: "root",
					taskletId: "tasklet_00000000-0000-4000-8000-000000000001",
				}
			await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
			sinon.assert.calledOnceWithExactly(
				disk.ensureTaskDirectoryExists as sinon.SinonStub,
				context.storageAddress ?? context.taskId,
			)
		})
	}

	for (const profile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
		it(`provides ${profile} identity on every request without changing role/model instructions`, async () => {
			const { context, requestRuntime } = createContext(undefined)
			context.executionProfile = profile
			context.taskId = "Feynman 2"
			await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
			await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0, shouldCompact: true })
			const prepare = context.apiConversationManager.prepareTranscriptInstructions as sinon.SinonStub
			for (const call of prepare.getCalls()) {
				assert.match(call.args[1], profile === "tasklet" ? /"id":"Feynman 2","parent":"Dirac"/ : /"id":"Dirac","parent":null/)
				assert.match(call.args[1], /list_agents/)
				assert.equal(call.args[0], "built system prompt")
			}
		})
	}

	it("delivers changing supervision as tail context without changing system instructions", async () => {
		const { context, requestRuntime } = createContext(undefined)
		let current = JSON.stringify({ pending: [{ taskletId: "child", requestId: "exact-current-request" }] })
		context.getTaskletSupervisionContext = () => current
		const first = await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		assert.doesNotMatch(first.systemPrompt, /exact-current-request/)
		const prepare = context.apiConversationManager.prepareTranscriptInstructions as sinon.SinonStub
		assert.match(prepare.firstCall.args[1], /exact-current-request/)
		current = JSON.stringify({ pending: [], outcome: "committed" })
		const next = await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		assert.equal(next.systemPrompt, first.systemPrompt)
		assert.match(prepare.secondCall.args[1], /committed/)
		assert.doesNotMatch(prepare.secondCall.args[1], /exact-current-request/)
	})

	it("projects only current enabled global role names and descriptions on every request", async () => {
		const { context, requestRuntime, getCapturedPromptContext } = createContext(undefined)
		const selection = { provider: "anthropic", modelId: "role-model", reasoningEffort: "high" }
		configuredAgents = [
			{ name: "Reviewer", description: "Reviews code.", enabled: true, modelSelection: selection },
			{ name: "Disabled", description: "Not available.", enabled: false, modelSelection: selection },
		]
		await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		const first = getCapturedPromptContext()!
		assert.deepEqual(first.subagentRoles, [{ name: "Reviewer", description: "Reviews code." }])
		assert.doesNotMatch(JSON.stringify(first.subagentRoles), /role-model|reasoningEffort|modelSelection/)
		configuredAgents = [{ name: "Scout", description: "Examines code.", enabled: true, modelSelection: selection }]
		await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		assert.deepEqual(getCapturedPromptContext()!.subagentRoles, [{ name: "Scout", description: "Examines code." }])
		assert.deepEqual(first.subagentRoles, [{ name: "Reviewer", description: "Reviews code." }])
		assert.deepEqual(Object.keys(genericSubagentProperties(getCapturedPromptContext()!)), ["type", "task_header", "task_description"])
	})

	it("keeps ordinary prompt assembly for children and adds only a non-default role label", async () => {
		const { context, requestRuntime } = createContext(undefined)
		context.executionProfile = "tasklet"
		context.taskletConfiguration = { name: "Reviewer", modelSelection: { provider: "anthropic", modelId: "role-model" } }
		const result = await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		assert.match(result.systemPrompt, /built system prompt/)
		assert.match(result.systemPrompt, /Subagent Role\nReviewer/)
		assert.doesNotMatch(result.systemPrompt, /Execution Deadline|Agent Profile/)
	})

	it("does not advertise the board skill in a headless request even with cached discovery metadata", async () => {
		setHostCapabilities({})
			; (skills.getOrDiscoverSkills as sinon.SinonStub).resolves(skills.BUILTIN_SKILLS)
		const { context, requestRuntime, getCapturedPromptContext } = createContext(undefined)
		await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		assert.equal(
			getCapturedPromptContext()?.skills?.some((skill) => skill.name === "architecture-board"),
			false,
		)
		assert.equal(
			context.taskState.availableSkills.some((skill) => skill.name === "architecture-board"),
			false,
		)
	})

	for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
		it(`advertises foreground-only skills correctly in ${executionProfile} request assembly`, async () => {
			setHostCapabilities({
				architectureViewer: {
					prepare: async () => { },
					createPanel: async () => {
						throw new Error("not used")
					},
				},
			})
				; (skills.getOrDiscoverSkills as sinon.SinonStub).resolves(skills.BUILTIN_SKILLS)
			const { context, requestRuntime, getCapturedPromptContext } = createContext(undefined)
			context.executionProfile = executionProfile
			context.getPinnedContext = async () => undefined
			await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
			assert.equal(
				getCapturedPromptContext()?.skills?.some((skill) => skill.name === "architecture-board"),
				executionProfile !== "tasklet",
			)
			assert.equal(
				context.taskState.availableSkills.some((skill) => skill.name === "architecture-board"),
				executionProfile !== "tasklet",
			)
		})
	}

	it("uses one request runtime for prompt context, tools, provider reporting, and metadata", async () => {
		const requestBrowserSettings = { disableToolUse: true, remoteBrowserHost: "request.example" }
		const { context, requestRuntime, getCapturedPromptContext, writePromptMetadataArtifacts } = createContext(undefined, {
			mode: "plan",
			providerId: "openrouter",
			modelId: "request-model",
			browserSettings: requestBrowserSettings,
			preferredLanguage: "French - Français",
			requestId: "bound-request",
			revision: 7,
		})

		const result = await buildApiRequestParams(context, requestRuntime, { previousApiReqIndex: 0 })
		const promptContext = getCapturedPromptContext()
		assert.ok(promptContext)
		assert.equal(result.providerInfo.mode, "plan")
		assert.equal(result.providerInfo.providerId, "openrouter")
		assert.equal(result.providerInfo.model.id, "request-model")
		assert.equal(promptContext.providerInfo, result.providerInfo)
		assert.equal(promptContext.browserSettings, requestBrowserSettings)
		assert.match(promptContext.preferredLanguageInstructions ?? "", /fr/)
		assert.equal(result.toolSnapshot.requestId, "bound-request")
		assert.equal(result.toolSnapshot.configurationRevision, 7)
		sinon.assert.calledWithExactly(
			context.toolExecutor.getSnapshotForRequest as sinon.SinonStub,
			promptContext,
			requestRuntime,
		)

		const activatedRuntime = (context.toolExecutor.activateSnapshot as sinon.SinonStub).firstCall.args[1]
		assert.equal(activatedRuntime.requestId, "bound-request")
		assert.equal(activatedRuntime.workingConfiguration, requestRuntime.workingConfiguration)
		assert.equal(activatedRuntime.api, requestRuntime.api)
		assert.equal(activatedRuntime.toolSnapshot, result.toolSnapshot)
		assert.equal(writePromptMetadataArtifacts.firstCall.args[0].providerInfo, result.providerInfo)
	})
})
