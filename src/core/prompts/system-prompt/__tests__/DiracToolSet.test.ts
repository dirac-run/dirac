import { strict as assert } from "node:assert"
import { use_subagents_spec } from "@core/task/tools/modules/use_subagents/UseSubagentsTool"
import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiracToolSet } from "../registry/DiracToolSet"
import type { SystemPromptContext } from "../types"

const baseContext: SystemPromptContext = {
	providerInfo: {
		providerId: "openai",
		model: { id: "primary-model", info: { supportsPromptCache: false } },
		mode: "act",
	},
	ide: "Test IDE",
	subagentsEnabled: true,
}

function genericSubagentProperties(context: SystemPromptContext): Record<string, unknown> {
	const [spec] = DiracToolSet.withDynamicSubagentToolSpecs([use_subagents_spec], context)
	const parameter = spec.parameters?.find((candidate) => candidate.name === "subagents")
	return parameter?.items?.properties ?? {}
}

describe("DiracToolSet Utility subagent routing", () => {
	afterEach(() => sinon.restore())

	it("does not mention Utility routing when no Utility model is configured", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getAllCachedConfigsWithToolNames: () => [],
		} as unknown as AgentConfigLoader)

		const properties = genericSubagentProperties(baseContext)

		assert.equal("use_utility_model" in properties, false)
		assert.doesNotMatch(JSON.stringify(properties), /utility/i)
	})

	it("adds Utility routing to the generic subagent schema when configured", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getAllCachedConfigsWithToolNames: () => [],
		} as unknown as AgentConfigLoader)

		const properties = genericSubagentProperties({ ...baseContext, utilityModelConfigured: true })

		assert.deepEqual(properties.use_utility_model, {
			type: "boolean",
			description:
				"Run this subagent using the configured Utility model. 'Utility model' is a pre-configured model that is cost effective and fast, but unsuitable for complex tasks. Default: false.",
		})
	})

	it("adds Utility routing to configured-agent tools only when configured", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getAllCachedConfigsWithToolNames: () => [
				{
					toolName: "subagent_reviewer",
					config: {
						name: "reviewer",
						description: "Reviews code",
						tools: [],
						systemPrompt: "Review the code.",
					},
				},
			],
		} as unknown as AgentConfigLoader)

		const unavailable = DiracToolSet.getDynamicSubagentToolSpecs(baseContext)[0]
		const available = DiracToolSet.getDynamicSubagentToolSpecs({ ...baseContext, utilityModelConfigured: true })[0]

		assert.equal(
			unavailable.parameters?.some((parameter) => parameter.name === "use_utility_model"),
			false,
		)
		assert.equal(
			available.parameters?.some((parameter) => parameter.name === "use_utility_model"),
			true,
		)
	})

	it("preserves Utility routing in provider-native schemas", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getAllCachedConfigsWithToolNames: () => [],
		} as unknown as AgentConfigLoader)
		const strictOpenAIContext: SystemPromptContext = {
			...baseContext,
			utilityModelConfigured: true,
			providerInfo: {
				...baseContext.providerInfo,
				model: {
					...baseContext.providerInfo.model,
					info: { ...baseContext.providerInfo.model.info, supportsStrictTools: true },
				},
			},
		}
		const anthropicContext: SystemPromptContext = {
			...strictOpenAIContext,
			providerInfo: { ...strictOpenAIContext.providerInfo, providerId: "anthropic" },
		}
		const [strictOpenAISpec] = DiracToolSet.withDynamicSubagentToolSpecs([use_subagents_spec], strictOpenAIContext)
		const [anthropicSpec] = DiracToolSet.withDynamicSubagentToolSpecs([use_subagents_spec], anthropicContext)

		const [strictOpenAITool] = DiracToolSet.convertSpecsToNativeTools([strictOpenAISpec], strictOpenAIContext)
		const [anthropicTool] = DiracToolSet.convertSpecsToNativeTools([anthropicSpec], anthropicContext)
		const strictItems = (strictOpenAITool as any).function.parameters.properties.subagents.items
		const anthropicItems = (anthropicTool as any).input_schema.properties.subagents.items

		assert.equal((strictOpenAITool as any).function.strict, true)
		assert.deepEqual(strictItems.properties.use_utility_model.type, ["boolean", "null"])
		assert.equal(strictItems.required.includes("use_utility_model"), true)
		assert.deepEqual(anthropicItems.properties.use_utility_model, {
			type: "boolean",
			description:
				"Run this subagent using the configured Utility model. 'Utility model' is a pre-configured model that is cost effective and fast, but unsuitable for complex tasks. Default: false.",
		})
		assert.deepEqual(anthropicItems.required, ["task_title", "prompt"])
	})
})

describe("DiracToolSet named asynchronous tasklet schemas", () => {
	beforeEach(() => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getAllCachedConfigsWithToolNames: () => [
				{
					toolName: "subagent_reviewer",
					config: { name: "reviewer", description: "Reviews code", tools: [], systemPrompt: "Review the code." },
				},
			],
		} as unknown as AgentConfigLoader)
	})
	afterEach(() => sinon.restore())

	it("replaces the generic dispatcher with a named tool carrying the asynchronous contract", () => {
		const [spec] = DiracToolSet.withDynamicSubagentToolSpecs([use_subagents_spec], baseContext)
		assert.equal(spec.name, "subagent_reviewer")
		assert.match(spec.description as string, /Start a tasklet asynchronously/)
		assert.match(spec.description as string, /stable tasklet ID on startup acceptance or a startup failure/)
		assert.match(spec.description as string, /not the assignment's final result/)
		assert.match(spec.description as string, /Startup acceptance is not assignment success/)
		assert.match(spec.description as string, /parent communication and tasklets inspect/)
		assert.match(spec.description as string, /tasklets sleep/)
		assert.match(spec.description as string, /do not rely on polling alone/)
	})

	it("preserves generic configuration types and requires only title and prompt", () => {
		const [spec] = DiracToolSet.getDynamicSubagentToolSpecs(baseContext)
		assert.deepEqual(
			spec.parameters?.map(({ name, type, required }) => ({ name, type, required })),
			[
				{ name: "task_title", type: "string", required: true },
				{ name: "prompt", type: "string", required: true },
				{ name: "timeout", type: "integer", required: false },
				{ name: "include_history", type: "boolean", required: false },
			],
		)
		const timeout = spec.parameters?.find((parameter) => parameter.name === "timeout")?.instruction as string
		assert.match(timeout, /Per-execution timeout/)
		assert.match(timeout, /start and each explicit resumption/)
		assert.match(timeout, /deadline interrupts execution/)
		assert.match(timeout, /retains the conversation and tasklet ID/)
		assert.match(timeout, /requires explicit tasklets resume/)
		assert.match(timeout, /No 90-second wrap-up grace or automatic success/)
	})

	it("does not expose configured agents when delegation is disabled", () => {
		assert.deepEqual(DiracToolSet.getDynamicSubagentToolSpecs({ ...baseContext, subagentsEnabled: false }), [])
	})

	for (const provider of ["openai", "openai-strict", "anthropic", "gemini"]) {
		it(`${provider}: preserves named configuration types in native schemas`, () => {
			const strict = provider === "openai-strict"
			const context: SystemPromptContext = {
				...baseContext,
				utilityModelConfigured: true,
				providerInfo: {
					...baseContext.providerInfo,
					providerId: strict ? "openai" : provider,
					model: {
						...baseContext.providerInfo.model,
						info: { supportsPromptCache: false, supportsStrictTools: strict },
					},
				},
			}
			const [spec] = DiracToolSet.getDynamicSubagentToolSpecs(context)
			type NativeSchema = { properties: Record<string, { type: string | string[] }>; required: string[] }
			const [tool] = DiracToolSet.convertSpecsToNativeTools([spec], context) as unknown as {
				input_schema: NativeSchema
				parameters: NativeSchema
				function: { parameters: NativeSchema }
			}[]
			const schema =
				provider === "anthropic" ? tool.input_schema : provider === "gemini" ? tool.parameters : tool.function.parameters
			for (const [name, type] of Object.entries({
				task_title: "string",
				prompt: "string",
				timeout: "integer",
				include_history: "boolean",
				use_utility_model: "boolean",
			})) {
				const expected =
					provider === "gemini"
						? type === "integer"
							? "NUMBER"
							: type.toUpperCase()
						: strict && !["task_title", "prompt"].includes(name)
							? [type, "null"]
							: type
				assert.deepEqual(schema.properties[name].type, expected, name)
			}
			assert.deepEqual(
				schema.required,
				strict ? ["task_title", "prompt", "timeout", "include_history", "use_utility_model"] : ["task_title", "prompt"],
			)
		})
	}
})
