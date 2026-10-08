import { ApiConfiguration } from "@shared/api"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"

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
			})
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

describe("ApiOptions Component - Atlas Cloud", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: vi.fn() }

		mockExtensionState({
			planModeApiProvider: "atlascloud",
			actModeApiProvider: "atlascloud",
			atlascloudApiKey: "",
		})
	})

	it("renders Atlas Cloud API Key input", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		expect(screen.getByPlaceholderText("Enter API Key...")).toBeInTheDocument()
	})

	it("renders Atlas Cloud Model ID select with the default model", () => {
		render(<ApiOptions currentMode="plan" showModelOptions={true} />)
		const modelIdSelect = screen.getByLabelText("Model")
		expect(modelIdSelect).toBeInTheDocument()
		expect(modelIdSelect).toHaveValue("deepseek-ai/deepseek-v4-flash")
	})
})
