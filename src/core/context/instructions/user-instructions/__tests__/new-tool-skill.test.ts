import { strict as assert } from "node:assert"
import * as fs from "fs/promises"
import { describe, it } from "mocha"
import { BUILTIN_SKILLS, getSkillContent } from "../skills"

async function getEmbeddedInstructions(): Promise<string> {
	const content = await getSkillContent("new-tool", BUILTIN_SKILLS)
	assert.ok(content)
	return content.instructions
}

async function getCanonicalInstructions(): Promise<string> {
	return fs.readFile("src/core/prompts/skills/new-tool/SKILL.md", "utf8")
}

describe("new-tool skill template", () => {
	for (const [label, loadInstructions] of [
		["embedded", getEmbeddedInstructions],
		["canonical", getCanonicalInstructions],
	] as const) {
		it(`${label} template describes manifest-backed alias-free tools`, async () => {
			const instructions = await loadInstructions()

			assert.match(instructions, /dirac-tool\.json/)
			assert.match(instructions, /<workspace>\/\.dirac\/tools/)
			assert.match(instructions, /createdBy/)
			assert.match(instructions, /"entry": "tool\.ts"/)
			assert.match(instructions, /schemaVersion === 1/)
			assert.match(instructions, /entry === "tool\.ts"/)
			assert.match(instructions, /createdBy === "dirac"/)
			assert.match(instructions, /manifest\.id === spec\.id/)
			assert.match(instructions, /manifest\.name === spec\.name/)
			assert.match(instructions, /real user-tool loader path/)
			assert.match(instructions, /Do not tell the user the tool is ready until validation passes/)
			assert.doesNotMatch(instructions, /\.diracrules\/tools/)
			assert.doesNotMatch(instructions, /@core\//)
			assert.doesNotMatch(instructions, /@\/shared\/tools/)
			assert.doesNotMatch(instructions, /tool\.js\b/)
		})
	}
})
