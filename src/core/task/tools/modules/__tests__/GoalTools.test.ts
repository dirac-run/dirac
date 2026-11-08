import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { GOAL_TOOL_NAMES, isToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import { ToolDiscoveryService } from "../../discovery/ToolDiscoveryService"
import type { IGoalTrait, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { BlockGoalTool } from "../block_goal/BlockGoalTool"
import { UpdateGoalTool } from "../update_goal/UpdateGoalTool"

function goalEnvironment() {
	const calls: Array<{ method: string; input: string }> = []
	const goal = {
		async replaceObjective(markdown: string) {
			calls.push({ method: "replaceObjective", input: markdown })
			return { markdown, revision: 2, updatedAt: 2 }
		},
		async blockGoal(reason: string) {
			calls.push({ method: "blockGoal", input: reason })
		},
	} as IGoalTrait
	const environment = new Proxy({ goal } as IToolEnvironment, {
		get(target, property, receiver) {
			if (property !== "goal") throw new Error(`Goal tool read unexpected environment property '${String(property)}'.`)
			return Reflect.get(target, property, receiver)
		},
	})
	return { environment, calls }
}

describe("Goal-specific tools", () => {
	it("keeps objective and lifecycle work on the Goal trait", async () => {
		const { environment, calls } = goalEnvironment()
		assert.equal(JSON.parse(await new UpdateGoalTool().processCall({ objective_markdown: "# Revised" }, environment)).revision, 2)
		assert.match(await new BlockGoalTool().processCall({ reason: "Needs credentials" }, environment), /Needs credentials/)
		assert.deepEqual(calls, [
			{ method: "replaceObjective", input: "# Revised" },
			{ method: "blockGoal", input: "Needs credentials" },
		])
	})

	it("rejects missing or blank required text before calling the Goal trait", async () => {
		const { environment, calls } = goalEnvironment()
		for (const input of [{}, { objective_markdown: " " }]) {
			await assert.rejects(new UpdateGoalTool().processCall(input, environment), /non-empty string/)
		}
		for (const input of [{}, { reason: " " }]) {
			await assert.rejects(new BlockGoalTool().processCall(input, environment), /non-empty string/)
		}
		assert.deepEqual(calls, [])
	})

	it("preserves Goal terminal guard failures", async () => {
		const { environment } = goalEnvironment()
		environment.goal!.blockGoal = async () => { throw new Error("Active tasklets: fixture") }
		await assert.rejects(new BlockGoalTool().processCall({ reason: "Blocked" }, environment), /Active tasklets: fixture/)
	})

	it("treats a missing Goal trait as a root construction error", async () => {
		await assert.rejects(new UpdateGoalTool().processCall({ objective_markdown: "# Revised" }, {} as IToolEnvironment), /Goal coordinator environment/)
		await assert.rejects(new BlockGoalTool().processCall({ reason: "Blocked" }, {} as IToolEnvironment), /Goal coordinator environment/)
	})

	it("discovers only retained Goal operations for coordinators and follow-ups, never workers", () => {
		const allTools = ToolDiscoveryService.scanBuiltinTools()
		for (const name of ["verify_goal", "start_task", "list_tasks", "send_task_message", "cancel_task", "read_task_transcript", "resolve_task_interaction", "wait_for_goal_events"]) {
			assert.equal(allTools.some((tool) => tool.name === name), false, name)
		}
		const tools = allTools.filter((tool) => (GOAL_TOOL_NAMES as readonly string[]).includes(tool.name))
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [...GOAL_TOOL_NAMES].sort())
		for (const tool of tools) {
			assert.deepEqual(tool.exposure, { kind: "profile_only", profiles: ["goal_coordinator", "goal_followup"] })
			assert.equal(isToolAvailableToTaskProfile("goal_coordinator", tool.name), true)
			assert.equal(isToolAvailableToTaskProfile("goal_followup", tool.name), true)
			assert.equal(isToolAvailableToTaskProfile("standalone", tool.name), false)
			assert.equal(isToolAvailableToTaskProfile("tasklet", tool.name), false)
		}

		ToolRegistry.resetInstance()
		const registry = ToolRegistry.getInstance()
		for (const tool of tools) registry.registerBuiltin(tool)
		assert.deepEqual(registry.getConfigurableTools(), [])
		assert.equal(registry.getEnabledTools().length, GOAL_TOOL_NAMES.length)
		assert.throws(() => registry.disable(tools[0].id), /\(profile_only\) cannot be enabled or disabled directly/)
		ToolRegistry.resetInstance()
	})
})
