import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { DEFAULT_SUBAGENT_ROLES, validateSubagentRoles } from "../subagentRoles"
import { Settings, UpdateSettingsRequest } from "../proto/dirac/state"
import { convertProtoToSubagentRoles, convertSubagentRolesToProto } from "../proto-conversions/subagent-roles"

const reviewer = {
	name: "Reviewer", description: "Review code.", enabled: true,
	modelSelection: { provider: "openai" as const, modelId: "custom-model", openAiProfileName: "Company server" }
}

describe("user-global subagent roles", () => {
	it("provides five disabled starters without execution defaults", () => {
		assert.deepEqual(DEFAULT_SUBAGENT_ROLES.map((role) => role.name), ["Scout", "Reviewer", "Simple coder", "Complex coder", "Verifier"])
		assert.ok(DEFAULT_SUBAGENT_ROLES.every((role) => !role.enabled && role.modelSelection === undefined))
		assert.deepEqual(validateSubagentRoles(DEFAULT_SUBAGENT_ROLES), DEFAULT_SUBAGENT_ROLES)
	})

	it("preserves custom roles, named endpoints and explicit empty catalogs", () => {
		assert.deepEqual(validateSubagentRoles([reviewer]), [reviewer])
		assert.deepEqual(validateSubagentRoles([]), [])
	})

	it("rejects ambiguous names, incomplete enabled roles and unsupported fields", () => {
		for (const roles of [
			[{ ...reviewer, name: "default" }],
			[reviewer, { ...reviewer, name: " reviewer " }],
			[{ ...reviewer, modelSelection: undefined }],
			[{ ...reviewer, description: "" }],
			[{ ...reviewer, systemPrompt: "Replace runtime instructions" }],
			[{ ...reviewer, modelSelection: { ...reviewer.modelSelection, apiKey: "secret" } }],
			[{ ...reviewer, modelSelection: { provider: "unknown", modelId: "model" } }],
			[{ ...reviewer, modelSelection: { provider: "openai", modelId: "" } }],
		]) assert.throws(() => validateSubagentRoles(roles))
	})

	it("round-trips role selections and distinguishes clearing from omission", () => {
		const roles = convertSubagentRolesToProto([reviewer])
		const decoded = Settings.decode(Settings.encode(Settings.create({ subagentRoles: roles })).finish())
		assert.deepEqual(convertProtoToSubagentRoles(decoded.subagentRoles!), [reviewer])
		const cleared = UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(UpdateSettingsRequest.create({
			subagentRoles: { roles: [] },
		})).finish())
		assert.deepEqual(convertProtoToSubagentRoles(cleared.subagentRoles!), [])
		assert.equal(UpdateSettingsRequest.decode(new Uint8Array()).subagentRoles, undefined)
	})
})
