import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { toolSpecFunctionDefinition, toolSpecInputSchema } from "@core/prompts/system-prompt/spec"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { upsert_tool_spec } from "../constants"

// No dynamic instruction/context requirements are present in the upsert_tool spec.
const context = {} as SystemPromptContext

describe("upsert_tool provider schema", () => {
	const schemas = [
		{ name: "native", schema: () => toolSpecInputSchema(upsert_tool_spec, context).input_schema },
		{ name: "OpenAI non-strict", schema: () => (toolSpecFunctionDefinition(upsert_tool_spec, context, false) as any).function.parameters },
		{ name: "OpenAI strict", schema: () => (toolSpecFunctionDefinition(upsert_tool_spec, context, true) as any).function.parameters },
	]
	for (const provider of schemas) {
		it(`keeps serialized smoke_args usable in the ${provider.name} schema`, () => {
			const schema = provider.schema() as any
			const definition = schema.properties.tools.items
			assert.equal(definition.properties.implementation.type, "string")
			assert.equal(definition.properties.smoke_args.type, "string", "strict schemas cannot represent a freeform JSON object")
			assert.ok(definition.required.includes("implementation"))
			assert.ok(definition.required.includes("smoke_args"))
			assert.equal(definition.properties.requirements, undefined)
			assert.ok(!definition.required.includes("requirements"))
			assert.equal(definition.additionalProperties, false)
		})
	}
})
