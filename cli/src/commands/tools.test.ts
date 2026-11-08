import type { DiscoveredTool } from "@/core/task/tools/discovery/DiscoveredTool"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { createToolConfiguration, formatToolConfiguration } from "./tools"

function tool(
	id: string,
	overrides: Partial<Pick<DiscoveredTool, "source" | "exposure">> = {},
): DiscoveredTool {
	return {
		id,
		name: id,
		source: overrides.source ?? "builtin",
		exposure: overrides.exposure ?? { kind: "configurable" },
		spec: { id: id as DiracDefaultTool, name: id, description: id } as DiracToolSpec,
		factory: () => ({}) as never,
		modulePath: `/${id}/tool.ts`,
	}
}

describe("createToolConfiguration", () => {
	it("groups configured standalone tool IDs by effective status", () => {
		const readFile = tool("read_file")
		const workspaceTool = tool("workspace_lint", { source: "workspace" })
		const globalTool = tool("global_search", { source: "global" })

		expect(createToolConfiguration([workspaceTool, readFile, globalTool], [readFile, globalTool])).toEqual({
			enabledToolIds: ["global_search", "read_file"],
			disabledToolIds: ["workspace_lint"],
		})
	})

	it("excludes task-scoped, skill-only, profile-only, and Goal tools", () => {
		const visible = tool("read_file")
		const taskTool = tool("task_tool", { source: "task" })
		const skillTool = tool("skill_tool", {
			exposure: { kind: "skill_only", authorizedSkillIds: ["skill"] },
		})
		const profileTool = tool("profile_tool", {
			exposure: { kind: "profile_only", profiles: ["goal_coordinator"] },
		})
		const goalTool = tool("update_goal")

		expect(
			createToolConfiguration(
				[visible, taskTool, skillTool, profileTool, goalTool],
				[visible, taskTool, profileTool, goalTool],
			),
		).toEqual({ enabledToolIds: ["read_file"], disabledToolIds: [] })
	})
})

describe("formatToolConfiguration", () => {
	it("formats copy-pasteable comma-separated CLI options", () => {
		expect(
			formatToolConfiguration({
				enabledToolIds: ["global_search", "read_file"],
				disabledToolIds: ["browser_action", "workspace_lint"],
			}),
		).toBe(
			[
				"Current config:",
				"",
				"--enable-tool global_search,read_file",
				"--disable-tool browser_action,workspace_lint",
			].join("\n"),
		)
	})
})
