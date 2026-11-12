import { openAiModelInfoSaneDefaults, openAiNativeDefaultModelId } from "@shared/api"
import { DEFAULT_SUBAGENT_ROLES } from "@shared/subagentRoles"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { SettingsListView } from "../SettingsListView"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { ProviderToBaseUrlKeyMap } from "@shared/storage/provider-keys"
import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import {
	getCustomModelLabel,
	getModelList,
	hasDynamicModels,
	hasModelPicker,
	hasStaticModels,
} from "../../../utils/model-metadata"
import { ModelPicker } from "../../ModelPicker"
import { SettingsItemType, SettingsTab } from "../types"
import { createSettingsItems, createSettingsSearchResults, createToolItems, type UseSettingsItemsProps } from "./useSettingsItems"

const { getOpenAiModelsMock, logOpenAiModelsErrorMock } = vi.hoisted(() => ({
	getOpenAiModelsMock: vi.fn(),
	logOpenAiModelsErrorMock: vi.fn(
		() => "Configured OpenAI-compatible provider does not support model discovery at /models.",
	),
}))

vi.mock("@/core/controller/models/refreshOpenAiModels", () => ({
	getOpenAiModels: getOpenAiModelsMock,
	logOpenAiModelsError: logOpenAiModelsErrorMock,
}))

vi.mock("../../../context/StdinContext", () => ({
	useStdinContext: () => ({ isRawModeSupported: true }),
}))

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

	it("does not expose removed completion checking in settings or search", () => {
		const items = createSettingsItems({ ...props, currentTab: SettingsTab.RUNNING_TASKS })
		const results = createSettingsSearchResults(props, [SettingsTab.RUNNING_TASKS])

		expect(items.some((item) => item.key === "doubleCheckCompletion")).toBe(false)
		expect(results.some((result) => result.searchText.includes("double-check-completion"))).toBe(false)
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

	it("enables dynamic model picker for openai with no static fallback models while keeping openai-native static-only", () => {
		expect(hasDynamicModels("openai")).toBe(true)
		expect(hasModelPicker("openai")).toBe(true)
		expect(getCustomModelLabel("openai")).toBe("Custom Model ID / Preset")
		expect(getModelList("openai")).toEqual([])

		expect(hasDynamicModels("openai-native")).toBe(false)
		expect(hasStaticModels("openai-native")).toBe(true)
		expect(hasModelPicker("openai-native")).toBe(true)
		expect(ProviderToBaseUrlKeyMap["openai-native"]).toBeUndefined()
		expect(ProviderToBaseUrlKeyMap.openai).toBe("openAiBaseUrl")
	})

	it("moves model selections to Model configurations without duplicate provider-page controls", () => {
		const providerItems = createSettingsItems(openAiSettingsProps)
		expect(providerItems.some((item) => item.key === "actModelId" || item.key === "actSelection")).toBe(false)
		const items = createSettingsItems({ ...openAiSettingsProps, currentTab: SettingsTab.UTILITY_MODEL, utilityModelUseCases: { condense: true, generateCommitMessage: true, permissionHandling: false }, utilityPermissionPolicy: "" })
		expect(items.find((item) => item.key === "actSelection")?.value).toBe("qwen2.5-coder:32b")
		expect(items.some((item) => item.key === "planSelection")).toBe(true)
		expect(items.some((item) => item.key === "utilityModelSelection")).toBe(true)
	})

	it("renders discovered models and Custom Model ID / Preset in ModelPicker for openai", async () => {
		getOpenAiModelsMock.mockResolvedValue({
			"qwen2.5-coder:32b": openAiModelInfoSaneDefaults,
			"llama3.3:70b": openAiModelInfoSaneDefaults,
		})

		const { lastFrame, unmount } = render(
			React.createElement(ModelPicker, {
				provider: "openai",
				baseUrl: "http://localhost:11434/v1",
				apiKey: "test-key",
				onChange: () => { },
				onSubmit: () => { },
			}),
		)

		await vi.waitFor(() => {
			const frame = lastFrame() || ""
			expect(frame).toContain("qwen2.5-coder:32b")
			expect(frame).toContain("llama3.3:70b")
			expect(frame).toContain("Custom Model ID / Preset")
		})
		expect(getOpenAiModelsMock).toHaveBeenCalledWith({
			controller: undefined,
			baseUrl: "http://localhost:11434/v1",
			apiKey: "test-key",
		})
		unmount()
	})

	it("renders classified error map message and only Custom Model ID / Preset when /models returns 404", async () => {
		getOpenAiModelsMock.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } })

		const { lastFrame, unmount } = render(
			React.createElement(ModelPicker, {
				provider: "openai",
				baseUrl: "http://localhost:11434/v1",
				onChange: () => { },
				onSubmit: () => { },
			}),
		)

		await vi.waitFor(() => {
			const frame = (lastFrame() || "").replace(/\s+/g, " ")
			expect(frame).toContain(
				"Configured OpenAI-compatible provider does not support model discovery at /models. Select Custom Model ID / Preset below.",
			)
			expect(frame).not.toContain(openAiNativeDefaultModelId)
			expect(frame).toContain("Custom Model ID / Preset")
		})
		unmount()
	})
})
describe("CLI subagent roles section", () => {
	it("keeps model purposes and custom and starter role descriptions visible off selection", () => {
		const roles = [...DEFAULT_SUBAGENT_ROLES, { name: "Custom", description: "Inspect database migrations before they are applied.", enabled: false }]
		const items = createSettingsItems({
			...props, currentTab: SettingsTab.UTILITY_MODEL,
			utilityModelUseCases: { condense: false, generateCommitMessage: false, permissionHandling: false },
			utilityPermissionPolicy: "", subagentRoles: roles,
		})
		for (const [key, description] of [
			["planSelection", SETTINGS_HELP.planModel], ["actSelection", SETTINGS_HELP.actModel],
			["utilityModelSelection", SETTINGS_HELP.utilityModel],
			...roles.map((role, index) => [`subagentRole:${index}`, role.description]),
		]) {
			const item = items.find((item) => item.key === key)!
			expect(item).toMatchObject({ description, alwaysShowDescription: true })
			expect(item.persistentHelp).toBeUndefined()
			expect(item.helpTone ?? "muted").toBe("muted")
		}
		expect(items.find((item) => item.key === "subagentRolesExplanation")?.value).toBe(SETTINGS_HELP.subagentRoles)
		const view = render(React.createElement(SettingsListView, { items, selectedIndex: items.length - 1, maxRows: 200 }))
		const frame = view.lastFrame()!.replace(/\s+/g, " ")
		for (const description of [SETTINGS_HELP.planModel, SETTINGS_HELP.actModel, SETTINGS_HELP.utilityModel, ...roles.map((role) => role.description)]) {
			expect(frame).toContain(description)
		}
		view.unmount()
	})
	it("shows disabled starters and one default explanation without an editable default row", () => {
		const items = createSettingsItems({
			...props, currentTab: SettingsTab.UTILITY_MODEL,
			utilityModelUseCases: { condense: false, generateCommitMessage: false, permissionHandling: false },
			utilityPermissionPolicy: "", subagentRoles: DEFAULT_SUBAGENT_ROLES
		})
		const roles = items.filter((item) => item.key.startsWith("subagentRole:"))
		expect(roles.map((item) => item.label)).toEqual(DEFAULT_SUBAGENT_ROLES.map((role) => role.name))
		expect(roles.every((item) => item.value === "Disabled · Not configured")).toBe(true)
		expect(items.filter((item) => item.key === "subagentRolesExplanation")).toHaveLength(1)
		expect(items.some((item) => item.label.toLowerCase() === "default")).toBe(false)
		expect(items.find((item) => item.key === "addSubagentRole")?.type).toBe(SettingsItemType.ACTION)
	})
})
