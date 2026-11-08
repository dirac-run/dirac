import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { subagents_spec } from "@core/task/tools/modules/subagents/SubagentsTool"
import { DiracToolSet } from "../registry/DiracToolSet"
import type { SystemPromptContext } from "../types"

const context: SystemPromptContext = {
	ide: "test",
	subagentsEnabled: true,
	providerInfo: { providerId: "anthropic", model: { id: "test", info: { supportsPromptCache: false } }, mode: "act" },
}

function assignmentSchema(ctx: SystemPromptContext) {
	const specs = DiracToolSet.withSubagentRoleSpecs([subagents_spec], ctx)
	assert.deepEqual(specs.map((spec) => spec.name), ["subagents"])
	assert.deepEqual(specs[0].parameters?.map((parameter) => parameter.name), ["assignments"])
	return specs[0].parameters![0].items
}

describe("Subagent role discovery", () => {
	it("exposes one strict three-field batch schema and default without a role catalog", () => {
		const schema = assignmentSchema(context)
		assert.deepEqual(Object.keys(schema.properties), ["type", "task_header", "task_description"])
		assert.deepEqual(schema.required, ["type", "task_header", "task_description"])
		assert.equal(schema.additionalProperties, false)
		assert.deepEqual(schema.properties.type.enum, ["default"])
	})

	it("refreshes names and descriptions without changing registered specs or creating role tools", () => {
		const first = assignmentSchema({ ...context, subagentRoles: [{ name: "Reviewer", description: "Reviews code." }] })
		const next = assignmentSchema({ ...context, subagentRoles: [{ name: "Scout", description: "Examines code." }] })
		assert.deepEqual(first.properties.type.enum, ["default", "Reviewer"])
		assert.match(first.properties.type.description, /Reviewer: Reviews code\./)
		assert.deepEqual(next.properties.type.enum, ["default", "Scout"])
		assert.deepEqual(subagents_spec.parameters![0].items.properties.type.enum, ["default"])
		assert.doesNotMatch(JSON.stringify(next), /Reviewer|modelSelection|apiKey|reasoningEffort/)
	})

	it("converts the same role contract for Anthropic and strict OpenAI", () => {
		for (const providerId of ["anthropic", "openai"]) {
			const ctx = { ...context, providerInfo: { ...context.providerInfo, providerId } }
			const specs = DiracToolSet.withSubagentRoleSpecs([subagents_spec], ctx)
			const native = DiracToolSet.convertSpecsToNativeTools(specs, ctx)
			assert.equal(native.length, 1)
			assert.match(JSON.stringify(native), /task_header/)
			assert.doesNotMatch(JSON.stringify(native), /use_utility_model|include_history|timeout|task_title/)
		}
	})
})
