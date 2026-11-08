// biome-ignore lint/correctness/noUnusedImports: Vitest uses the classic JSX runtime.
import React from "react"
import { Text, type Key } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelInfo, ModelProviderSelection } from "@shared/api"
import type { SubagentRole } from "@shared/subagentRoles"
import type { StateManager } from "@/core/storage/StateManager"
import { RoleSettingsEditor } from "./RoleSettingsEditor"
import { configuredModelChoices, ModelSelectionEditor } from "./ModelSelectionEditor"
import { saveRoleSettings } from "./roleSettingsBinding"
import { ApiProvidersPage } from "./ApiProvidersPage"

const mocks = vi.hoisted(() => ({
	list: undefined as { items: { id: string; label: string }[]; onSelect: (item: { id: string; label: string }) => void } | undefined,
	picker: undefined as { baseUrl?: string; apiKey?: string; headers?: Record<string, string>; onSelectModel: (id: string, info?: ModelInfo) => void } | undefined,
	input: undefined as ((text: string, key: Key) => void) | undefined,
	global: vi.fn(), secret: vi.fn(), write: vi.fn(), flush: vi.fn(),
}))
vi.mock("ink", async (original) => ({ ...(await original<typeof import("ink")>()), useInput: (callback: typeof mocks.input) => { mocks.input = callback } }))
vi.mock("../SearchableList", () => ({ SearchableList: (props: NonNullable<typeof mocks.list>) => { mocks.list = props; return <Text>{props.items.map((item) => item.label).join("\n")}</Text> } }))
vi.mock("../ModelPicker", () => ({ CUSTOM_MODEL_ID: "__custom__", ModelPicker: (props: NonNullable<typeof mocks.picker>) => { mocks.picker = props; return <Text>Pick model</Text> } }))
vi.mock("./subpages/SetupPages", () => ({ BedrockCustomFlowPage: () => null }))
vi.mock("@/core/storage/providerMembership", () => ({ getProviderMembershipState: () => ({ configuredApiProviders: ["openai"] }) }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => ({ getSystemDefaultSettingsKey: mocks.global, getSecretKey: mocks.secret }) } }))

const profile = { name: "Local B", baseUrl: "http://localhost:8080/v1", modelId: "", modelInfo: { supportsPromptCache: false } }
const views: ReturnType<typeof render>[] = []
async function select(id: string) {
	// Let Ink commit the previous input before invoking the next rendered callback.
	await new Promise((resolve) => setTimeout(resolve, 60))
	await vi.waitFor(() => expect(mocks.list?.items.some((item) => item.id === id)).toBe(true))
	mocks.list!.onSelect(mocks.list!.items.find((item) => item.id === id)!)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.secret.mockReturnValue(undefined)
	mocks.list = undefined
	mocks.picker = undefined
	mocks.global.mockImplementation((key: string) => key === "openAiCompatibleProfiles" ? [profile] : key === "openAiBaseUrl" ? "http://legacy-a/v1" : undefined)
	mocks.flush.mockResolvedValue(undefined)
})
afterEach(() => { for (const view of views.splice(0)) view.unmount() })

describe("CLI role editor", () => {
	it.each(["openAiApiKey", "openAiCompatibleCustomApiKey"])("defers unnamed endpoint discovery to backend resolution with %s", async (credentialKey) => {
		mocks.secret.mockImplementation((key: string) => key === credentialKey ? "saved-key" : undefined)
		mocks.global.mockImplementation((key: string) => key === "openAiCompatibleProfiles" ? [profile] : undefined)
		const view = render(<ModelSelectionEditor onSave={vi.fn()} onCancel={vi.fn()} />)
		views.push(view)
		await select("openai")
		await vi.waitFor(() => expect(mocks.picker).toBeDefined())
		expect(mocks.picker).toMatchObject({ baseUrl: undefined, apiKey: undefined, headers: undefined })
	})
	it("passes authenticated named endpoint setup as an isolated discovery request", async () => {
		const named = { ...profile, apiKey: "named-key", headers: { "X-Endpoint": "named" } }
		mocks.global.mockImplementation((key: string) => key === "openAiCompatibleProfiles" ? [named] : "http://legacy/v1")
		mocks.secret.mockReturnValue("legacy-key")
		const view = render(<ModelSelectionEditor onSave={vi.fn()} onCancel={vi.fn()} />)
		views.push(view)
		await select(`endpoint:${named.name}`)
		await vi.waitFor(() => expect(mocks.picker).toBeDefined())
		expect(mocks.picker).toMatchObject({ baseUrl: named.baseUrl, apiKey: named.apiKey, headers: named.headers })
	})
	it("keeps custom-key-only legacy access editable beside named endpoints", async () => {
		mocks.global.mockImplementation((key: string) => key === "openAiCompatibleProfiles" ? [profile] : undefined)
		mocks.secret.mockImplementation((key: string) => key === "openAiCompatibleCustomApiKey" ? "custom-key" : undefined)
		const editLegacy = vi.fn()
		const view = render(<ApiProvidersPage isActive onProvider={vi.fn()} onEndpoint={vi.fn()} onLegacyEndpoint={editLegacy} onCancel={vi.fn()} actions={[]} onAction={vi.fn()} />)
		views.push(view)
		await select("legacy-openai")
		expect(editLegacy).toHaveBeenCalledOnce()
	})
	it("retains key-only legacy access alongside named profiles", async () => {
		mocks.global.mockImplementation((key: string) => key === "openAiCompatibleProfiles" ? [profile] : undefined)
		mocks.secret.mockReturnValue("legacy-key")
		expect(configuredModelChoices(["openai"], [profile], undefined, true)[0]).toMatchObject({ id: "openai", label: "Saved endpoint · Default URL" })
		const editLegacy = vi.fn()
		const view = render(<ApiProvidersPage isActive onProvider={vi.fn()} onEndpoint={vi.fn()} onLegacyEndpoint={editLegacy} onCancel={vi.fn()} actions={[]} onAction={vi.fn()} />)
		views.push(view)
		expect(view.lastFrame()).toContain("Default URL · API key saved")
		await select("legacy-openai")
		expect(editLegacy).toHaveBeenCalledOnce()
	})
	it("keeps saved endpoint setup visible and repairable beside named endpoints", async () => {
		const editLegacy = vi.fn()
		const view = render(<ApiProvidersPage isActive onProvider={vi.fn()} onEndpoint={vi.fn()} onLegacyEndpoint={editLegacy} onCancel={vi.fn()} actions={[]} onAction={vi.fn()} />)
		views.push(view)
		expect(view.lastFrame()).toContain("Saved endpoint · http://legacy-a/v1")
		expect(view.lastFrame()).toContain("Local B")
		await select("legacy-openai")
		expect(editLegacy).toHaveBeenCalledOnce()
	})
	it("adds a disabled role without requiring model configuration", async () => {
		const save = vi.fn().mockResolvedValue(undefined)
		const view = render(<RoleSettingsEditor onSave={save} onCancel={vi.fn()} />)
		views.push(view)
		await select("name")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Name: ▏"))
		mocks.input!("Custom", {} as Key)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Name: Custom▏"))
		mocks.input!("", { return: true } as Key)
		await select("description")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Description: ▏"))
		mocks.input!("Review changes.", {} as Key)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Description: Review changes.▏"))
		mocks.input!("", { return: true } as Key)
		await select("save")
		await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ name: "Custom", description: "Review changes.", enabled: false }))
		expect(view.lastFrame()).not.toContain("Remove role")
	})
	it("keeps legacy endpoint A selectable after named keyless endpoint B is added", () => {
		expect(configuredModelChoices(["openai"], [profile], "http://legacy-a/v1")).toEqual([
			{ id: "openai", label: "Saved endpoint · http://legacy-a/v1", provider: "openai" },
			{ id: "endpoint:Local B", label: "Local B", provider: "openai", openAiProfileName: "Local B" },
		])
	})
	it("selects a keyless named endpoint, enables a role and saves only the future global catalog", async () => {
		const role: SubagentRole = { name: "Reviewer", description: "Review code.", enabled: false }
		const state = { getSystemDefaultSettingsKey: () => [role], setGlobalState: mocks.write, flushPendingState: mocks.flush } as unknown as StateManager
		const task = { applyWorkingConfigurationUpdate: vi.fn() }
		const controller = { postStateToWebview: vi.fn(), task }
		const save = vi.fn(async (draft: SubagentRole) => { await saveRoleSettings(state, [draft], controller) })
		const view = render(<RoleSettingsEditor role={role} onSave={save} onCancel={vi.fn()} />)
		views.push(view)
		await select("model")
		await select("endpoint:Local B")
		await vi.waitFor(() => expect(mocks.picker).toBeDefined())
		expect(mocks.picker).toMatchObject({ baseUrl: profile.baseUrl, apiKey: "", headers: {} })
		mocks.picker!.onSelectModel("custom/local-model", { supportsPromptCache: false, supportsReasoningEffort: true, reasoningEffortOptions: ["low", "high"] })
		await select("effort:high")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Reasoning: high ✓"))
		await select("save")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Model: Local B · custom/local-model"))
		expect(mocks.write).not.toHaveBeenCalled()
		await select("enabled")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Enabled: Yes"))
		await select("save")
		await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
		expect(mocks.write).toHaveBeenCalledExactlyOnceWith("subagentRoles", [{ ...role, enabled: true, modelSelection: expect.objectContaining({ provider: "openai", openAiProfileName: "Local B", modelId: "custom/local-model", reasoningEffort: "high" }) }])
		expect(task.applyWorkingConfigurationUpdate).not.toHaveBeenCalled()
		expect(role).toEqual({ name: "Reviewer", description: "Review code.", enabled: false })
	})
	it("edits name and description, disables and removes without changing the saved selection", async () => {
		const modelSelection: ModelProviderSelection = { provider: "openai", openAiProfileName: "Local B", modelId: "custom", thinkingBudgetTokens: 0 }
		const role = { name: "Reviewer", description: "Review code.", enabled: true, modelSelection }
		const save = vi.fn().mockResolvedValue(undefined)
		const remove = vi.fn().mockResolvedValue(undefined)
		const view = render(<RoleSettingsEditor role={role} onSave={save} onRemove={remove} onCancel={vi.fn()} />)
		views.push(view)
		await select("name")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Name: Reviewer▏"))
		mocks.input!(" 2", {} as Key)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Name: Reviewer 2▏"))
		mocks.input!("", { return: true } as Key)
		await select("description")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Description: Review code.▏"))
		mocks.input!(" Carefully.", {} as Key)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Carefully.▏"))
		mocks.input!("", { return: true } as Key)
		await select("enabled")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Enabled: No"))
		await select("save")
		await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ ...role, name: "Reviewer 2", description: "Review code. Carefully.", enabled: false }))
		await select("remove")
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
	})
	it("surfaces a failed save while retaining the draft", async () => {
		const view = render(<RoleSettingsEditor role={{ name: "Scout", description: "Examine code.", enabled: false }} onSave={vi.fn().mockRejectedValue(new Error("disk failure"))} onCancel={vi.fn()} />)
		views.push(view)
		await select("save")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("disk failure"))
		expect(view.lastFrame()).toContain("Name: Scout")
	})
})
