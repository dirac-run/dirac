import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "mocha"
import { ToolRegistry } from "../../registry/ToolRegistry"
import type { DiscoveredTool } from "../DiscoveredTool"
import { ToolDiscoveryService } from "../ToolDiscoveryService"
import type { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { LegacyResponseTool, RESPOND_TOOL_NAME } from "@shared/responseTool"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"

const legacyCompletionToolName = LegacyResponseTool.COMPLETE
const legacyProgressToolName = LegacyResponseTool.PROGRESS
const legacyResponseToolNames = Object.values(LegacyResponseTool)

function makeTool(overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
	const id = overrides.id ?? "test_tool"
	const name = overrides.name ?? id
	return {
		id,
		name,
		source: overrides.source ?? "builtin",
		exposure: overrides.exposure ?? { kind: "configurable" },
		spec:
			overrides.spec ??
			({
				id: id as DiracDefaultTool,
				name,
				description: `Test tool ${id}`,
			} as DiracToolSpec),
		factory:
			overrides.factory ??
			(() => ({
				spec() {
					return {} as DiracToolSpec
				},
				supportedSurfaces() {
					return ["all" as const]
				},
				async processCall() {
					return "ok"
				},
			})),
		modulePath: overrides.modulePath ?? `modules/${id}/tool.ts`,
		sourceHash: overrides.sourceHash,
		ownerTaskId: overrides.ownerTaskId,
	}
}

describe("ToolRegistry", () => {
	beforeEach(() => {
		ToolRegistry.resetInstance()
	})

	describe("getInstance", () => {
		it("returns a singleton", () => {
			const a = ToolRegistry.getInstance()
			const b = ToolRegistry.getInstance()
			assert.strictEqual(a, b)
		})
	})

	describe("resetInstance", () => {
		it("creates a fresh instance after reset", () => {
			const a = ToolRegistry.getInstance()
			ToolRegistry.resetInstance()
			const b = ToolRegistry.getInstance()
			assert.notStrictEqual(a, b)
		})
	})

	it("does not discover the retired replacement tool", () => {
		const toolNames = ToolDiscoveryService.scanBuiltinTools().map((tool) => tool.spec.name)
		assert.equal(toolNames.includes("new_task"), false)
		assert.ok(toolNames.includes("condense"))
		for (const name of ["start_task", "list_tasks", "send_task_message", "cancel_task", "read_task_transcript", "resolve_task_interaction", "wait_for_goal_events"]) {
			assert.equal(toolNames.includes(name), false, name)
		}
		for (const name of ["subagents", "update_goal", "block_goal"]) {
			assert.ok(toolNames.includes(name), name)
		}
	})

	describe("registration", () => {
		it("registers built-in and user tools separately", () => {
			const registry = ToolRegistry.getInstance()
			const builtin = makeTool({ id: "builtin_tool", source: "builtin" })
			const user = makeTool({ id: "user_tool", source: "global" })
			registry.registerBuiltin(builtin)
			registry.registerUserTool(user)
			assert.deepStrictEqual(registry.getAllTools(), [builtin, user])
		})

		it("replaces built-ins with the same id", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ modulePath: "old" }))
			registry.registerBuiltin(makeTool({ modulePath: "new" }))
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.getAllTools()[0].modulePath, "new")
		})

		it("rejects user tools that collide with built-in ids", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "collision", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "collision", source: "global", modulePath: "user" }))
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.getAllTools()[0].source, "builtin")
		})

		it("rejects user tools that collide with built-in names", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "builtin_id", name: "collision", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "user_id", name: "collision", source: "global" }))
			assert.strictEqual(registry.getToolsBySource("global").length, 0)
		})

		it("reserves legacy response aliases after their built-ins are removed", () => {
			const registry = ToolRegistry.getInstance()
			assert.equal(registry.registerUserTool(makeTool({ id: legacyCompletionToolName, source: "global" })), false)
		})

		it("lets workspace user tools override global user tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "foo", source: "global", modulePath: "global" }))
			registry.registerUserTool(makeTool({ id: "foo", source: "workspace", modulePath: "workspace" }))
			const tools = registry.getAllTools()
			assert.strictEqual(tools.length, 1)
			assert.strictEqual(tools[0].source, "workspace")
			assert.strictEqual(tools[0].modulePath, "workspace")
		})

		it("rejects same-source user duplicates", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "foo", source: "global", modulePath: "first" }))
			registry.registerUserTool(makeTool({ id: "foo", source: "global", modulePath: "second" }))
			const tools = registry.getAllTools()
			assert.strictEqual(tools.length, 1)
			assert.strictEqual(tools[0].modulePath, "first")
		})

		it("clearUserTools never removes built-ins", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "builtin", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "user", source: "global" }))
			registry.clearUserTools()
			assert.deepStrictEqual(
				registry.getAllTools().map((tool) => tool.id),
				["builtin"],
			)
		})
	})

	describe("isEnabled", () => {
		it("defaults to true for builtin tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ source: "builtin" }))
			assert.strictEqual(registry.isEnabled("test_tool"), true)
		})

		it("defaults to false for global user tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_tool", source: "global" }))
			assert.strictEqual(registry.isEnabled("user_tool"), false)
		})

		it("defaults to false for workspace user tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "ws_tool", source: "workspace" }))
			assert.strictEqual(registry.isEnabled("ws_tool"), false)
		})

		it("returns false for unknown tool ids", () => {
			const registry = ToolRegistry.getInstance()
			assert.strictEqual(registry.isEnabled("nonexistent"), false)
		})
	})

	describe("enable/disable", () => {
		it("enable overrides default state", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_tool", source: "global" }))
			assert.strictEqual(registry.isEnabled("user_tool"), false)
			registry.enable("user_tool")
			assert.strictEqual(registry.isEnabled("user_tool"), true)
		})

		it("disable overrides default state", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ source: "builtin" }))
			assert.strictEqual(registry.isEnabled("test_tool"), true)
			registry.disable("test_tool")
			assert.strictEqual(registry.isEnabled("test_tool"), false)
		})
	})

	describe("getEnabledTools", () => {
		it("returns only enabled tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "b", source: "global" }))
			registry.registerBuiltin(makeTool({ id: "c", source: "builtin" }))
			const enabled = registry.getEnabledTools()
			assert.strictEqual(enabled.length, 2)
			assert.ok(enabled.every((t) => t.source === "builtin"))
		})
	})

	describe("getEnabledSpecs", () => {
		it("returns specs for enabled tools respecting contextRequirements", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(
				makeTool({
					id: "a",
					spec: {
						id: "a" as DiracDefaultTool,
						name: "a",
						description: "a",
						contextRequirements: () => true,
					} as DiracToolSpec,
				}),
			)
			registry.registerBuiltin(
				makeTool({
					id: "b",
					spec: {
						id: "b" as DiracDefaultTool,
						name: "b",
						description: "b",
						contextRequirements: () => false,
					} as DiracToolSpec,
				}),
			)
			const specs = registry.getEnabledSpecs({} as any)
			assert.strictEqual(specs.length, 1)
			assert.strictEqual(specs[0].name, "a")
		})

		it("includes tools without contextRequirements", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a" }))
			const specs = registry.getEnabledSpecs({} as any)
			assert.strictEqual(specs.length, 1)
		})
	})

	describe("getToolsBySource", () => {
		it("filters tools by source", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "b", source: "global" }))
			registry.registerUserTool(makeTool({ id: "c", source: "workspace" }))
			assert.strictEqual(registry.getToolsBySource("builtin").length, 1)
			assert.strictEqual(registry.getToolsBySource("global").length, 1)
			assert.strictEqual(registry.getToolsBySource("workspace").length, 1)
		})
	})

	describe("createEnabledTools", () => {
		it("creates tool instances for enabled tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "b", source: "global" }))
			const tools = registry.createEnabledTools({} as any)
			assert.strictEqual(tools.length, 1)
		})
	})


	describe("replaceUserTool", () => {
		it("replaces a same-source tool and preserves its enabled state", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_tool", source: "workspace", modulePath: "old" }))
			registry.enable("user_tool")
			const version = registry.getVersion()

			assert.strictEqual(
				registry.replaceUserTool(makeTool({ id: "user_tool", source: "workspace", modulePath: "new" })),
				true,
			)
			assert.strictEqual(registry.getToolsBySource("workspace")[0].modulePath, "new")
			assert.strictEqual(registry.isEnabled("user_tool"), true)
			assert.strictEqual(registry.getVersion(), version + 1)
		})

		it("enables a new tool only when requested", () => {
			const registry = ToolRegistry.getInstance()
			assert.strictEqual(registry.replaceUserTool(makeTool({ id: "user_tool", source: "workspace" }), true), true)
			assert.strictEqual(registry.isEnabled("user_tool"), true)
		})

		it("rejects a lower-priority replacement without mutating the existing tool", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "user_tool", source: "workspace", modulePath: "workspace" })
			registry.registerUserTool(existing)
			registry.enable("user_tool")
			const version = registry.getVersion()

			assert.strictEqual(
				registry.replaceUserTool(makeTool({ id: "user_tool", source: "global", modulePath: "global" })),
				false,
			)
			assert.strictEqual(registry.getAllTools()[0], existing)
			assert.strictEqual(registry.isEnabled("user_tool"), true)
			assert.strictEqual(registry.getVersion(), version)
		})

		it("rejects a lower-priority replacement that collides by name and preserves the disabled tool", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "workspace_tool", name: "shared_name", source: "workspace" })
			registry.registerUserTool(existing)
			registry.disable(existing.id)
			const version = registry.getVersion()
			const toggles = registry.getToggles()

			assert.deepStrictEqual(
				registry.replaceUserToolWithResult(makeTool({ id: "global_tool", name: "shared_name", source: "global" }), true),
				{ replaced: false, enabledNewTool: false },
			)
			assert.strictEqual(registry.getAllTools()[0], existing)
			assert.strictEqual(registry.isEnabled(existing.id), false)
			assert.deepStrictEqual(registry.getToggles(), toggles)
			assert.strictEqual(registry.getVersion(), version)
			assert.deepStrictEqual(registry.getAllTools(undefined, "/other-workspace"), [])
		})

		it("lets a higher-priority replacement overlay a global tool without mutating it", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "user_tool", source: "global", modulePath: "global" })
			const replacement = makeTool({ id: "user_tool", source: "workspace", modulePath: "workspace" })
			registry.registerUserTool(existing)
			registry.enable(existing.id)
			const version = registry.getVersion()

			assert.strictEqual(registry.replaceUserTool(replacement), true)
			assert.strictEqual(registry.getAllTools()[0], replacement)
			assert.strictEqual(registry.isEnabled(existing.id), true)
			assert.strictEqual(registry.getVersion(), version + 1)
			assert.strictEqual(existing.modulePath, "global")
			assert.strictEqual(registry.getAllTools(undefined, "/other-workspace")[0], existing)
		})

		it("checks lower-priority replacements against the requested workspace, not the last active one", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "user_tool", source: "workspace" })
			registry.registerUserTool(existing, "/workspace-a")
			registry.reconcileWorkspaceUserTools([], false, "/workspace-b")
			const version = registry.getVersion()

			assert.strictEqual(
				registry.replaceUserTool(makeTool({ id: "user_tool", source: "global" }), true, "/workspace-a"),
				false,
			)
			assert.strictEqual(registry.getAllTools(undefined, "/workspace-a")[0], existing)
			assert.deepStrictEqual(registry.getAllTools(undefined, "/workspace-b"), [])
			assert.deepStrictEqual(registry.getToggles(), {})
			assert.strictEqual(registry.getVersion(), version)
		})

		it("allows a global replacement when the collision belongs only to another workspace", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "user_tool", source: "workspace" })
			const replacement = makeTool({ id: "user_tool", source: "global" })
			registry.registerUserTool(existing, "/workspace-a")

			assert.strictEqual(registry.replaceUserTool(replacement, true, "/workspace-b"), true)
			assert.strictEqual(registry.getAllTools(undefined, "/workspace-b")[0], replacement)
			assert.strictEqual(registry.getAllTools(undefined, "/workspace-a")[0], existing)
		})

		it("rejects a user tool that would shadow a built-in by name", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "read_file_builtin", name: "read_file", source: "builtin" }))

			assert.strictEqual(
				registry.replaceUserTool(makeTool({ id: "my_tool", name: "read_file", source: "workspace" }), true),
				false,
			)
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.getAllTools()[0].source, "builtin")
		})

		it("rejects a user tool that would shadow a built-in by id", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "execute_command", name: "execute_command", source: "builtin" }))

			assert.strictEqual(
				registry.replaceUserTool(makeTool({ id: "execute_command", name: "my_custom", source: "workspace" }), true),
				false,
			)
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.getAllTools()[0].source, "builtin")
		})
	})

	describe("removeUserTool", () => {
		it("removes a registered user tool and returns true", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_tool", source: "global" }))
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.removeUserTool("user_tool"), true)
			assert.strictEqual(registry.getAllTools().length, 0)
		})

		it("returns false when removing a non-existent tool", () => {
			const registry = ToolRegistry.getInstance()
			assert.strictEqual(registry.removeUserTool("nonexistent"), false)
		})

		it("returns false when trying to remove a builtin tool", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "builtin_tool", source: "builtin" }))
			assert.strictEqual(registry.removeUserTool("builtin_tool"), false)
			assert.strictEqual(registry.getAllTools().length, 1)
		})

		it("cleans up toggle overrides when removing a user tool", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_tool", source: "global" }))
			registry.enable("user_tool")
			assert.strictEqual(registry.isEnabled("user_tool"), true)
			registry.removeUserTool("user_tool")
			assert.strictEqual(registry.isEnabled("user_tool"), false)
		})
	})

	describe("loadToggles / getToggles", () => {
		it("loads toggles and reflects them in isEnabled", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "b", source: "global" }))
			registry.loadToggles({ a: false, b: true })
			assert.strictEqual(registry.isEnabled("a"), false)
			assert.strictEqual(registry.isEnabled("b"), true)
		})

		it("replaces existing toggle state", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.loadToggles({ a: false })
			assert.strictEqual(registry.isEnabled("a"), false)
			registry.loadToggles({})
			assert.strictEqual(registry.isEnabled("a"), true)
		})

		it("getToggles returns only overridden entries", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerBuiltin(makeTool({ id: "b", source: "builtin" }))
			registry.disable("a")
			const toggles = registry.getToggles()
			assert.deepStrictEqual(toggles, { a: false })
		})

		it("migrates legacy response toggles conservatively", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: RESPOND_TOOL_NAME, source: "builtin" }))

			registry.loadToggles({})
			assert.deepStrictEqual(registry.getToggles(), {})

			registry.loadToggles(Object.fromEntries(legacyResponseToolNames.map((name) => [name, true])))
			assert.deepStrictEqual(registry.getToggles(), { [RESPOND_TOOL_NAME]: true })

			registry.loadToggles(Object.fromEntries(legacyResponseToolNames.map((name) => [name, false])))
			assert.deepStrictEqual(registry.getToggles(), { [RESPOND_TOOL_NAME]: false })

			registry.loadToggles({ [legacyProgressToolName]: true, [legacyCompletionToolName]: false })
			assert.deepStrictEqual(registry.getToggles(), { [RESPOND_TOOL_NAME]: false })

			registry.loadToggles({ [RESPOND_TOOL_NAME]: true, [legacyCompletionToolName]: false })
			assert.deepStrictEqual(registry.getToggles(), { [RESPOND_TOOL_NAME]: true })
		})
	})

	describe("reconcileWorkspaceUserTools", () => {
		it("does not change the version for an unchanged disk inventory", () => {
			const registry = ToolRegistry.getInstance()
			const existing = makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" })
			registry.registerUserTool(existing)
			const version = registry.getVersion()

			const changed = registry.reconcileWorkspaceUserTools([
				makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" }),
			])

			assert.strictEqual(changed, false)
			assert.strictEqual(registry.getVersion(), version)
			assert.strictEqual(registry.getToolsBySource("workspace")[0], existing)
		})

		it("updates the version when a discovered tool source changes", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" }))
			const version = registry.getVersion()

			const changed = registry.reconcileWorkspaceUserTools([
				makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-2" }),
			])

			assert.strictEqual(changed, true)
			assert.strictEqual(registry.getVersion(), version + 1)
			assert.strictEqual(registry.getToolsBySource("workspace")[0].sourceHash, "hash-2")
		})

		it("removes stale disk tools while preserving task-scoped tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" }))
			registry.registerUserTool(
				makeTool({ id: "task_tool", source: "task", sourceHash: "task-hash", ownerTaskId: "owner-task" }),
			)

			registry.reconcileWorkspaceUserTools([])

			assert.deepStrictEqual(registry.getAllTools(), [])
			assert.deepStrictEqual(
				registry.getAllTools("owner-task").map((tool) => tool.id),
				["task_tool"],
			)
		})

		it("allows a manual reload to invalidate an unchanged inventory", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" }))
			const version = registry.getVersion()

			const changed = registry.reconcileWorkspaceUserTools(
				[makeTool({ id: "workspace_tool", source: "workspace", sourceHash: "hash-1" })],
				true,
			)

			assert.strictEqual(changed, true)
			assert.strictEqual(registry.getVersion(), version + 1)
		})
	})

	describe("profile-only subagents", () => {
		function registerSubagentTool(): ToolRegistry {
			const registry = ToolRegistry.getInstance()
			const tool = ToolDiscoveryService.scanBuiltinTools().find((tool) => tool.id === "subagents")
			assert.ok(tool)
			assert.deepStrictEqual(tool.exposure, { kind: "profile_only", profiles: ["standalone", "goal_coordinator", "goal_followup"] })
			registry.registerBuiltin(tool)
			return registry
		}

		it("omits the duplicate Tools setting and rejects direct toggles", () => {
			const registry = registerSubagentTool()
			assert.deepStrictEqual(registry.getConfigurableTools(), [])
			assert.throws(() => registry.enable("subagents"), /cannot be enabled or disabled directly/)
			assert.throws(() => registry.disable("subagents"), /cannot be enabled or disabled directly/)
			assert.throws(() => registry.toggleAndPersist("subagents", false), /cannot be enabled or disabled directly/)
		})

		for (const legacyToggle of [undefined, false, true]) {
			for (const subagentsEnabled of [false, true]) {
				it(`retains supervision with creation setting (${subagentsEnabled}) and legacy toggle ${legacyToggle}`, () => {
					const registry = registerSubagentTool()
					registry.registerBuiltin(makeTool({ id: "other_tool" }))
					registry.loadToggles({
						other_tool: false,
						...(legacyToggle === undefined ? {} : { subagents: legacyToggle }),
					})

					assert.deepStrictEqual(registry.getToggles(), { other_tool: false })
					assert.equal(registry.isEnabled("subagents"), true)
					assert.deepStrictEqual(registry.getEnabledTools().map((tool) => tool.id), ["subagents"])
					const context = { subagentsEnabled } as SystemPromptContext
					assert.deepStrictEqual(
						registry.getEnabledSpecs(context).map((spec) => spec.name),
						["subagents"],
					)
				})
			}
		}
	})

	describe("skill-only exposure", () => {
		const skillOnlyExposure = { kind: "skill_only" as const, authorizedSkillIds: ["new-tool"] }

		it("discovers upsert_tool as skill-only and authorized only for new-tool", () => {
			const upsertTool = ToolDiscoveryService.scanBuiltinTools().find((tool) => tool.id === "upsert_tool")
			assert.ok(upsertTool)
			assert.deepStrictEqual(upsertTool.exposure, skillOnlyExposure)
		})

		it("keeps skill-only tools registered but hidden from configurable and enabled inventories", () => {
			const registry = ToolRegistry.getInstance()
			const tool = makeTool({ id: "upsert_tool", exposure: skillOnlyExposure })
			registry.registerBuiltin(tool)

			assert.deepStrictEqual(registry.getAllTools(), [tool])
			assert.deepStrictEqual(registry.getConfigurableTools(), [])
			assert.deepStrictEqual(registry.getEnabledTools(), [])
			assert.strictEqual(registry.isEnabled("upsert_tool"), false)
		})

		it("ignores stale and crafted toggles for skill-only and unknown tools", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "upsert_tool", exposure: skillOnlyExposure }))
			registry.loadToggles({ upsert_tool: true, stale_tool: true })

			assert.deepStrictEqual(registry.getToggles(), {})
			assert.strictEqual(registry.isEnabled("upsert_tool"), false)
		})

		it("rejects direct enable, disable, and persisted toggle operations", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "upsert_tool", exposure: skillOnlyExposure }))

			assert.throws(() => registry.enable("upsert_tool"), /cannot be enabled or disabled directly/)
			assert.throws(() => registry.disable("upsert_tool"), /cannot be enabled or disabled directly/)
			assert.throws(() => registry.toggleAndPersist("upsert_tool", true), /cannot be enabled or disabled directly/)
		})

		it("resolves a dependency only for a trusted built-in skill with matching declarations", () => {
			const registry = ToolRegistry.getInstance()
			const tool = makeTool({ id: "upsert_tool", exposure: skillOnlyExposure })
			registry.registerBuiltin(tool)

			assert.deepStrictEqual(
				registry.resolveSkillDependencyTools([
					{
						name: "new-tool",
						description: "Create tools",
						path: "<builtin>/new-tool/SKILL.md",
						source: "builtin",
						toolDependencies: ["upsert_tool"],
					},
				]),
				[tool],
			)
			assert.deepStrictEqual(
				registry.resolveSkillDependencyTools([
					{
						name: "new-tool",
						description: "Untrusted shadow",
						path: "/tmp/new-tool/SKILL.md",
						source: "project",
						toolDependencies: ["upsert_tool"],
					},
				]),
				[],
			)
		})

		it("rejects missing, non-skill-only, and unauthorized built-in dependencies", () => {
			const registry = ToolRegistry.getInstance()
			const builtinSkill = (toolId: string, name = "new-tool") => ({
				name,
				description: "Built-in skill",
				path: `<builtin>/${name}/SKILL.md`,
				source: "builtin" as const,
				toolDependencies: [toolId],
			})

			assert.throws(() => registry.resolveSkillDependencyTools([builtinSkill("missing")]), /depends on missing tool/)
			registry.registerBuiltin(makeTool({ id: "ordinary_tool" }))
			assert.throws(
				() => registry.resolveSkillDependencyTools([builtinSkill("ordinary_tool")]),
				/declares non-skill-only dependency/,
			)
			registry.registerBuiltin(makeTool({ id: "upsert_tool", exposure: skillOnlyExposure }))
			assert.throws(
				() => registry.resolveSkillDependencyTools([builtinSkill("upsert_tool", "other-skill")]),
				/not authorized/,
			)
		})
	})
})
