import { strict as assert } from "node:assert"
import * as fs from "fs/promises"
import { describe, it } from "mocha"
import { BUILTIN_SKILLS, getSkillContent } from "../skills"

async function getEmbeddedInstructions(): Promise<string> {
	const content = await getSkillContent("delete-tool", BUILTIN_SKILLS)
	assert.ok(content)
	return content.instructions
}

async function getCanonicalInstructions(): Promise<string> {
	return fs.readFile("src/core/prompts/skills/delete-tool/SKILL.md", "utf8")
}

describe("delete-tool skill template", () => {
	for (const [label, loadInstructions] of [
		["embedded", getEmbeddedInstructions],
		["canonical", getCanonicalInstructions],
	] as const) {
		it(`${label} template describes tool deletion workflow`, async () => {
			const instructions = await loadInstructions()

			assert.match(instructions, /dirac-tool\.json/)
			assert.match(instructions, /~\/\.dirac\/tools/)
			assert.match(instructions, /<workspace>\/\.dirac\/tools/)
			assert.match(instructions, /list_files/)
			assert.match(instructions, /read_file/)
			assert.match(instructions, /ask_followup_question/)
			assert.match(instructions, /execute_command/)
			assert.match(instructions, /rm -rf/)
			assert.match(instructions, /cache\/tools/)
			assert.match(instructions, /built-in tools are protected/)
			assert.match(instructions, /Confirm.*Deletion|confirm the deletion/i)
			assert.doesNotMatch(instructions, /\.diracrules\/tools/)
			assert.doesNotMatch(instructions, /@core\//)
			assert.doesNotMatch(instructions, /@\/shared\/tools/)
		})
	}
})
