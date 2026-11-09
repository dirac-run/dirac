import { strict as assert } from "node:assert"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { describe, it } from "mocha"
import {
	GOAL_TOOL_NAMES,
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

const profiles = ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const

describe("Task execution profiles", () => {
	it("keeps the two Goal operations exclusive to coordinator and follow-up roots", () => {
		assert.deepEqual(GOAL_TOOL_NAMES, ["update_goal", "block_goal"])
		for (const profile of profiles) {
			for (const toolName of GOAL_TOOL_NAMES) {
				assert.equal(isToolAvailableToTaskProfile(profile, toolName), profile === "goal_coordinator" || profile === "goal_followup")
			}
		}
	})

	it("permits shared delegation and supervision for every root, never for tasklets", () => {
		for (const profile of profiles) {
			assert.equal(isToolAvailableToTaskProfile(profile, "subagents"), profile !== "tasklet")
			assert.equal(isToolAvailableToTaskProfile(profile, "tasklets"), false)
			assert.equal(isToolAvailableToTaskProfile(profile, "read_file"), true)
		}
	})

	it("enforces declared profile-only exposure independently of tool naming", () => {
		const tool = profileTool(["tasklet"])
		assert.equal(isDiscoveredToolAvailableToTaskProfile("standalone", tool), false)
		assert.equal(isDiscoveredToolAvailableToTaskProfile("goal_coordinator", tool), false)
		assert.equal(isDiscoveredToolAvailableToTaskProfile("tasklet", tool), true)
	})

	it("keeps tasklets private in Act mode without Goal authority", () => {
		const instructions = taskProfileSystemInstructions("tasklet") ?? ""
		assert.match(instructions, /private worker for a parent agent/)
		assert.match(instructions, /delivered privately to the parent/)
		assert.match(instructions, /always execute in Act mode/)
		assert.match(instructions, /cannot delegate/)
		assert.doesNotMatch(instructions, /GOAL COORDINATOR/)
		assert.equal(isToolAvailableToTaskProfile("tasklet", "update_goal"), false)
	})

	it("keeps foreground-only skills root-owned while retaining ordinary worker skills", () => {
		for (const profile of profiles) {
			const skill = { name: "fixture", description: "Fixture", path: "/fixture/SKILL.md", source: "builtin" as const }
			assert.equal(isSkillAvailableToTaskProfile(profile, skill), true)
			assert.equal(isSkillAvailableToTaskProfile(profile, { ...skill, foregroundOnly: true }), profile !== "tasklet")
		}
	})

	for (const profile of ["goal_coordinator", "goal_followup"] as const) {
		it(`gives ${profile} shared tasklet controls rather than legacy Goal supervision`, () => {
			const instructions = taskProfileSystemInstructions(profile) ?? ""
			assert.match(instructions, /subagents.*inspect/)
			assert.match(instructions, /under your current authority/)
			assert.match(instructions, /interrupt or resume/)
			assert.match(instructions, /sleep when no useful work remains/)
			assert.doesNotMatch(instructions, /start_task|list_tasks|wait_for_goal_events|CONTAINED GOAL TASK/)
		})
	}

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
		assert.match(instructions ?? "", /Both require all tasklets to be terminal/)
	})

	it("does not add Goal progress guidance to standalone Tasks", () => {
		assert.equal(taskProfileSystemInstructions("standalone"), undefined)
	})
})
