import type { ToolMetadata } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { SettingsItemType, SettingsTab } from "../types"
import { createSettingsItems, createSettingsSearchResults, createToolItems, type UseSettingsItemsProps } from "./useSettingsItems"

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getGlobalSettingsKey: () => undefined }) },
}))

const tool = (id: string, source: ToolMetadata["source"]): ToolMetadata => ({
	id,
	name: `${source} tool`,
	description: `${source} tool description`,
	source,
	modulePath: `/${source}/${id}.ts`,
})

const props = {
	currentTab: SettingsTab.TOOLS,
	features: { webTools: true },
	availableTools: [tool("builtin-tool", "builtin"), tool("global-tool", "global"), tool("task-tool", "task")],
	toolToggles: { "global-tool": true, "task-tool": false },
} as unknown as UseSettingsItemsProps

describe("CLI tool settings presentation", () => {
	it("shows effective defaults and keeps task tools read-only and enabled", () => {
		const items = createToolItems(props)
		const builtin = items.find((item) => item.key === "builtin-tool")
		const global = items.find((item) => item.key === "global-tool")
		const task = items.find((item) => item.key === "task-tool")

		expect(builtin).toMatchObject({ type: SettingsItemType.CHECKBOX, value: true })
		expect(global).toMatchObject({ type: SettingsItemType.CHECKBOX, value: true })
		expect(task).toMatchObject({ type: SettingsItemType.READONLY, value: "Enabled" })
		expect(task?.description).toContain("Task-scoped tools are always enabled")
	})

	it("indexes tool descriptions, source help, and persistence scope for search", () => {
		const results = createSettingsSearchResults(props, [SettingsTab.TOOLS])
		const global = results.find((result) => result.item.key === "global-tool")

		expect(global?.searchText).toContain("global tool description")
		expect(global?.searchText).toContain("global configuration")
		expect(global?.searchText).toContain("saved to global settings")
	})

	it("indexes legacy setting aliases for search", () => {
		const results = createSettingsSearchResults(props, [SettingsTab.RESPONSES_CONTEXT])
		const autoCondense = results.find((result) => result.item.key === "autoCondense")

		expect(autoCondense?.searchText).toContain("auto compact")
		expect(autoCondense?.searchText).toContain("auto-compact")
	})
})

describe("CLI Unbiased account presentation", () => {
	const modelProps = {
		...props,
		currentTab: SettingsTab.MODELS_API,
		provider: "unbiased",
		actModelId: "pareto",
		planModelId: "pareto",
		separateModels: false,
		actReasoningEffort: "medium",
		planReasoningEffort: "medium",
		openAiHeaders: {},
		openRouterPinnedProviders: {},
	} as UseSettingsItemsProps

	it("shows only sign-in when no credentials exist", () => {
		const items = createSettingsItems({ ...modelProps, unbiasedIsAuthenticated: false })
		expect(items.find((item) => item.key === "unbiasedSignIn")).toMatchObject({ type: SettingsItemType.ACTION })
		expect(items.some((item) => item.key === "unbiasedAccount" || item.key === "unbiasedSignOut")).toBe(false)
	})

	it.each([undefined, "Dirac workload"])("replaces sign-in with the saved account and sign-out for %s", (workloadName) => {
		const items = createSettingsItems({
			...modelProps,
			unbiasedIsAuthenticated: true,
			unbiasedWorkloadName: workloadName,
		})
		expect(items.find((item) => item.key === "unbiasedAccount")).toMatchObject({
			type: SettingsItemType.READONLY,
			value: workloadName || "Unbiased",
		})
		expect(items.find((item) => item.key === "unbiasedSignOut")).toMatchObject({ type: SettingsItemType.ACTION })
		expect(items.some((item) => item.key === "unbiasedSignIn")).toBe(false)
	})
})
