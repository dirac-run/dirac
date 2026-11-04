import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { UseSkillTool } from "./UseSkillTool"

function createEnvironment(activeSkillIds: string[]) {
	const activateSkill = sinon.stub().resolves()
	const skill = {
		name: "example-skill",
		description: "Example instructions",
		path: "/skills/example-skill/SKILL.md",
		source: "project" as const,
		instructions: "Follow these important instructions.",
	}
	const env: any = {
		config: {},
		ui: {
			createCard: sinon.stub().resolves({ update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }),
		},
		skills: {
			getAvailableSkills: sinon.stub().resolves([skill]),
			getSkillContent: sinon.stub().resolves(skill),
			listSupportingFiles: sinon.stub().resolves({ docs: [], scripts: [] }),
		},
		orchestration: {
			getTaskState: sinon.stub().withArgs("activeSkillIds").returns(activeSkillIds),
			activateSkill,
		},
		telemetry: { captureCustomMetadata: sinon.stub() },
	}
	return { env, activateSkill }
}

describe("UseSkillTool", () => {
	it("reloads instructions without persisting duplicate activation for an active skill", async () => {
		const { env, activateSkill } = createEnvironment(["example-skill"])

		const result = await new UseSkillTool().processCall({ skill_name: "example-skill" }, env)

		assert.match(result, /already active; instructions reloaded/)
		assert.match(result, /Follow these important instructions\./)
		assert.equal(activateSkill.callCount, 0)
	})

	it("persists activation before returning instructions for an inactive skill", async () => {
		const { env, activateSkill } = createEnvironment([])

		const result = await new UseSkillTool().processCall({ skill_name: "example-skill" }, env)

		assert.match(result, /is now active/)
		assert.match(result, /Follow these important instructions\./)
		assert.equal(activateSkill.calledOnceWithExactly("example-skill"), true)
	})
})
