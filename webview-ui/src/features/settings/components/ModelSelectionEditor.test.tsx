import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelInfo } from "@shared/api"
import { supportsCustomModelId } from "@shared/customModelIds"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelSelectionEditor } from "./ModelSelectionEditor"
import { normalizeApiConfiguration } from "./utils/providerUtils"

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
beforeAll(() => Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})

vi.mock("./common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({
		label,
		models,
		onChange,
		allowCustomModelId,
	}: {
		label: string
		models: Record<string, ModelInfo>
		onChange: (id: string, info?: ModelInfo) => void
		allowCustomModelId: boolean
	}) => (
		<input
			aria-label={label}
			data-models={Object.keys(models).join(",")}
			onChange={(event) => {
				const id = event.target.value
				if (allowCustomModelId || Object.hasOwn(models, id)) onChange(id, models[id])
			}}
		/>
	),
}))
vi.mock("@/shared/api/grpc-client", () => ({
	ModelsServiceClient: {
		refreshOpenAiModels: vi.fn().mockResolvedValue({ values: [] }),
		refreshUnbiasedModelsRpc: vi
			.fn()
			.mockResolvedValue({ models: { "pareto-versioned": { supportsPromptCache: false, name: "Versioned Pareto", reasoningEffortOptions: [], tiers: [] } } }),
		getAihubmixModels: vi
			.fn()
			.mockResolvedValue({ models: { "discovered-model": { supportsPromptCache: false, contextWindow: 12345 } } }),
	},
}))

describe("controlled model selections", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useSettingsStore.setState({
			apiConfiguration: {},
			pendingApiConfigurationUpdates: {},
			configuredApiProviders: ["anthropic", "together", "dify", "openai"],
			openAiModels: {},
		})
	})

	it("lists configured providers only and does not persist an incomplete provider draft", () => {
		const save = vi.fn()
		render(<ModelSelectionEditor label="Utility" onChange={save} allowCustomModelId={supportsCustomModelId} />)
		fireEvent.keyDown(screen.getByLabelText("Utility provider"), { key: "ArrowDown" })
		expect(screen.queryByRole("option", { name: "Gemini" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("option", { name: "Together" }))
		expect(save).not.toHaveBeenCalled()
		fireEvent.change(screen.getByLabelText("Utility model"), { target: { value: "gpt-private-unknown" } })
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "together", modelId: "gpt-private-unknown", modelInfo: undefined }),
		)
		expect(screen.queryByText("Reasoning Effort")).not.toBeInTheDocument()
	})

	it("rejects arbitrary direct-provider IDs", () => {
		const save = vi.fn()
		render(
			<ModelSelectionEditor
				label="Plan"
				selection={{ provider: "anthropic", modelId: "" }}
				onChange={save}
				allowCustomModelId={supportsCustomModelId}
			/>,
		)
		fireEvent.change(screen.getByLabelText("Plan model"), { target: { value: "made-up-model" } })
		expect(save).not.toHaveBeenCalled()
	})

	it("offers Dify's fixed workflow model", () => {
		const save = vi.fn()
		render(
			<ModelSelectionEditor
				label="Utility"
				selection={{ provider: "dify", modelId: "" }}
				onChange={save}
				allowCustomModelId={supportsCustomModelId}
			/>,
		)
		fireEvent.change(screen.getByLabelText("Utility model"), { target: { value: "dify-workflow" } })
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider: "dify", modelId: "dify-workflow" }))
	})

	it("reports incomplete provider drafts instead of retaining the old selection's validity", () => {
		const valid = vi.fn()
		const save = vi.fn()
		render(
			<ModelSelectionEditor
				label="Role"
				selection={{ provider: "anthropic", modelId: "old-model" }}
				onChange={save}
				onValidityChange={valid}
				allowCustomModelId={supportsCustomModelId}
			/>,
		)
		expect(valid).toHaveBeenLastCalledWith(true)
		fireEvent.keyDown(screen.getByLabelText("Role provider"), { key: "ArrowDown" })
		fireEvent.click(screen.getByRole("option", { name: "Together" }))
		expect(valid).toHaveBeenLastCalledWith(false)
		expect(save).not.toHaveBeenCalled()
		fireEvent.change(screen.getByLabelText("Role model"), { target: { value: "new-model" } })
		expect(valid).toHaveBeenLastCalledWith(true)
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider: "together", modelId: "new-model" }))
	})

	it.each([
		{ provider: "unbiased" as const, modelId: "pareto-versioned", info: { name: "Versioned Pareto" } },
		{ provider: "aihubmix" as const, modelId: "discovered-model", info: { contextWindow: 12345 } },
	])("loads $provider discovered model metadata", async ({ provider, modelId, info }) => {
		useSettingsStore.setState({ apiConfiguration: { unbiasedApiKey: "key" }, configuredApiProviders: [provider] })
		const save = vi.fn()
		render(
			<ModelSelectionEditor
				label="Utility"
				selection={{ provider, modelId: "" }}
				onChange={save}
				allowCustomModelId={supportsCustomModelId}
			/>,
		)
		await waitFor(() => expect(screen.getByLabelText("Utility model").getAttribute("data-models")).toContain(modelId))
		fireEvent.change(screen.getByLabelText("Utility model"), { target: { value: modelId } })
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelId, modelInfo: expect.objectContaining(info) }))
	})

	it.each([
		{ openAiBaseUrl: "https://a.example/v1" },
		{ openAiApiKey: "key-only" },
	])("keeps saved legacy OpenAI access available alongside named endpoints: %j", (legacy) => {
		useSettingsStore.setState({
			apiConfiguration: {
				...legacy,
				openAiCompatibleProfiles: [{ name: "B", baseUrl: "https://b.example/v1", modelId: "" }],
			},
		})
		render(<ModelSelectionEditor label="Utility" onChange={vi.fn()} allowCustomModelId={supportsCustomModelId} />)
		fireEvent.keyDown(screen.getByLabelText("Utility provider"), { key: "ArrowDown" })
		expect(screen.getByRole("option", { name: "OpenAI Compatible" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "B", exact: true })).toBeInTheDocument()
	})

	it("preserves released Together IDs and named-profile model fallback", () => {
		const together = normalizeApiConfiguration(
			{ actModeApiProvider: "together", actModeTogetherModelId: "private/model" },
			"act",
		)
		expect(together.selectedModelId).toBe("private/model")
		expect(together.selectedModelInfo.supportsReasoning).not.toBe(true)
		const openai = normalizeApiConfiguration(
			{
				actModeApiProvider: "openai",
				actModeOpenAiProfileName: "Local",
				openAiCompatibleProfiles: [
					{
						name: "Local",
						baseUrl: "http://localhost/v1",
						modelId: "legacy-id",
						modelInfo: { supportsPromptCache: false },
					},
				],
			},
			"act",
		)
		expect(openai.selectedModelId).toBe("legacy-id")
		expect(openai.selectedModelInfo).toEqual({ supportsPromptCache: false })
	})
	it("does not apply a profile model's reasoning metadata to another explicit model", () => {
		const selection = normalizeApiConfiguration(
			{
				actModeApiProvider: "openai",
				actModeOpenAiProfileName: "Local",
				actModeOpenAiModelId: "model-b",
				openAiCompatibleProfiles: [
					{
						name: "Local",
						baseUrl: "http://localhost/v1",
						modelId: "model-a",
						modelInfo: { supportsPromptCache: false, supportsReasoningEffort: true },
					},
				],
			},
			"act",
		)
		expect(selection.selectedModelId).toBe("model-b")
		expect(selection.selectedModelInfo.supportsReasoningEffort).not.toBe(true)
	})
})
