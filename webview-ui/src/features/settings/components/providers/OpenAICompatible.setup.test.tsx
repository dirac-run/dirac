import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openAiModelInfoSaneDefaults } from "@shared/api"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { OpenAICompatibleProvider } from "./OpenAICompatible"
import ApiConfigurationSection from "../sections/ApiConfigurationSection"

const mocks = vi.hoisted(() => ({ save: vi.fn(), mode: vi.fn(), modes: vi.fn(), refresh: vi.fn() }))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange: mocks.save, handleModeFieldChange: mocks.mode, handleModeFieldsChange: mocks.modes }),
}))
vi.mock("../common/ModelAutocomplete", () => ({
	ModelAutocomplete: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange("changed-model")}>Choose model</button>,
}))

const profileA = { name: "A", baseUrl: "https://a.example/v1", apiKey: "a-key", modelId: "model-a", modelInfo: openAiModelInfoSaneDefaults, headers: { "X-Endpoint": "a" } }
const profileB = { name: "B", baseUrl: "http://localhost:1234/v1", modelId: "", modelInfo: openAiModelInfoSaneDefaults, headers: { "X-Endpoint": "b" } }

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("OpenAI-compatible setup drafts", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.save.mockResolvedValue(true)
		mocks.refresh.mockResolvedValue(undefined)
		useSettingsStore.setState({
			apiConfiguration: {
				planModeApiProvider: "openai", actModeApiProvider: "openai",
				planModeOpenAiProfileName: "A", actModeOpenAiProfileName: "A",
				openAiBaseUrl: "https://unrelated.example/v1", openAiApiKey: "wrong-key",
				openAiCompatibleProfiles: [profileA, profileB],
			},
			refreshOpenAiModels: mocks.refresh,
			openAiModels: {},
		})
	})

	it("browses B using coherent endpoint access without activating it, then saves only the profile list", async () => {
		const { container } = render(<OpenAICompatibleProvider currentMode="plan" intent="setup" showModelOptions={false} />)
		await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith("https://unrelated.example/v1", "wrong-key", {}))
		const dropdown = container.querySelector("vscode-dropdown") as HTMLSelectElement
		dropdown.value = "B"
		fireEvent(dropdown, new Event("change", { bubbles: true }))
		expect(mocks.save).not.toHaveBeenCalled()
		await waitFor(() => expect(mocks.refresh).toHaveBeenLastCalledWith(profileB.baseUrl, undefined, profileB.headers))
		expect(screen.queryByText("Choose model")).not.toBeInTheDocument()
		expect(mocks.modes).not.toHaveBeenCalled()
		fireEvent.click(container.querySelector("vscode-button.w-full")!)
		await waitFor(() => expect(mocks.save).toHaveBeenCalled())
		const patch = mocks.save.mock.calls[0][0]
		expect(Object.keys(patch)).toEqual(["openAiCompatibleProfiles"])
		expect(patch.openAiCompatibleProfiles[0]).toEqual(profileA)
		expect(patch.openAiCompatibleProfiles[1].modelId).toBe("")
		expect(useSettingsStore.getState().apiConfiguration.planModeOpenAiProfileName).toBe("A")
	})

	it("starts a blank draft without clearing A and rejects duplicate names", async () => {
		const { container } = render(<OpenAICompatibleProvider currentMode="plan" intent="setup" showModelOptions={false} />)
		fireEvent.click(screen.getByTitle("New Configuration"))
		expect(mocks.save).not.toHaveBeenCalled()
		const name = screen.getByPlaceholderText("Configuration name...") as HTMLInputElement
		fireEvent.input(name, { target: { value: "A" } })
		fireEvent.click(container.querySelector("vscode-button.w-full")!)
		expect(await screen.findByRole("alert")).toHaveTextContent("already exists")
		expect(mocks.save).not.toHaveBeenCalled()
		expect(useSettingsStore.getState().apiConfiguration.actModeOpenAiProfileName).toBe("A")
	})

	it("keeps model controls off the actual API providers settings page", () => {
		useSettingsStore.setState({ configuredApiProviders: ["openai"] })
		render(<ApiConfigurationSection />)
		expect(screen.queryByText("Choose model")).not.toBeInTheDocument()
		expect(screen.queryByText("Use separate models for Plan and Act")).not.toBeInTheDocument()
		expect(mocks.save).not.toHaveBeenCalled()
	})

	it("keeps legacy access repairable alongside named endpoints without activating either", async () => {
		useSettingsStore.setState({ configuredApiProviders: ["openai"] })
		render(<ApiConfigurationSection />)
		expect(screen.getAllByText("A").length).toBeGreaterThan(0)
		expect(screen.getAllByText("B").length).toBeGreaterThan(0)
		fireEvent.click(screen.getByText("Edit setup"))
		fireEvent.click(screen.getByText("Edit legacy endpoint"))
		fireEvent.click(screen.getByText("Save legacy endpoint"))
		await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ openAiBaseUrl: "https://unrelated.example/v1", openAiApiKey: "wrong-key", openAiHeaders: {}, azureApiVersion: "" }, "openai"))
		expect(mocks.mode).not.toHaveBeenCalled()
		expect(mocks.modes).not.toHaveBeenCalled()
		expect(useSettingsStore.getState().apiConfiguration.openAiCompatibleProfiles).toEqual([profileA, profileB])
	})

	it("repairs key-only legacy setup even when named endpoints exist", async () => {
		useSettingsStore.setState({ apiConfiguration: { ...useSettingsStore.getState().apiConfiguration, openAiBaseUrl: undefined } })
		render(<OpenAICompatibleProvider currentMode="plan" intent="setup" showModelOptions={false} />)
		fireEvent.click(screen.getByText("Edit legacy endpoint"))
		fireEvent.click(screen.getByText("Save legacy endpoint"))
		await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ openAiBaseUrl: "", openAiApiKey: "wrong-key" }), "openai"))
	})

	// FAST may expose both its host and a hidden form proxy with the same placeholder.
	const textFields = (placeholder: string | RegExp) => [...new Set(screen.getAllByPlaceholderText(placeholder).map((element) => element.closest("vscode-text-field")!))]
	const inputField = (placeholder: string | RegExp, value: string, index = 0) => {
		const field = textFields(placeholder)[index] as HTMLElement & { value: string }
		field.value = value
		fireEvent.input(field)
	}

	it.each(["legacy", "named"])("saves immediate %s endpoint inputs before discovery runs", async (kind) => {
		vi.useFakeTimers()
		const { container } = render(<OpenAICompatibleProvider currentMode="plan" intent="setup" showModelOptions={false} />)
		if (kind === "named") {
			fireEvent.click(screen.getByTitle("New Configuration"))
			fireEvent.input(screen.getByPlaceholderText("Configuration name..."), { target: { value: "Immediate" } })
		}
		inputField("Enter base URL...", "https://fresh.example/v1")
		inputField("Enter API Key...", "fresh-key")
		inputField(/^Default:/, "2025-01-01")
		fireEvent.click(screen.getByText("Add Header"))
		inputField("Header name", "X-Token")
		inputField("Header value", "fresh-token")
		await act(async () => {
			fireEvent.click(kind === "legacy" ? screen.getByText("Save legacy endpoint") : container.querySelector("vscode-button.w-full")!)
		})
		expect(mocks.refresh).not.toHaveBeenCalled()
		const patch = mocks.save.mock.calls[0][0]
		if (kind === "legacy") expect(patch).toEqual({ openAiBaseUrl: "https://fresh.example/v1", openAiApiKey: "fresh-key", openAiHeaders: { "X-Token": "fresh-token" }, azureApiVersion: "2025-01-01" })
		else expect(patch.openAiCompatibleProfiles.at(-1)).toMatchObject({ name: "Immediate", baseUrl: "https://fresh.example/v1", apiKey: "fresh-key", headers: { "X-Token": "fresh-token" }, azureApiVersion: "2025-01-01" })
		act(() => vi.advanceTimersByTime(250))
		expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("https://fresh.example/v1", "fresh-key", { "X-Token": "fresh-token" })
	})

	it("preserves incomplete and duplicate header rows without saving or discovering them", async () => {
		vi.useFakeTimers()
		render(<OpenAICompatibleProvider currentMode="plan" intent="setup" showModelOptions={false} />)
		fireEvent.click(screen.getByText("Add Header"))
		fireEvent.click(screen.getByText("Save legacy endpoint"))
		act(() => vi.advanceTimersByTime(300))
		expect(mocks.save).not.toHaveBeenCalled()
		expect(mocks.refresh).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toHaveTextContent("non-empty")
		inputField("Header name", "X-Token")
		inputField("Header value", "first")
		fireEvent.click(screen.getByText("Add Header"))
		inputField("Header name", "x-token", 1)
		inputField("Header value", "second", 1)
		fireEvent.click(screen.getByText("Save legacy endpoint"))
		act(() => vi.advanceTimersByTime(300))
		expect(screen.getByRole("alert")).toHaveTextContent("unique")
		expect(textFields("Header value")).toHaveLength(2)
		expect(mocks.save).not.toHaveBeenCalled()
		expect(mocks.refresh).not.toHaveBeenCalled()
		inputField("Header name", "X-Other", 1)
		await act(async () => { fireEvent.click(screen.getByText("Save legacy endpoint")) })
		expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ openAiHeaders: { "X-Token": "first", "X-Other": "second" } }), "openai")
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("retains deliberate active model editing until model controls move", () => {
		render(<OpenAICompatibleProvider currentMode="plan" intent="activate" showModelOptions={true} />)
		fireEvent.click(screen.getByText("Choose model"))
		expect(mocks.modes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ openAiModelId: "changed-model" }), "plan")
	})
})
