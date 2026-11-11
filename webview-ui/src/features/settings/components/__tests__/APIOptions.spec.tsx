import { ApiConfiguration } from "@shared/api"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
beforeAll(() => Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})

const { handleFieldsChange, handleModeFieldChange } = vi.hoisted(() => ({
	handleFieldsChange: vi.fn(),
	handleModeFieldChange: vi.fn(),
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange, handleModeFieldChange }),
}))

vi.mock("../providers/OpenRouterProvider", () => ({
	OpenRouterProvider: ({
		isPendingProviderSelection,
		onCancelProviderSelection,
		onModelSelected,
	}: {
		isPendingProviderSelection?: boolean
		onCancelProviderSelection?: () => void
		onModelSelected?: (modelId: string, modelInfo: { supportsPromptCache: boolean }) => Promise<boolean>
	}) =>
		isPendingProviderSelection ? (
			<div>
				<button onClick={onCancelProviderSelection} type="button">
					Cancel OpenRouter selection
				</button>
				<button onClick={() => void onModelSelected?.("anthropic/test", { supportsPromptCache: false })} type="button">
					Choose OpenRouter model
				</button>
			</div>
		) : null,
}))

import ApiOptions from "../ApiOptions"
vi.mock("../ModelDescriptionMarkdown", () => ({
	ModelDescriptionMarkdown: () => null,
}))

const mockExtensionState = (apiConfiguration: Partial<ApiConfiguration>) => {
	useSettingsStore.setState({
		apiConfiguration,
		requestyModels: {},
		configuredApiProviders: [],
		apiConfigurationError: undefined,
		remoteConfigSettings: {},
		planActSeparateModelsSetting: false,
	} as any)
}

describe("ApiOptions Component", () => {
	vi.clearAllMocks()
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		handleFieldsChange.mockResolvedValue(true)
		handleModeFieldChange.mockResolvedValue(true)
		mockExtensionState({
			planModeApiProvider: "requesty",
			actModeApiProvider: "requesty",
		})
	})

	it("renders Requesty API Key input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const apiKeyInput = screen.getByPlaceholderText("Enter API Key...")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders Requesty Model ID input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const modelIdInput = screen.getByPlaceholderText("Search and select a model...")
		expect(modelIdInput).toBeInTheDocument()
	})
})


describe("OpenRouter provider selection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		handleFieldsChange.mockResolvedValue(true)
		handleModeFieldChange.mockResolvedValue(true)
		mockExtensionState({
			planModeApiProvider: "requesty",
			actModeApiProvider: "requesty",
		})
	})

	it("browses setup without activation and adds a keyless provider only explicitly", async () => {
		render(<ApiOptions currentMode="plan" intent="setup" showModelOptions={true} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		expect(handleFieldsChange).not.toHaveBeenCalled()
		expect(useSettingsStore.getState().apiConfiguration.planModeApiProvider).toBe("requesty")
		fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
		expect(handleFieldsChange).toHaveBeenCalledWith({}, "openrouter")
		await screen.findByRole("status")
		expect(screen.queryByRole("button", { name: "Add provider" })).not.toBeInTheDocument()
	})

	it("discards a first-time OpenRouter selection without persisting an invalid provider", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		fireEvent.click(screen.getByRole("button", { name: "Cancel OpenRouter selection" }))

		expect(handleModeFieldChange).not.toHaveBeenCalled()
		expect(handleFieldsChange).not.toHaveBeenCalled()
		expect(useSettingsStore.getState().apiConfiguration.planModeApiProvider).toBe("requesty")
	})

	it("persists the provider and model together after selecting an OpenRouter model", async () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		fireEvent.click(screen.getByRole("button", { name: "Choose OpenRouter model" }))

		await waitFor(() => {
			expect(handleFieldsChange).toHaveBeenCalledWith({
				planModeApiProvider: "openrouter",
				actModeApiProvider: "openrouter",
				planModeOpenRouterModelId: "anthropic/test",
				actModeOpenRouterModelId: "anthropic/test",
				planModeOpenRouterModelInfo: { supportsPromptCache: false },
				actModeOpenRouterModelInfo: { supportsPromptCache: false },
				planModeInferenceSpeed: "default",
				actModeInferenceSpeed: "default",
			})
		})
	})
})

describe("Provider setup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		handleFieldsChange.mockResolvedValue(true)
		mockExtensionState({ planModeApiProvider: "requesty", actModeApiProvider: "requesty" })
	})

	it("starts with an empty picker rather than the active provider's settings", () => {
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		expect(screen.getByTestId("provider-selector-input")).toHaveValue("")
		expect(screen.queryByPlaceholderText("Enter API Key...")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Add provider" })).not.toBeInTheDocument()
		expect(handleFieldsChange).not.toHaveBeenCalled()
	})

	it("edits a configured provider without a picker or duplicate add action", () => {
		useSettingsStore.setState({ configuredApiProviders: ["requesty"] })
		render(<ApiOptions currentMode="act" intent="setup" initialSetupProvider="requesty" showModelOptions={false} />)
		expect(screen.getByPlaceholderText("Enter API Key...")).toBeInTheDocument()
		expect(screen.queryByTestId("provider-selector-input")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Add provider" })).not.toBeInTheDocument()
		expect(screen.getByText(/settings save automatically/)).toBeInTheDocument()
	})

	it("identifies an already-added provider when selected from the add picker", () => {
		useSettingsStore.setState({ configuredApiProviders: ["openrouter"] })
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		expect(screen.getByRole("status")).toHaveTextContent("This provider is added")
		expect(screen.queryByRole("button", { name: "Add provider" })).not.toBeInTheDocument()
		expect(handleFieldsChange).not.toHaveBeenCalled()
	})

	it("disables duplicate submissions until addition finishes", async () => {
		let finish!: (saved: boolean) => void
		handleFieldsChange.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve }))
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
		expect(screen.getByRole("button", { name: "Adding provider…" })).toBeDisabled()
		expect(screen.getByTestId("provider-selector-input")).toHaveProperty("disabled", true)
		await act(async () => finish(true))
		expect(screen.getByRole("status")).toHaveTextContent("This provider is added")
		expect(useSettingsStore.getState().apiConfiguration).toMatchObject({
			planModeApiProvider: "requesty", actModeApiProvider: "requesty",
		})
	})

	it("keeps a failed addition retryable and displays the persistence error", async () => {
		handleFieldsChange.mockImplementationOnce(async () => {
			useSettingsStore.setState({ apiConfigurationError: "Provider setup could not be saved" })
			return false
		})
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		fireEvent.focus(screen.getByTestId("provider-selector-input"))
		fireEvent.click(screen.getByTestId("provider-option-openrouter"))
		fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
		await waitFor(() => expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled())
		expect(screen.getByText(/Could not save API configuration:/)).toHaveTextContent("Provider setup could not be saved")
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it("supports keyboard selection, Escape and reopening without activation", () => {
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		const picker = screen.getByTestId("provider-selector-input") as HTMLInputElement
		fireEvent.focus(picker)
		picker.value = "OpenRouter"
		fireEvent.input(picker)
		fireEvent.keyDown(picker, { key: "Escape" })
		expect(picker).toHaveAttribute("aria-expanded", "false")
		fireEvent.keyDown(picker, { key: "ArrowDown" })
		expect(picker).toHaveAttribute("aria-expanded", "true")
		picker.value = "OpenRouter"
		fireEvent.input(picker)
		fireEvent.keyDown(picker, { key: "ArrowDown" })
		fireEvent.keyDown(picker, { key: "Enter" })
		expect(picker).toHaveValue("OpenRouter")
		expect(picker).toHaveAttribute("aria-expanded", "false")
		expect(handleFieldsChange).not.toHaveBeenCalled()
	})

	it("shows an empty search result and dismisses on keyboard focus leaving", () => {
		render(<ApiOptions currentMode="act" intent="setup" showModelOptions={false} />)
		const picker = screen.getByTestId("provider-selector-input") as HTMLInputElement
		fireEvent.focus(picker)
		picker.value = "zzzzzzzzzzzzzz"
		fireEvent.input(picker)
		expect(screen.getByRole("status")).toHaveTextContent("No providers found")
		fireEvent.blur(picker, { relatedTarget: document.body })
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
	})
})

describe("ApiOptions Component", () => {
	vi.clearAllMocks()
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		mockExtensionState({
			planModeApiProvider: "together",
			actModeApiProvider: "together",
		})
	})

	it("renders Together API Key input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const apiKeyInput = screen.getByPlaceholderText("Enter API Key...")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders Together Model ID input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const modelIdInput = screen.getByPlaceholderText("Enter Model ID...")
		expect(modelIdInput).toBeInTheDocument()
	})
})

describe("ApiOptions Component", () => {
	vi.clearAllMocks()
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }

		mockExtensionState({
			planModeApiProvider: "fireworks",
			actModeApiProvider: "fireworks",
			fireworksApiKey: "",
			planModeFireworksModelId: "",
			actModeFireworksModelId: "",
			fireworksModelMaxCompletionTokens: 2000,
			fireworksModelMaxTokens: 4000,
		})
	})

	it("renders Fireworks API Key input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const apiKeyInput = screen.getByPlaceholderText("Enter API Key...")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders Fireworks Model Select", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const modelIdSelect = screen.getByLabelText("Model")
		expect(modelIdSelect).toBeInTheDocument()
		expect(modelIdSelect).toHaveValue("accounts/fireworks/models/kimi-k2p6")
	})
})

describe("OpenApiInfoOptions", () => {
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		mockExtensionState({
			planModeApiProvider: "openai",
			actModeApiProvider: "openai",
		})
	})

	it("renders OpenAI Supports Images input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		fireEvent.click(screen.getByText("Model Configuration"))
		const apiKeyInput = screen.getByText("Supports Images")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders OpenAI Context Window Size input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		fireEvent.click(screen.getByText("Model Configuration"))
		const orgIdInput = screen.getByText("Context Window")
		expect(orgIdInput).toBeInTheDocument()
	})

	it("renders OpenAI Max Output Tokens input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		fireEvent.click(screen.getByText("Model Configuration"))
		const modelInput = screen.getByText("Max Output")
		expect(modelInput).toBeInTheDocument()
	})

	it("auto-fetches OpenAI-compatible models on mount when openAiBaseUrl is configured", async () => {
		const refreshOpenAiModels = vi.fn()
		useSettingsStore.setState({
			apiConfiguration: {
				planModeApiProvider: "openai",
				actModeApiProvider: "openai",
				openAiBaseUrl: "http://localhost:11434/v1",
			},
			refreshOpenAiModels,
		} as any)

		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		await waitFor(() => expect(refreshOpenAiModels).toHaveBeenCalledWith("http://localhost:11434/v1", undefined, {}))
	})

	it("refreshes OpenAI-compatible models when switching saved profiles", async () => {
		const refreshOpenAiModels = vi.fn()
		useSettingsStore.setState({
			apiConfiguration: {
				planModeApiProvider: "openai",
				actModeApiProvider: "openai",
				openAiCompatibleProfiles: [
					{
						name: "Local Ollama",
						baseUrl: "http://localhost:11434/v1",
						apiKey: "",
						modelId: "qwen2.5-coder:32b",
					},
				],
			},
			refreshOpenAiModels,
		} as any)

		const { container } = render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const dropdown = container.querySelector("vscode-dropdown") as any
		dropdown.value = "Local Ollama"
		fireEvent(dropdown, new Event("change", { bubbles: true }))

		await waitFor(() => {
			expect(refreshOpenAiModels).toHaveBeenCalledWith("http://localhost:11434/v1", "", {})
		})
	})
})

describe("ApiOptions Component", () => {
	vi.clearAllMocks()
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }

		mockExtensionState({
			planModeApiProvider: "nebius",
			actModeApiProvider: "nebius",
			nebiusApiKey: "",
		})
	})

	it("renders Nebius API Key input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const apiKeyInput = screen.getByPlaceholderText("Enter API Key...")
		expect(apiKeyInput).toBeInTheDocument()
	})

	it("renders Nebius Model ID select with a default model", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const modelIdSelect = screen.getByLabelText("Model")
		expect(modelIdSelect).toBeInTheDocument()
		expect(modelIdSelect).toHaveValue("openai/gpt-oss-120b")
	})
})
