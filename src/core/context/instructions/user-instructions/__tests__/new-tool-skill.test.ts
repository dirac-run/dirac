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
		it(`${label} template describes upsert_tool-based workflow`, async () => {
			const instructions = await loadInstructions()

			// References the upsert_tool for creating tools
			assert.match(instructions, /upsert_tool/)
			// Mentions all three scopes
			assert.match(instructions, /global/i)
			assert.match(instructions, /workspace/i)
			assert.match(instructions, /task/i)
			// Mentions the requirements parameter (subagent-based generation)
			assert.match(instructions, /requirements/)
			// Supports both user-guided and autonomous creation when requirements are clear
			assert.match(instructions, /request may come directly from the user/)
			assert.match(instructions, /requirements are clear, proceed without an interview/)
			// No deprecated patterns
			assert.doesNotMatch(instructions, /\.diracrules\/tools/)
			assert.doesNotMatch(instructions, /@core\//)
			assert.doesNotMatch(instructions, /@\/shared\/tools/)
			assert.doesNotMatch(instructions, /tool\.js\b/)
			// No manual validation steps — upsert_tool handles that
			assert.doesNotMatch(instructions, /schemaVersion === 1/)
			assert.doesNotMatch(instructions, /entry === "tool\.ts"/)
			assert.doesNotMatch(instructions, /createdBy === "dirac"/)
			// No TypeScript source generation in skill — upsert_tool generates code internally
			assert.doesNotMatch(instructions, /export const spec/)
			assert.doesNotMatch(instructions, /export function create/)
		})
	}
})
