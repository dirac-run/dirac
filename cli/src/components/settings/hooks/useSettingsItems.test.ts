import { openAiNativeDefaultModelId } from "@shared/api"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { ProviderToBaseUrlKeyMap } from "@shared/storage/provider-keys"
import { describe, expect, it, vi } from "vitest"
import {
	getCustomModelLabel,
	getModelList,
	hasDynamicModels,
	hasModelPicker,
	hasStaticModels,
} from "../../../utils/model-metadata"
import { CUSTOM_MODEL_ID } from "../../ModelPicker"
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
		expect(global?.searchText).toContain("global dirac configuration")
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

describe("CLI Vim editing preference", () => {
	it.each([undefined, false, true])("presents the opt-in Terminal setting for %s", (vimModeEnabled) => {
		const items = createSettingsItems({ ...props, currentTab: SettingsTab.TERMINAL, vimModeEnabled })
		expect(items.find((item) => item.key === "vimModeEnabled")).toMatchObject({
			type: SettingsItemType.CHECKBOX, label: "Vim prompt editing", value: vimModeEnabled ?? false,
		})
	})

	it("indexes vi/vim, mode and bindings keywords", () => {
		const results = createSettingsSearchResults(props, [SettingsTab.TERMINAL])
		const setting = results.find((result) => result.item.key === "vimModeEnabled")
		for (const keyword of ["vi", "vim", "bindings", "normal", "insert"]) expect(setting?.searchText).toContain(keyword)
	})
})

describe("OpenAI-compatible model metadata and settings presentation", () => {
	const openAiSettingsProps = {
		...props,
		currentTab: SettingsTab.MODELS_API,
		provider: "openai",
		actModelId: "qwen2.5-coder:32b",
		planModelId: "qwen2.5-coder:32b",
		separateModels: false,
		actReasoningEffort: "medium",
		planReasoningEffort: "medium",
		openAiHeaders: {},
		openRouterPinnedProviders: {},
	} as UseSettingsItemsProps

	it("enables dynamic model picker for openai while keeping openai-native static-only", () => {
		expect(hasDynamicModels("openai")).toBe(true)
		expect(hasModelPicker("openai")).toBe(true)
		expect(getCustomModelLabel("openai")).toBe("Custom Model ID / Preset")
		expect(getModelList("openai")).toEqual([openAiNativeDefaultModelId])

		expect(hasDynamicModels("openai-native")).toBe(false)
		expect(hasStaticModels("openai-native")).toBe(true)
		expect(hasModelPicker("openai-native")).toBe(true)
		expect(ProviderToBaseUrlKeyMap["openai-native"]).toBeUndefined()
		expect(ProviderToBaseUrlKeyMap.openai).toBe("openAiBaseUrl")
	})

	it("displays discovered or arbitrary OpenAI-compatible model IDs directly instead of Custom", () => {
		const items = createSettingsItems(openAiSettingsProps)
		expect(items.find((item) => item.key === "actModelId")?.value).toBe("qwen2.5-coder:32b")
		expect(items.find((item) => item.key === "actCustomModelId")).toBeUndefined()

		const customItems = createSettingsItems({ ...openAiSettingsProps, actModelId: CUSTOM_MODEL_ID })
		expect(customItems.find((item) => item.key === "actModelId")?.value).toBe("Custom")
		expect(customItems.find((item) => item.key === "actCustomModelId")?.value).toBe("")
	})
})
