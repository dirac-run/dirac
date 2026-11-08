import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bedrockDefaultModelId, type ApiConfiguration } from "@shared/api"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { MainModelSelection } from "./MainModelSelection"
import Fuse from "fuse.js"

const rpc = vi.hoisted(() => ({
	updateApiConfigurationPartial: vi.fn(),
	refreshOpenAiModels: vi.fn(),
	getLmStudioModels: vi.fn(),
}))
vi.mock("@/shared/api/grpc-client", () => ({ ModelsServiceClient: rpc }))
vi.mock("../../history/components/HistoryView/HistoryView", () => ({
	highlight: (results: { item: { id: string; html: string } }[]) => results.map(({ item }) => item),
}))

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
const originalResizeObserver = globalThis.ResizeObserver
beforeAll(() => { globalThis.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } } })
beforeAll(() => Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
	globalThis.ResizeObserver = originalResizeObserver
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})
afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function snapshot(patch: Partial<ApiConfiguration> = {}) {
	act(() => useSettingsStore.getState().setSettings({
		apiConfiguration: { ...structuredClone(useSettingsStore.getState().apiConfiguration), ...patch },
	}))
}

function chooseProvider(name: string) {
	fireEvent.keyDown(screen.getByLabelText("Plan provider"), { key: "ArrowDown" })
	fireEvent.click(screen.getByRole("option", { name, exact: true }))
}

beforeEach(() => {
	vi.clearAllMocks()
	rpc.updateApiConfigurationPartial.mockResolvedValue({})
	rpc.refreshOpenAiModels.mockResolvedValue({ values: ["endpoint-model"] })
	rpc.getLmStudioModels.mockResolvedValue({ values: [JSON.stringify({ id: "local-small", loaded_context_length: 8192, max_context_length: 32768 })] })
	useSettingsStore.setState({
		apiConfiguration: { planModeApiProvider: "together", planModeTogetherModelId: "original", actModeApiProvider: "together", actModeTogetherModelId: "act-original" },
		planActSeparateModelsSetting: true,
		configuredApiProviders: ["together", "openai", "bedrock", "lmstudio"],
		pendingApiConfigurationUpdates: {},
		apiConfigurationError: undefined,
	})
})

describe("main model settings interactions", () => {
	it("retains an unfinished provider and search across equivalent snapshots and other-row edits", async () => {
		render(<MainModelSelection mode="plan" label="Plan" />)
		chooseProvider("OpenAI Compatible")
		fireEvent.click(screen.getByRole("button", { name: "Plan model: Select a model" }))
		fireEvent.change(screen.getByRole("combobox", { name: "Search Plan model" }), { target: { value: "private/model" } })
		snapshot({ actModeTogetherModelId: "act-changed" })
		expect(screen.getByRole("combobox", { name: "Search Plan model" })).toHaveValue("private/model")
		expect(screen.getByLabelText("Plan provider")).toHaveTextContent("OpenAI Compatible")
		fireEvent.click(screen.getByRole("option", { name: "Use custom model: private/model" }))
		await waitFor(() => expect(rpc.updateApiConfigurationPartial).toHaveBeenCalled())
		expect(useSettingsStore.getState().apiConfiguration).toMatchObject({ planModeApiProvider: "openai", planModeOpenAiModelId: "private/model", actModeTogetherModelId: "act-changed" })
	})

	it("does replace an unfinished draft when the same row's saved model actually changes", () => {
		render(<MainModelSelection mode="plan" label="Plan" />)
		chooseProvider("OpenAI Compatible")
		snapshot({ planModeTogetherModelId: "externally-selected" })
		expect(screen.getByLabelText("Plan provider")).toHaveTextContent("Together")
		expect(screen.getByRole("button", { name: "Plan model: externally-selected" })).toBeInTheDocument()
	})

	it("preserves an unfinished Bedrock ARN across unrelated state snapshots", () => {
		useSettingsStore.setState({ apiConfiguration: { planModeApiProvider: "bedrock", planModeApiModelId: bedrockDefaultModelId } })
		render(<MainModelSelection mode="plan" label="Plan" />)
		fireEvent.click(screen.getByRole("button", { name: "Plan options" }))
		fireEvent.click(screen.getByRole("checkbox", { name: "Application inference profile ARN" }))
		const arn = screen.getByRole("textbox", { name: "Plan inference profile ARN" })
		fireEvent.change(arn, { target: { value: "arn:aws:bedrock:in-progress" } })
		snapshot({ actModeReasoningEffort: "high" })
		expect(arn).toHaveValue("arn:aws:bedrock:in-progress")
		expect(rpc.updateApiConfigurationPartial).not.toHaveBeenCalled()
	})

	it("persists discovered LM Studio loaded context with the model selection", async () => {
		render(<MainModelSelection mode="plan" label="Plan" />)
		chooseProvider("LM Studio")
		await waitFor(() => expect(rpc.getLmStudioModels).toHaveBeenCalled())
		fireEvent.click(screen.getByRole("button", { name: "Plan model: Select a model" }))
		fireEvent.click(await screen.findByRole("option", { name: "local-small" }))
		await waitFor(() => expect(rpc.updateApiConfigurationPartial).toHaveBeenCalled())
		expect(useSettingsStore.getState().apiConfiguration).toMatchObject({ planModeLmStudioModelId: "local-small", lmStudioMaxTokens: "8192" })
	})

	it("does not rebuild the autocomplete index for unrelated configuration snapshots", () => {
		const index = vi.spyOn(Fuse.prototype, "setCollection")
		render(<MainModelSelection mode="plan" label="Plan" />)
		expect(index).toHaveBeenCalled()
		index.mockClear()
		snapshot({ actModeReasoningEffort: "high" })
		act(() => useSettingsStore.setState({ utilityModelPermissionPolicy: "unrelated policy" }))
		expect(index).not.toHaveBeenCalled()
	})

	it("uses backend saved access and does not rediscover equivalent endpoint snapshots", async () => {
		useSettingsStore.setState({ apiConfiguration: { planModeApiProvider: "openai", planModeOpenAiModelId: "endpoint-model", openAiBaseUrl: "https://saved.example/v1", openAiApiKey: "legacy", openAiCompatibleCustomApiKey: "custom", openAiHeaders: { B: "2", A: "1" } } })
		render(<MainModelSelection mode="plan" label="Plan" />)
		await waitFor(() => expect(rpc.refreshOpenAiModels).toHaveBeenCalledTimes(1))
		expect(rpc.refreshOpenAiModels.mock.calls[0][0]).toMatchObject({ useSavedEndpoint: true, baseUrl: "", apiKey: "", headers: {} })
		snapshot({ openAiHeaders: { A: "1", B: "2" }, actModeReasoningEffort: "high" })
		expect(rpc.refreshOpenAiModels).toHaveBeenCalledTimes(1)
		snapshot({ openAiCompatibleCustomApiKey: "rotated" })
		await waitFor(() => expect(rpc.refreshOpenAiModels).toHaveBeenCalledTimes(2))
	})

	it("sends a named profile's coherent explicit access, never saved legacy credentials", async () => {
		useSettingsStore.setState({ apiConfiguration: { planModeApiProvider: "openai", planModeOpenAiModelId: "endpoint-model", planModeOpenAiProfileName: "Local", openAiBaseUrl: "https://saved.example/v1", openAiApiKey: "legacy", openAiCompatibleCustomApiKey: "custom", openAiHeaders: { Authorization: "secret" }, openAiCompatibleProfiles: [{ name: "Local", baseUrl: "http://localhost:1234/v1", modelId: "", headers: { "X-Endpoint": "local" } }] } })
		render(<MainModelSelection mode="plan" label="Plan" />)
		await waitFor(() => expect(rpc.refreshOpenAiModels).toHaveBeenCalledTimes(1))
		expect(rpc.refreshOpenAiModels.mock.calls[0][0]).toMatchObject({ useSavedEndpoint: false, baseUrl: "http://localhost:1234/v1", apiKey: "", headers: { "X-Endpoint": "local" } })
		snapshot()
		expect(rpc.refreshOpenAiModels).toHaveBeenCalledTimes(1)
	})
})
