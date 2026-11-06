import { expect } from "chai"
import { describe, it } from "mocha"
import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"
import {
	shouldUseStrictToolSchemas,
	toolSpecFunctionDeclarations,
	toolSpecFunctionDefinition,
	toolSpecInputSchema,
	toOpenAIResponsesAPITool,
} from "../spec"
import type { SystemPromptContext } from "../types"
import { respondSpec } from "@core/task/tools/modules/respond/RespondTool"
import { RESPONSE_OPERATIONS } from "@shared/responseTool"
import { tasklets_spec } from "@core/task/tools/modules/use_subagents/UseSubagentsTool"
const mockContext: SystemPromptContext = {
	cwd: "/test/project",
	ide: "TestIde",
	supportsBrowserUse: true,
	diracWebToolsEnabled: true,
	subagentsEnabled: true,
	lowVerbosityEnabled: true,
	providerInfo: { providerId: "test", model: { id: "test-model", info: { supportsPromptCache: false } }, mode: "act" },
	isTesting: true,
}

const makeTool = (overrides?: Partial<DiracToolSpec>): DiracToolSpec => ({
	id: DiracDefaultTool.FILE_READ,
	name: "read_file",
	description: "Read a file",
	parameters: [
		{
			name: "path",
			required: true,
			instruction: "The path of the file to read relative to {{CWD}}",
		},
		{
			name: "optional_param",
			required: false,
			instruction: "An optional parameter",
		},
	],
	...overrides,
})

describe("respond provider schemas", () => {
	it("preserves the compact operation and bounded options contract across providers", () => {
		const anthropic = toolSpecInputSchema(respondSpec, mockContext)
		const openAI = toolSpecFunctionDefinition(respondSpec, mockContext)
		const strictOpenAI = toolSpecFunctionDefinition(respondSpec, mockContext, true)
		const responses = toOpenAIResponsesAPITool(openAI)
		const gemini = toolSpecFunctionDeclarations(respondSpec, mockContext)
		const anthropicProperties = anthropic.input_schema.properties as Record<string, any>
		const openAIProperties = ((openAI as any).function.parameters as any).properties
		const strictProperties = ((strictOpenAI as any).function.parameters as any).properties
		const geminiProperties = gemini.parameters?.properties as Record<string, any>

		expect(Object.keys(anthropicProperties).sort()).to.deep.equal(["operation", "options", "text"])
		expect(anthropicProperties.operation.enum).to.deep.equal(RESPONSE_OPERATIONS)
		expect(anthropicProperties.operation.description).to.include("plan = Plan Mode response/proposal")
		expect(anthropicProperties.operation.description).to.include("question = required user input")
		expect(anthropicProperties.operation.description).to.include("complete = final Act Mode or subagent result")
		expect(anthropicProperties.options).to.include({ type: "array", minItems: 2, maxItems: 5 })
		expect(anthropicProperties.options.items).to.deep.equal({ type: "string" })
		expect(openAIProperties.operation.enum).to.deep.equal(RESPONSE_OPERATIONS)
		expect(strictProperties.options.type).to.deep.equal(["array", "null"])
		expect(strictProperties.options.items).to.deep.equal({ type: "string" })
		expect(geminiProperties.operation.enum).to.deep.equal(RESPONSE_OPERATIONS)
		expect(geminiProperties.options.items.type).to.equal("STRING")
		expect((responses as any).name).to.equal("respond")

		for (const description of [
			anthropicProperties.text.description,
			openAIProperties.text.description,
			strictProperties.text.description,
			(responses as any).parameters.properties.text.description,
			geminiProperties.text.description,
		]) {
			expect(description).to.include("The user has explicitly asked for a low verbosity response")
			expect(description).to.include("- progress:")
			expect(description).to.include("- question:")
			expect(description).to.include("- plan:")
			expect(description).to.include("decisions requiring the user's input")
			expect(description).to.include("- complete:")
		}
		expect((responses as any).description).to.include("The user has explicitly asked for a low verbosity response")
	})


	it("uses the neutral fixed contract when low verbosity is disabled", () => {
		const context = { ...mockContext, lowVerbosityEnabled: false }
		const anthropic = toolSpecInputSchema(respondSpec, context)
		const openAI = toolSpecFunctionDefinition(respondSpec, context)
		const strictOpenAI = toolSpecFunctionDefinition(respondSpec, context, true)
		const responses = toOpenAIResponsesAPITool(openAI)
		const gemini = toolSpecFunctionDeclarations(respondSpec, context)
		const descriptions = [
			anthropic.description,
			(anthropic.input_schema.properties as Record<string, any>).text.description,
			(openAI as any).function.description,
			(openAI as any).function.parameters.properties.text.description,
			(strictOpenAI as any).function.parameters.properties.text.description,
			(responses as any).description,
			(responses as any).parameters.properties.text.description,
			gemini.description,
			(gemini.parameters?.properties as Record<string, any>).text.description,
		]

		expect(descriptions).to.deep.equal([
			"Send a user-facing response.",
			"Response text.",
			"Send a user-facing response.",
			"Response text.",
			"Response text.",
			"Send a user-facing response.",
			"Response text.",
			"Send a user-facing response.",
			"Response text.",
		])
	})
	it("keeps both fixed contracts within intentional schema-size bounds", () => {
		const enabledAnthropicBytes = JSON.stringify(toolSpecInputSchema(respondSpec, mockContext)).length
		const enabledOpenAIBytes = JSON.stringify(toolSpecFunctionDefinition(respondSpec, mockContext)).length
		const disabledContext = { ...mockContext, lowVerbosityEnabled: false }
		const disabledAnthropicBytes = JSON.stringify(toolSpecInputSchema(respondSpec, disabledContext)).length
		const disabledOpenAIBytes = JSON.stringify(toolSpecFunctionDefinition(respondSpec, disabledContext)).length

		expect(disabledAnthropicBytes).to.be.at.most(Math.floor(1460 * 0.4))
		expect(disabledOpenAIBytes).to.be.at.most(Math.floor(1752 * 0.4))
		expect(enabledAnthropicBytes).to.be.at.most(2100)
		expect(enabledOpenAIBytes).to.be.at.most(2200)
	})
})

describe("tasklets provider schemas", () => {
	const names = [
		"operation",
		"tasklet_id",
		"view",
		"cursor",
		"limit",
		"call_id",
		"message_type",
		"messages",
		"message",
		"tasklet_ids",
		"timeout_ms",
	]
	const operations = ["list", "inspect", "message", "interrupt", "resume", "sleep"]

	for (const provider of ["Anthropic", "Gemini", "OpenAI non-strict", "OpenAI strict"] as const) {
		it(`${provider}: preserves control fields, constraints and answer/action semantics`, () => {
			const strict = provider === "OpenAI strict"
			const gemini = provider === "Gemini"
			const anthropic = toolSpecInputSchema(tasklets_spec, mockContext)
			const google = toolSpecFunctionDeclarations(tasklets_spec, mockContext)
			const openAI = toolSpecFunctionDefinition(tasklets_spec, mockContext, strict) as any
			const schema = (provider === "Anthropic" ? anthropic.input_schema : gemini ? google.parameters : openAI.function.parameters) as any
			const properties = schema.properties
			const type = (value: string, optional = false) => {
				if (gemini) return value === "integer" ? "NUMBER" : value.toUpperCase()
				return strict && optional ? [value, "null"] : value
			}

			expect(Object.keys(properties)).to.deep.equal(names)
			expect(schema.required).to.deep.equal(strict ? names : ["operation"])
			expect(schema.type).to.equal(type("object"))
			expect(properties.operation.type).to.equal(type("string"))
			expect(properties.operation.enum).to.deep.equal(operations)
			expect(properties.messages.type).to.deep.equal(type("array", true))
			expect(properties.messages.minItems).to.equal(1)
			expect(properties.messages.maxItems).to.equal(20)
			const item = properties.messages.items
			expect(item.properties.type.enum).to.deep.equal(["guidance", "question", "reply", "permission_decision"])
			expect(item.properties.action.description).to.include("not a permission grant")
			for (const name of ["tasklet_id", "message", "cursor", "call_id", "message_type"]) {
				expect(properties[name].type).to.deep.equal(type("string", true))
				expect(properties[name].minLength).to.equal(1)
			}
			expect(properties.limit.type).to.deep.equal(type("integer", true))
			expect(properties.limit.minimum).to.equal(1)

			expect(properties.tasklet_ids.type).to.deep.equal(type("array", true))
			expect(properties.tasklet_ids.items).to.deep.equal({ type: type("string"), minLength: 1 })
			expect(properties.tasklet_ids).not.to.have.property("minItems")
			expect(properties.timeout_ms.type).to.deep.equal(type("integer", true))
			expect(properties.timeout_ms.minimum).to.equal(0)
			expect(properties.timeout_ms.maximum).to.equal(2147483647)

			if (provider.startsWith("OpenAI")) {
				expect(openAI.function.strict).to.equal(strict)
				expect(schema.additionalProperties).to.equal(false)
				expect((toOpenAIResponsesAPITool(openAI) as any).parameters).to.deep.include({
					properties: schema.properties,
					required: schema.required,
				})
			}
		})
	}
})

describe("toolSpecFunctionDeclarations (Gemini)", () => {
	it("includes parameter descriptions from instruction field", () => {
		const result = toolSpecFunctionDeclarations(makeTool(), mockContext)

		const pathParam = result.parameters?.properties?.["path"] as any
		expect(pathParam).to.exist
		expect(pathParam.description).to.be.a("string")
		expect(pathParam.description).to.include("path of the file to read")
	})

	it("includes descriptions for all parameters", () => {
		const result = toolSpecFunctionDeclarations(makeTool(), mockContext)

		const props = result.parameters?.properties as any
		expect(props["path"].description).to.be.a("string").and.not.be.empty
		expect(props["optional_param"].description).to.be.a("string").and.not.be.empty
	})

	it("handles function-type instructions", () => {
		const tool = makeTool({
			parameters: [
				{
					name: "dynamic",
					required: true,
					instruction: (ctx: SystemPromptContext) => `Dynamic value: ${ctx.cwd}`,
				},
			],
		})
		const result = toolSpecFunctionDeclarations(tool, mockContext)

		const param = result.parameters?.properties?.["dynamic"] as any
		expect(param.description).to.equal("Dynamic value: /test/project")
	})

	it("omits description when instruction is empty", () => {
		const tool = makeTool({
			parameters: [{ name: "empty", required: false, instruction: "" }],
		})
		const result = toolSpecFunctionDeclarations(tool, mockContext)

		const param = result.parameters?.properties?.["empty"] as any
		expect(param.description).to.be.undefined
	})
})

describe("Gemini and Anthropic parameter descriptions match", () => {
	it("both converters produce the same description text", () => {
		const tool = makeTool()
		const gemini = toolSpecFunctionDeclarations(tool, mockContext)
		const anthropic = toolSpecInputSchema(tool, mockContext)

		const geminiDesc = (gemini.parameters?.properties?.["path"] as any)?.description
		const anthropicDesc = (anthropic.input_schema as any).properties["path"]?.description

		expect(geminiDesc).to.equal(anthropicDesc)
	})
})

describe("native tool placeholder replacement", () => {
	it("replaces CWD and MULTI_ROOT_HINT placeholders in descriptions", () => {
		const context: SystemPromptContext = {
			...mockContext,
			isMultiRootEnabled: true,
		}
		const tool = makeTool({
			parameters: [
				{
					name: "path",
					required: true,
					instruction: "Path (relative to {{CWD}}){{MULTI_ROOT_HINT}}",
				},
			],
		})

		const openAI = toolSpecFunctionDefinition(tool, context)
		const anthropic = toolSpecInputSchema(tool, context)
		const gemini = toolSpecFunctionDeclarations(tool, context)

		const openAIDesc = ((openAI as any).function.parameters.properties.path as any).description as string
		const anthropicDesc = ((anthropic as any).input_schema.properties.path as any).description as string
		const geminiDesc = (gemini.parameters?.properties?.["path"] as any)?.description as string

		for (const desc of [openAIDesc, anthropicDesc, geminiDesc]) {
			expect(desc).to.include("/test/project")
			expect(desc).to.include("Use @workspace:path syntax")
			expect(desc).to.not.include("{{CWD}}")
			expect(desc).to.not.include("{{MULTI_ROOT_HINT}}")
		}
	})
})
describe("toolSpecFunctionDefinition strict optional parameters", () => {
	it("makes optional primitive parameters nullable while requiring every property", () => {
		const result = toolSpecFunctionDefinition(
			makeTool({
				parameters: [
					{ name: "required_param", required: true, type: "boolean", instruction: "Required" },
					{ name: "optional_param", required: false, type: "boolean", instruction: "Optional" },
				],
			}),
			mockContext,
			true,
		) as any

		expect(result.function.parameters.required).to.deep.equal(["required_param", "optional_param"])
		expect(result.function.parameters.properties.required_param.type).to.equal("boolean")
		expect(result.function.parameters.properties.optional_param.type).to.deep.equal(["boolean", "null"])
	})

	it("preserves nested requiredness and nullable enum values through arrays", () => {
		const result = toolSpecFunctionDefinition(
			makeTool({
				parameters: [
					{
						name: "entries",
						required: true,
						type: "array",
						instruction: "Entries",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								mode: { type: "string", enum: ["fast", "safe"] },
							},
							required: ["name"],
						},
					},
				],
			}),
			mockContext,
			true,
		) as any

		const itemSchema = result.function.parameters.properties.entries.items
		expect(itemSchema.required).to.deep.equal(["name", "mode"])
		expect(itemSchema.properties.name.type).to.equal("string")
		expect(itemSchema.properties.mode.type).to.deep.equal(["string", "null"])
		expect(itemSchema.properties.mode.enum).to.deep.equal(["fast", "safe", null])
	})

	it("preserves primitive and container constraints while adding strict nullability", () => {
		const result = toolSpecFunctionDefinition(
			makeTool({
				parameters: [
					{
						name: "entries",
						required: true,
						type: "array",
						instruction: "Entries",
						minItems: 1,
						items: {
							type: "object",
							properties: {
								coordinate: { type: "string", pattern: "^[A-Z]+$", minLength: 1 },
							},
							required: [],
						},
					},
				],
			}),
			mockContext,
			true,
		) as any

		const entries = result.function.parameters.properties.entries
		expect(entries.minItems).to.equal(1)
		expect(entries.items.properties.coordinate.type).to.deep.equal(["string", "null"])
		expect(entries.items.properties.coordinate.pattern).to.equal("^[A-Z]+$")
		expect(entries.items.properties.coordinate.minLength).to.equal(1)
	})

	it("does not change non-strict optional parameters", () => {
		const result = toolSpecFunctionDefinition(makeTool(), mockContext, false) as any
		expect(result.function.parameters.required).to.deep.equal(["path"])
		expect(result.function.parameters.properties.optional_param.type).to.equal("string")
	})
})
describe("tools without parameters", () => {
	const noParamTool: DiracToolSpec = {
		id: DiracDefaultTool.LIST_SKILLS,
		name: "list_skills",
		description: "List skills",
	}

	it("OpenAI: includes empty parameters object", () => {
		const result = toolSpecFunctionDefinition(noParamTool, mockContext) as any
		expect(result.function.parameters).to.exist
		expect(result.function.parameters).to.deep.equal({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		})
	})

	it("Anthropic: includes empty properties and required in input_schema", () => {
		const result = toolSpecInputSchema(noParamTool, mockContext)
		expect(result.input_schema).to.deep.equal({
			type: "object",
			properties: {},
			required: [],
		})
	})

	it("Gemini: includes empty parameters object", () => {
		const result = toolSpecFunctionDeclarations(noParamTool, mockContext)
		expect(result.parameters).to.exist
		expect(result.parameters).to.deep.equal({
			type: "OBJECT",
			properties: {},
			required: [],
		})
	})
})

describe("shouldUseStrictToolSchemas", () => {
	const makeProviderInfo = (providerId: string, modelId: string, supportsStrictTools?: boolean) => ({
		providerId,
		model: { id: modelId, info: { supportsPromptCache: false, supportsStrictTools } },
		mode: "act" as const,
	})

	it("returns false when the model does not advertise strict tool support", () => {
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "openai/gpt-5", false))).to.be.false
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "openai/gpt-5", undefined))).to.be.false
		expect(shouldUseStrictToolSchemas(undefined)).to.be.false
	})

	it("allows strict schemas for OpenAI models served through OpenRouter", () => {
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "openai/gpt-5", true))).to.be.true
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "openai/gpt-5@preset/code", true))).to.be.true
	})

	it("disables strict schemas for non-OpenAI models on OpenRouter even when flagged", () => {
		// Regression: nullable-union strict schemas broke tool calling for models whose
		// upstream providers (vLLM/SGLang/llama.cpp-style) reject them.
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "qwen/qwen3-coder", true))).to.be.false
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openrouter", "anthropic/claude-sonnet-4.5", true))).to.be.false
	})

	it("keeps strict schemas for non-OpenRouter providers that advertise support", () => {
		expect(shouldUseStrictToolSchemas(makeProviderInfo("openai-native", "gpt-5", true))).to.be.true
	})
})
