import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "mocha"
import { ToolRegistry } from "../../registry/ToolRegistry"
import type { DiscoveredTool } from "../DiscoveredTool"
import type { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"

function makeTool(overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
	const id = overrides.id ?? "test_tool"
	const name = overrides.name ?? id
	return {
		id,
		name,
		source: overrides.source ?? "builtin",
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
					return undefined
				},
			})),
		modulePath: overrides.modulePath ?? `modules/${id}/tool.ts`,
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
			registry.registerBuiltin(makeTool({ id: "say", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "say", source: "global", modulePath: "user" }))
			assert.strictEqual(registry.getAllTools().length, 1)
			assert.strictEqual(registry.getAllTools()[0].source, "builtin")
		})

		it("rejects user tools that collide with built-in names", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "builtin_id", name: "say", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "user_id", name: "say", source: "global" }))
			assert.strictEqual(registry.getToolsBySource("global").length, 0)
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

	describe("createEnabledToolsForSubagent", () => {
		it("returns only tools in the allowed list", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerBuiltin(makeTool({ id: "b", source: "builtin" }))
			registry.registerBuiltin(makeTool({ id: "c", source: "builtin" }))
			const tools = registry.createEnabledToolsForSubagent({} as any, ["a", "c"])
			assert.strictEqual(tools.length, 2)
		})

		it("matches allowed user tools by id or name", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_id", name: "user_name", source: "workspace" }))
			registry.enable("user_id")
			const tools = registry.createEnabledToolsForSubagent({} as any, ["user_name"])
			assert.strictEqual(tools.length, 1)
		})

		it("filters out disabled tools even if in allowed list", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerBuiltin(makeTool({ id: "a", source: "builtin" }))
			registry.registerUserTool(makeTool({ id: "b", source: "global" }))
			const tools = registry.createEnabledToolsForSubagent({} as any, ["a", "b"])
			assert.strictEqual(tools.length, 1)
		})

		it("matches a runtime tool call by name when allowlisted by id", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_id", name: "user_name", source: "workspace" }))
			registry.enable("user_id")
			assert.strictEqual(registry.isToolAllowed("user_name", ["user_id"]), true)
		})

		it("rejects a disabled runtime tool call even when allowlisted", () => {
			const registry = ToolRegistry.getInstance()
			registry.registerUserTool(makeTool({ id: "user_id", name: "user_name", source: "workspace" }))
			assert.strictEqual(registry.isToolAllowed("user_name", ["user_id"]), false)
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
	})
})
