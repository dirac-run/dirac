import { strict as assert } from "node:assert"
import { StateManager } from "@core/storage/StateManager"
import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import type { LocalState, Settings } from "@shared/storage/state-keys"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { buildTaskWorkingConfigurationUpdate, createTaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import { resolveTaskletConfiguration, taskletWorkingConfiguration } from "./index"
import type { TaskletConfiguration } from "./TaskletConfiguration"
import { type AgentBaseConfig, AgentConfigLoader } from "./tools/subagent/AgentConfigLoader"

function parentConfiguration(api: ApiConfiguration = {}, settings: Partial<Settings> = {}) {
	return createTaskWorkingConfiguration({
		settings: { mode: "plan", preferredLanguage: "French", ...settings } as Settings,
		apiConfiguration: {
			planModeApiProvider: "anthropic",
			planModeApiModelId: "claude-opus-4-6",
			actModeApiProvider: "anthropic",
			actModeApiModelId: "claude-opus-4-6",
			apiKey: "parent-secret",
			openRouterApiKey: "router-secret",
			...api,
		},
		workspaceConfiguration: { localSkillsToggles: { fixture: true } } as unknown as LocalState,
		executionOptions: {
			terminalReuseEnabled: true,
			vscodeTerminalExecutionMode: "backgroundExec",
			multiRootEnabled: false,
		},
	})
}

function namedProfile(overrides: Partial<AgentBaseConfig> = {}): AgentBaseConfig {
	const profile = {
		name: "Researcher",
		description: "Research a bounded question",
		systemPrompt: "Use the configured research approach.",
		skills: ["research"],
		tools: ["read_file", "respond:progress", "attempt_completion", "ask_followup_question", "say"],
		...overrides,
	}
	sinon.stub(AgentConfigLoader, "getInstance").returns({
		ready: async () => { },
		getCachedConfig: (name: string) => (name.trim().toLowerCase() === "researcher" ? profile : undefined),
	} as AgentConfigLoader)
	return profile
}

describe("TaskletConfiguration", () => {
	afterEach(() => sinon.restore())

	it("keeps generic defaults secret-free and inherits the current parent without pinning its model", async () => {
		const parent = parentConfiguration()
		const resolved = await resolveTaskletConfiguration({}, parent)
		assert.deepEqual(resolved, { includeHistory: false, timeoutSeconds: 600 })
		assert.equal(taskletWorkingConfiguration(parent, resolved), parent)

		const updated = buildTaskWorkingConfigurationUpdate(parent, {
			apiConfiguration: { planModeApiModelId: "claude-sonnet-4-6", apiKey: "rotated-secret" },
		})
		assert.equal(taskletWorkingConfiguration(updated, resolved), updated)
		assert.doesNotMatch(JSON.stringify(resolved), /secret|apiKey|apiConfiguration/)
	})

	it("maps named prompts, skills, history and tool restrictions without restricting parent interactions", async () => {
		const profile = namedProfile()
		const resolved = await resolveTaskletConfiguration(
			{ agentName: " Researcher ", includeHistory: true, timeoutSeconds: 12.5 },
			parentConfiguration(),
		)
		assert.deepEqual(resolved, {
			name: profile.name,
			description: profile.description,
			systemPrompt: profile.systemPrompt,
			skills: ["research"],
			allowedTools: ["read_file", "respond"],
			includeHistory: true,
			timeoutSeconds: 12.5,
		})
		profile.skills?.push("later")
		profile.tools.push("execute_command")
		assert.deepEqual(resolved.skills, ["research"])
		assert.deepEqual(resolved.allowedTools, ["read_file", "respond"])
		assert.equal(Object.hasOwn(resolved, "modelSelection"), false)
	})

	it("adds full respond when a profile lists no response alias", async () => {
		namedProfile({ tools: ["read_file", "edit_file:replace", "read_file"] })
		const resolved = await resolveTaskletConfiguration({ agentName: "Researcher" }, parentConfiguration())
		assert.deepEqual(resolved.allowedTools, ["read_file", "edit_file:replace", "respond"])
	})

	it("does not copy the obsolete default tool list for profiles without an explicit scope", async () => {
		namedProfile({ tools: [], skills: undefined })
		const resolved = await resolveTaskletConfiguration({ agentName: "Researcher" }, parentConfiguration())
		assert.equal(resolved.allowedTools, undefined)
		assert.equal(resolved.skills, undefined)
	})

	it("rejects unknown and blank profile names, including when Utility is requested", async () => {
		namedProfile()
		for (const agentName of ["missing", ""]) {
			await assert.rejects(
				resolveTaskletConfiguration({ agentName, useUtilityModel: true }, parentConfiguration()),
				/Unknown tasklet agent profile/,
			)
		}
	})

	it("pins a named model to the current mode's provider and maps dynamic fields in both modes", async () => {
		namedProfile({ modelId: "vendor/research-model" })
		const state = sinon.createStubInstance(StateManager)
		sinon.stub(StateManager, "get").returns(state)
		const parent = parentConfiguration({
			planModeApiProvider: "openrouter",
			planModeOpenRouterModelId: "vendor/parent-model",
		})
		const before = JSON.stringify(parent)
		const resolved = await resolveTaskletConfiguration({ agentName: "Researcher" }, parent)
		assert.equal(resolved.modelSelection?.provider, "openrouter")
		assert.equal(resolved.modelSelection?.modelId, "vendor/research-model")
		const child = taskletWorkingConfiguration(parent, resolved)
		assert.equal(child.settings.mode, "plan")
		assert.equal(child.settings.preferredLanguage, "French")
		assert.equal(child.settings.planModeOpenRouterModelId, "vendor/research-model")
		assert.equal(child.settings.actModeOpenRouterModelId, "vendor/research-model")
		assert.equal(child.apiConfiguration.planModeApiProvider, "openrouter")
		assert.equal(child.apiConfiguration.actModeApiProvider, "openrouter")
		assert.equal(child.apiConfiguration.openRouterApiKey, "router-secret")
		assert.equal(child.revision, parent.revision + 1)
		assert.deepEqual(child.executionOptions, parent.executionOptions)
		assert.deepEqual(child.workspaceConfiguration, parent.workspaceConfiguration)
		assert.equal(Object.isFrozen(child.apiConfiguration), true)
		assert.equal(JSON.stringify(parent), before)
	})

	it("uses the Act provider for named models when the parent is in Act", async () => {
		namedProfile({ modelId: "vendor/act-model" })
		const state = sinon.createStubInstance(StateManager)
		sinon.stub(StateManager, "get").returns(state)
		const parent = parentConfiguration(
			{ actModeApiProvider: "openrouter", actModeOpenRouterModelId: "vendor/parent" },
			{ mode: "act" },
		)
		const resolved = await resolveTaskletConfiguration({ agentName: "Researcher" }, parent)
		assert.equal(resolved.modelSelection?.provider, "openrouter")
		assert.equal(taskletWorkingConfiguration(parent, resolved).settings.mode, "act")
	})

	it("lets Utility override a named model while preserving its profile and OpenAI endpoint identity", async () => {
		namedProfile({ modelId: "not-an-anthropic-model" })
		const utility = {
			provider: "openai",
			modelId: "utility-model",
			openAiProfileName: "Internal",
			modelInfo: { contextWindow: 12000, supportsPromptCache: false },
			apiKey: "must-not-persist",
		}
		const parent = parentConfiguration(
			{
				openAiCompatibleProfiles: [
					{
						name: "Internal",
						baseUrl: "https://example.test/v1",
						apiKey: "endpoint-secret",
						modelId: "utility-model",
						modelInfo: { supportsPromptCache: false },
					},
				],
			},
			{ utilityModelSelection: utility as ModelProviderSelection },
		)
		const resolved = await resolveTaskletConfiguration({ agentName: "Researcher", useUtilityModel: true }, parent)
		assert.equal(resolved.name, "Researcher")
		assert.equal(resolved.modelSelection?.provider, "openai")
		assert.equal(resolved.modelSelection?.openAiProfileName, "Internal")
		assert.equal(resolved.modelSelection?.modelId, "utility-model")
		assert.ok(resolved.modelSelection)
		assert.equal(Object.hasOwn(resolved.modelSelection, "apiKey"), false)
		assert.doesNotMatch(JSON.stringify(resolved), /secret|must-not-persist/)
		const child = taskletWorkingConfiguration(parent, resolved)
		assert.equal(child.apiConfiguration.planModeOpenAiProfileName, "Internal")
		assert.equal(child.apiConfiguration.actModeOpenAiModelId, "utility-model")
		assert.equal(child.apiConfiguration.planModeOpenAiModelInfo?.contextWindow, 12000)
		assert.notEqual(resolved.modelSelection?.modelInfo, parent.settings.utilityModelSelection?.modelInfo)
	})

	it("reapplies persisted selections using current parent credentials and permissions, not current profile/Utility settings", async () => {
		const parent = parentConfiguration({}, { utilityModelSelection: { provider: "anthropic", modelId: "claude-sonnet-4-6" } })
		const resolved = await resolveTaskletConfiguration({ useUtilityModel: true }, parent)
		const persisted = JSON.parse(JSON.stringify(resolved)) as TaskletConfiguration
		const current = buildTaskWorkingConfigurationUpdate(parent, {
			apiConfiguration: { apiKey: "new-parent-secret" },
			settings: { mode: "act", yoloModeToggled: false, utilityModelSelection: undefined },
		})
		const resumed = taskletWorkingConfiguration(current, persisted)
		assert.equal(resumed.apiConfiguration.apiKey, "new-parent-secret")
		assert.equal(resumed.apiConfiguration.actModeApiModelId, "claude-sonnet-4-6")
		assert.equal(resumed.settings.mode, "act")
		assert.equal(resumed.settings.yoloModeToggled, false)
		assert.doesNotMatch(JSON.stringify(persisted), /secret|apiKey/)
	})

	it("rejects absent or malformed Utility selections", async () => {
		for (const utilityModelSelection of [
			undefined,
			{ provider: "unknown", modelId: "x" },
			{ provider: "anthropic", modelId: " " },
		]) {
			await assert.rejects(
				resolveTaskletConfiguration(
					{ useUtilityModel: true },
					parentConfiguration({}, { utilityModelSelection } as Partial<Settings>),
				),
				/Utility model is not configured/,
			)
		}
	})

	it("rejects static-provider fallback for named and Utility models", async () => {
		namedProfile({ modelId: "not-an-anthropic-model" })
		await assert.rejects(
			resolveTaskletConfiguration({ agentName: "Researcher" }, parentConfiguration()),
			/unavailable for provider anthropic/,
		)
		const parent = parentConfiguration(
			{},
			{ utilityModelSelection: { provider: "anthropic", modelId: "not-an-anthropic-model" } },
		)
		await assert.rejects(resolveTaskletConfiguration({ useUtilityModel: true }, parent), /unavailable for provider anthropic/)
	})

	it("validates missing provider, credentials and endpoint profiles through the existing API validator", async () => {
		namedProfile({ modelId: "claude-sonnet-4-6" })
		await assert.rejects(
			resolveTaskletConfiguration({ agentName: "Researcher" }, parentConfiguration({ planModeApiProvider: undefined })),
			/requires a configured parent API provider/,
		)
		await assert.rejects(
			resolveTaskletConfiguration(
				{ useUtilityModel: true },
				parentConfiguration({}, { utilityModelSelection: { provider: "dify", modelId: "dify" } }),
			),
			/Dify requires both an API key and base URL/,
		)
		await assert.rejects(
			resolveTaskletConfiguration(
				{ useUtilityModel: true },
				parentConfiguration(
					{},
					{ utilityModelSelection: { provider: "openai", modelId: "utility", openAiProfileName: "Missing" } },
				),
			),
			/profile not found/,
		)
	})

	it("rejects invalid/overflowing timeouts and accepts the maximum JavaScript timer duration", async () => {
		const parent = parentConfiguration()
		for (const timeoutSeconds of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			2 ** 31 / 1000,
			Number.MAX_VALUE,
		]) {
			await assert.rejects(resolveTaskletConfiguration({ timeoutSeconds }, parent), /Tasklet timeout/)
		}
		const timeoutSeconds = (2 ** 31 - 1) / 1000
		assert.equal((await resolveTaskletConfiguration({ timeoutSeconds }, parent)).timeoutSeconds, timeoutSeconds)
		assert.throws(
			() => taskletWorkingConfiguration(parent, { includeHistory: false, timeoutSeconds: Number.POSITIVE_INFINITY }),
			/Tasklet timeout/,
		)
	})
})
