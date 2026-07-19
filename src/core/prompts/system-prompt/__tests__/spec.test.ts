import { expect } from "chai"
import { describe, it } from "mocha"
import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"
import { shouldUseStrictToolSchemas, toolSpecFunctionDeclarations, toolSpecFunctionDefinition, toolSpecInputSchema } from "../spec"
import type { SystemPromptContext } from "../types"
const mockContext: SystemPromptContext = {
	cwd: "/test/project",
	ide: "TestIde",
	supportsBrowserUse: true,
	diracWebToolsEnabled: true,
	subagentsEnabled: true,
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

