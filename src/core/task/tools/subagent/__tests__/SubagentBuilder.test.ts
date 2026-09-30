import { strict as assert } from "node:assert"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { RESPOND_TOOL_NAME, ResponseOperation } from "@shared/responseTool"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracDefaultTool } from "@/shared/tools"
import { AgentConfigLoader } from "../AgentConfigLoader"
import {
	SUBAGENT_DEFAULT_ALLOWED_TOOLS,
	SUBAGENT_PROGRESS_INSTRUCTION,
	SUBAGENT_SYSTEM_SUFFIX,
	SubagentBuilder,
} from "../SubagentBuilder"

function createTaskConfig(mode: "act" | "plan", provider: string): TaskConfig {
	const apiHandler = { getModel: sinon.stub(), createMessage: sinon.stub() }
	return {
		ulid: "ulid-123",
		mode,
		providerId: provider,
		callbacks: {
			createSubagentRuntime: sinon
				.stub()
				.callsFake((options: { modelId?: string; utilityModelSelection?: { provider: string } }) => ({
					providerId: options.utilityModelSelection?.provider ?? provider,
					model: { id: "test-model", info: {} },
					supportsNativeWebSearch: false,
					createMessage: apiHandler.createMessage,
					abort: sinon.stub(),
				}))
		},
	} as unknown as TaskConfig
}

function createRuntimeStub(config: TaskConfig): sinon.SinonStub {
	return config.callbacks.createSubagentRuntime as sinon.SinonStub
}

describe("SubagentBuilder", () => {
	afterEach(() => {
		sinon.restore()
	})

	it("uses cached config by subagent name and applies act-mode provider model override", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: (subagentName?: string) =>
				subagentName === "cached-agent"
					? {
						name: "cached-agent",
						description: "cached description",
						tools: [DiracDefaultTool.LIST_FILES],
						modelId: "gpt-5",
						systemPrompt: "cached system prompt",
					}
					: undefined,
		} as unknown as AgentConfigLoader)

		const config = createTaskConfig("act", "openai")
		const builder = new SubagentBuilder(config, "cached-agent")

		sinon.assert.calledOnceWithExactly(createRuntimeStub(config), {
			modelId: "gpt-5",
			utilityModelSelection: undefined,
		})
		assert.equal(builder.getProviderId(), "openai")

		assert.deepEqual(builder.getAllowedTools(), [
			DiracDefaultTool.LIST_FILES,
			`${RESPOND_TOOL_NAME}:${ResponseOperation.PROGRESS}`,
			`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
		])
		const prompt = builder.buildSystemPrompt("generated system prompt")
		assert.match(prompt, /# Agent Profile/)
		assert.match(prompt, /Name: cached-agent/)
		assert.match(prompt, /Description: cached description/)
		assert.match(prompt, /cached system prompt/)
		assert.match(prompt, new RegExp(SUBAGENT_SYSTEM_SUFFIX.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		assert.match(prompt, /create, modify, or delete files/)
		assert.doesNotMatch(prompt, /research subagent|do not modify or delete any pre-existing files/)
		assert.match(prompt, /respond with operation "progress"/)
		assert.match(prompt, /one or two lines/)
	})

	it("uses defaults when no cached config is provided", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)

		const config = createTaskConfig("act", "anthropic")
		const builder = new SubagentBuilder(config)
		sinon.assert.calledOnceWithExactly(createRuntimeStub(config), {
			modelId: undefined,
			utilityModelSelection: undefined,
		})

		assert.deepEqual(builder.getAllowedTools(), SUBAGENT_DEFAULT_ALLOWED_TOOLS)
		assert.ok(builder.getAllowedTools().includes(DiracDefaultTool.EDIT_FILE))
		assert.ok(builder.getAllowedTools().includes(DiracDefaultTool.FILE_NEW))
		assert.ok(builder.getAllowedTools().includes(DiracDefaultTool.EXECUTE_COMMAND))
		assert.equal(builder.getAllowedTools().includes(DiracDefaultTool.NEW_TASK), false)
		const prompt = builder.buildSystemPrompt("generated prompt")
		assert.equal(prompt, `generated prompt${SUBAGENT_SYSTEM_SUFFIX}${SUBAGENT_PROGRESS_INSTRUCTION}`)
		assert.match(prompt, /create, modify, or delete files/)
		assert.match(prompt, /current task mode/)
		assert.match(prompt, /delegated task scope/)
		assert.match(prompt, /verification results/)
		assert.doesNotMatch(prompt, /research subagent|do not modify or delete any pre-existing files/)
	})

	it("applies plan-mode openrouter model override fields", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: (subagentName?: string) =>
				subagentName === "openrouter-agent"
					? {
						name: "openrouter-agent",
						description: "openrouter plan agent",
						tools: [DiracDefaultTool.FILE_READ],
						modelId: "openrouter/custom-model",
						systemPrompt: "plan system",
					}
					: undefined,
		} as unknown as AgentConfigLoader)

		const config = createTaskConfig("plan", "openrouter")
		new SubagentBuilder(config, "openrouter-agent")

		sinon.assert.calledOnceWithExactly(createRuntimeStub(config), {
			modelId: "openrouter/custom-model",
			utilityModelSelection: undefined,
		})
	})

	it("supports explicit runtime tool allowlist and system suffix overrides", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => ({
				name: "configured-agent",
				description: "configured description",
				tools: [DiracDefaultTool.FILE_NEW],
				systemPrompt: "configured system",
			}),
		} as unknown as AgentConfigLoader)
		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "configured-agent", {
			allowedTools: [],
			systemSuffix: "\n\n# Custom Builder Mode",
		})

		assert.deepEqual(builder.getAllowedTools(), [
			`${RESPOND_TOOL_NAME}:${ResponseOperation.PROGRESS}`,
			`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
		])
		assert.equal(
			builder.buildSystemPrompt("generated prompt"),
			`configured system# Agent Profile\nName: configured-agent\nDescription: configured description\n\n\n\n# Custom Builder Mode${SUBAGENT_PROGRESS_INSTRUCTION}`,
		)
	})

	it("uses a Utility provider selection instead of the configured agent model override", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => ({
				name: "configured-agent",
				description: "configured description",
				tools: [DiracDefaultTool.LIST_FILES],
				modelId: "primary-provider-override",
				systemPrompt: "configured system",
			}),
		} as unknown as AgentConfigLoader)
		const utilityModelSelection = { provider: "openrouter" as const, modelId: "utility/model" }
		const config = createTaskConfig("act", "openai")

		const builder = new SubagentBuilder(config, "configured-agent", { utilityModelSelection })

		sinon.assert.calledOnceWithExactly(createRuntimeStub(config), {
			modelId: "primary-provider-override",
			utilityModelSelection,
		})
		assert.equal(builder.getProviderId(), "openrouter")
		assert.deepEqual(builder.getAllowedTools(), [
			DiracDefaultTool.LIST_FILES,
			`${RESPOND_TOOL_NAME}:${ResponseOperation.PROGRESS}`,
			`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
		])
	})
})
