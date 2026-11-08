import { describe, expect, it, vi } from "vitest"
import type { StateManager } from "@/core/storage/StateManager"
import { DEFAULT_SUBAGENT_ROLES, type SubagentRole } from "@shared/subagentRoles"
import { saveRoleSettings } from "./roleSettingsBinding"

function fixture(previous: SubagentRole[] = DEFAULT_SUBAGENT_ROLES) {
	const state = {
		getSystemDefaultSettingsKey: vi.fn(() => previous),
		setGlobalState: vi.fn(),
		flushPendingState: vi.fn().mockResolvedValue(undefined),
	}
	const controller = { postStateToWebview: vi.fn().mockResolvedValue(undefined), task: { applyWorkingConfigurationUpdate: vi.fn() } }
	return { state, controller, save: (roles: SubagentRole[]) => saveRoleSettings(state as unknown as StateManager, roles, controller) }
}

describe("CLI global role settings", () => {
	it("saves disabled unconfigured presets without installing Task handlers", async () => {
		const { state, controller, save } = fixture()
		await save(DEFAULT_SUBAGENT_ROLES)
		expect(state.getSystemDefaultSettingsKey).toHaveBeenCalledWith("subagentRoles")
		expect(state.setGlobalState).toHaveBeenCalledExactlyOnceWith("subagentRoles", DEFAULT_SUBAGENT_ROLES)
		expect(controller.task.applyWorkingConfigurationUpdate).not.toHaveBeenCalled()
		expect(controller.postStateToWebview).toHaveBeenCalledOnce()
	})
	it("adds and edits a named endpoint role with reasoning, including explicit off", async () => {
		const { state, save } = fixture()
		const role: SubagentRole = { name: " Custom ", description: " Review changes. ", enabled: true,
			modelSelection: { provider: "openai", modelId: "my-model", openAiProfileName: "Work", reasoningEffort: "high", thinkingBudgetTokens: 0 } }
		const saved = await save([...DEFAULT_SUBAGENT_ROLES, role])
		expect(saved.at(-1)).toEqual({ ...role, name: "Custom", description: "Review changes." })
		await save(saved.map((entry) => entry.name === "Custom" ? { ...entry, name: "Renamed", enabled: false } : entry))
		expect(state.setGlobalState.mock.lastCall?.[1]).toContainEqual({ ...saved.at(-1), name: "Renamed", enabled: false })
	})
	it("removes the last role without reintroducing defaults", async () => {
		const { state, save } = fixture()
		await save([])
		expect(state.setGlobalState).toHaveBeenCalledExactlyOnceWith("subagentRoles", [])
	})
	it.each([
		[{ name: "default", description: "Not editable.", enabled: false }],
		[{ name: "Custom", description: "Needs settings.", enabled: true }],
		[{ name: "Custom", description: "Two\nlines", enabled: false }],
		[{ name: "Scout", description: "First.", enabled: false }, { name: "scout", description: "Duplicate.", enabled: false }],
	])("rejects invalid catalogs before persistence: %j", async (...roles) => {
		const { state, save } = fixture()
		await expect(save(roles as SubagentRole[])).rejects.toThrow()
		expect(state.setGlobalState).not.toHaveBeenCalled()
	})
	it("restores global roles and does not publish when persistence fails", async () => {
		const { state, controller, save } = fixture()
		state.flushPendingState.mockRejectedValueOnce(new Error("disk failure"))
		await expect(save([])).rejects.toThrow("disk failure")
		expect(state.setGlobalState).toHaveBeenNthCalledWith(2, "subagentRoles", DEFAULT_SUBAGENT_ROLES)
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
		expect(controller.task.applyWorkingConfigurationUpdate).not.toHaveBeenCalled()
	})
})
