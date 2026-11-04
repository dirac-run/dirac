import { strict as assert } from "node:assert"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { describe, it } from "mocha"
import {
	isDiscoveredToolAvailableToTaskProfile,
	isSkillAvailableToTaskProfile,
	isToolAvailableToTaskProfile,
	type TaskExecutionProfile,
	taskProfileSystemInstructions,
} from "./TaskExecutionProfile"
import type { DiscoveredTool } from "./tools/discovery/DiscoveredTool"

function profileTool(profiles: readonly TaskExecutionProfile[]): DiscoveredTool {
	const spec = { id: "profile_tool" as DiracDefaultTool, name: "profile_tool", description: "Profile tool" } as DiracToolSpec
	return {
		id: "profile_tool",
		name: "profile_tool",
		source: "builtin",
		exposure: { kind: "profile_only", profiles },
		spec,
		factory: () => ({ spec: () => spec, supportedSurfaces: () => ["all"], processCall: async () => "ok" }),
		modulePath: "modules/profile_tool/tool.ts",
	}
}

describe("Task execution profiles", () => {

	it("makes Goal tools available to coordinator and follow-up turns", () => {
		assert.equal(isToolAvailableToTaskProfile("standalone", "start_task"), false)
		assert.equal(isToolAvailableToTaskProfile("goal_coordinator", "start_task"), true)
		assert.equal(isToolAvailableToTaskProfile("goal_followup", "start_task"), true)
		assert.equal(isToolAvailableToTaskProfile("goal_child", "start_task"), false)
	})

	it("restricts the subagent dispatcher to standalone Tasks", () => {
		for (const profile of ["standalone", "goal_coordinator", "goal_followup", "goal_child", "tasklet"] as const) {
			assert.equal(isToolAvailableToTaskProfile(profile, "use_subagents"), profile === "standalone")
			assert.equal(isToolAvailableToTaskProfile(profile, "read_file"), true)
		}
	})

	it("enforces declared profile-only exposure independently of tool naming", () => {
		const tool = profileTool(["goal_child"])
		assert.equal(isDiscoveredToolAvailableToTaskProfile("standalone", tool), false)
		assert.equal(isDiscoveredToolAvailableToTaskProfile("goal_coordinator", tool), false)
		assert.equal(isDiscoveredToolAvailableToTaskProfile("goal_child", tool), true)
	})

	it("keeps tasklets private without imposing Goal or Act-only semantics", () => {
		const instructions = taskProfileSystemInstructions("tasklet") ?? ""
		assert.match(instructions, /private worker for a parent agent/)
		assert.match(instructions, /delivered privately to the parent/)
		assert.match(instructions, /current Plan or Act mode/)
		assert.match(instructions, /cannot delegate/)
		assert.doesNotMatch(instructions, /Goal|always work in Act|always uses Act/)
		assert.equal(isToolAvailableToTaskProfile("tasklet", "start_task"), false)
	})

	it("keeps foreground-only skills root-owned while retaining ordinary worker skills", () => {
		for (const profile of ["standalone", "goal_coordinator", "goal_followup", "goal_child", "tasklet"] as const) {
			const skill = { name: "fixture", description: "Fixture", path: "/fixture/SKILL.md", source: "builtin" as const }
			assert.equal(isSkillAvailableToTaskProfile(profile, skill), true)
			assert.equal(
				isSkillAvailableToTaskProfile(profile, { ...skill, foregroundOnly: true }),
				profile !== "goal_child" && profile !== "tasklet",
			)
		}
	})

	it("asks contained Goal Tasks for concise private trajectory updates", () => {
		const instructions = taskProfileSystemInstructions("goal_child")

		assert.match(instructions ?? "", /Keep the parent meaningfully informed during non-trivial work/)
		assert.match(instructions ?? "", /substantive finding or milestone/)
		assert.match(instructions ?? "", /not routine tool narration or a timed cadence/)
		assert.match(instructions ?? "", /normally one sentence, sometimes two, and only rarely three/)
	})

	it("asks the Goal coordinator to synthesize concise user-visible progress", () => {
		const instructions = taskProfileSystemInstructions("goal_coordinator")

		assert.match(instructions ?? "", /user opening it during the run can quickly understand/)
		assert.match(instructions ?? "", /Most should remain private; synthesize only information/)
		assert.match(instructions ?? "", /Do not mechanically forward child messages or narrate routine tool activity/)
		assert.match(instructions ?? "", /normally one sentence, sometimes two, and only rarely three/)
	})

	it("keeps follow-up completion separate from durable Goal lifecycle", () => {
		const instructions = taskProfileSystemInstructions("goal_followup")

		assert.match(instructions ?? "", /durable Goal lifecycle status is authoritative/)
		assert.match(instructions ?? "", /respond with complete finishes only this follow-up turn/)
		assert.match(instructions ?? "", /block_goal ends only this follow-up turn/)
		assert.match(instructions ?? "", /explicitly resume paused, blocked, or stopped Goal pursuit/)
		assert.match(instructions ?? "", /An achieved Goal cannot be resumed/)
	})

	it("does not add Goal progress guidance to standalone Tasks", () => {
		assert.equal(taskProfileSystemInstructions("standalone"), undefined)
	})
})
