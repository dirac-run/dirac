import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import ApiConfigurationSection from "./ApiConfigurationSection"

vi.mock("../ApiOptions", () => ({
	default: ({ initialSetupProvider, intent, currentMode, showModelOptions }: {
		initialSetupProvider?: string
		intent?: string
		currentMode: string
		showModelOptions?: boolean
	}) => (
		<div
			data-testid="api-options"
			data-provider={initialSetupProvider ?? ""}
			data-intent={intent}
			data-mode={currentMode}
			data-model-options={String(showModelOptions)}>
			<input aria-label="Setup draft" defaultValue={initialSetupProvider ?? ""} />
		</div>
	),
}))
vi.mock("../ProviderSetupSummary", () => ({
	ProviderSetupSummary: ({ provider }: { provider: string }) => <span>Saved setup for {provider}</span>,
}))

const profiles = [
	{ name: "Workstation", baseUrl: "http://localhost:8080", modelId: "", modelInfo: { supportsPromptCache: false } },
	{ name: "Team endpoint", baseUrl: "https://models.example.com/v1", modelId: "", modelInfo: { supportsPromptCache: false } },
]
const backToProviders = () => fireEvent.click(screen.getByRole("button", { name: "Back to providers" }))
const addProvider = () => fireEvent.click(screen.getByRole("button", { name: "+ Add provider" }))
const editProvider = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Edit ${label} setup` }))

beforeEach(() => {
	useSettingsStore.setState({
		configuredApiProviders: ["anthropic", "gemini"],
		apiConfiguration: { actModeApiProvider: "anthropic", planModeApiProvider: "gemini" },
	})
})

describe("API provider settings navigation", () => {
	it("starts with configured provider summaries and setup actions, not an open form", () => {
		const renderSectionHeader = vi.fn(() => <h2>API providers</h2>)
		render(<ApiConfigurationSection renderSectionHeader={renderSectionHeader} />)

		expect(renderSectionHeader).toHaveBeenCalledWith("models-api")
		expect(screen.getByRole("heading", { name: "Configured providers" })).toBeInTheDocument()
		const rows = within(screen.getByRole("list", { name: "Configured providers" })).getAllByRole("listitem")
		expect(rows).toHaveLength(2)
		expect(within(rows[0]).getByText("Anthropic")).toBeInTheDocument()
		expect(within(rows[0]).getByText("Saved setup for anthropic")).toBeInTheDocument()
		expect(within(rows[0]).getByRole("button", { name: "Edit Anthropic setup" })).toHaveTextContent("Edit setup")
		expect(within(rows[1]).getByText("Google Gemini")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "+ Add provider" })).toBeInTheDocument()
		expect(screen.getByText(/Provider setup does not change your active model selection/)).toBeInTheDocument()
		expect(screen.queryByTestId("api-options")).not.toBeInTheDocument()
	})

	it("opens a dedicated add view with no initial provider and returns to the list", () => {
		render(<ApiConfigurationSection />)
		addProvider()

		expect(screen.getByRole("heading", { name: "Add provider" })).toBeInTheDocument()
		const options = screen.getByTestId("api-options")
		expect(options).toHaveAttribute("data-provider", "")
		expect(options).toHaveAttribute("data-intent", "setup")
		expect(options).toHaveAttribute("data-mode", "act")
		expect(options).toHaveAttribute("data-model-options", "false")
		expect(screen.queryByRole("list", { name: "Configured providers" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "+ Add provider" })).not.toBeInTheDocument()
		backToProviders()
		expect(screen.getByRole("list", { name: "Configured providers" })).toBeInTheDocument()
		expect(screen.queryByTestId("api-options")).not.toBeInTheDocument()
	})

	it("opens provider-specific setup without the list and leaves active selections unchanged", () => {
		const configuration = useSettingsStore.getState().apiConfiguration
		render(<ApiConfigurationSection />)
		editProvider("Google Gemini")

		expect(screen.getByRole("heading", { name: "Google Gemini setup" })).toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-provider", "gemini")
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-intent", "setup")
		expect(screen.queryByRole("list", { name: "Configured providers" })).not.toBeInTheDocument()
		expect(screen.queryByText("Saved setup for anthropic")).not.toBeInTheDocument()
		backToProviders()
		expect(useSettingsStore.getState().apiConfiguration).toBe(configuration)
	})

	it("resets setup drafts and provider identity across edit, add, and repeated visits", () => {
		render(<ApiConfigurationSection />)
		editProvider("Anthropic")
		fireEvent.change(screen.getByLabelText("Setup draft"), { target: { value: "unfinished edit" } })
		backToProviders()
		addProvider()
		expect(screen.getByLabelText("Setup draft")).toHaveValue("")
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-provider", "")
		fireEvent.change(screen.getByLabelText("Setup draft"), { target: { value: "unfinished add" } })
		backToProviders()
		editProvider("Google Gemini")
		expect(screen.getByLabelText("Setup draft")).toHaveValue("gemini")
		backToProviders()
		editProvider("Anthropic")
		expect(screen.getByLabelText("Setup draft")).toHaveValue("anthropic")
		backToProviders()
		addProvider()
		expect(screen.getByLabelText("Setup draft")).toHaveValue("")
	})

	it("shows an actionable empty state without rendering setup until Add is clicked", () => {
		useSettingsStore.setState({ configuredApiProviders: [], apiConfiguration: {} })
		render(<ApiConfigurationSection />)

		expect(screen.getByText("No providers configured yet. Add a provider to get started.")).toBeInTheDocument()
		expect(screen.queryByRole("list", { name: "Configured providers" })).not.toBeInTheDocument()
		expect(screen.queryByTestId("api-options")).not.toBeInTheDocument()
		addProvider()
		expect(screen.getByRole("heading", { name: "Add provider" })).toBeInTheDocument()
		expect(screen.queryByText(/No providers configured yet/)).not.toBeInTheDocument()
	})

	it("groups named profiles and their URLs under the OpenAI Compatible provider only once", () => {
		useSettingsStore.setState({
			configuredApiProviders: ["anthropic", "openai"],
			apiConfiguration: { openAiCompatibleProfiles: profiles },
		})
		render(<ApiConfigurationSection />)

		const profileList = screen.getByRole("list", { name: "OpenAI Compatible profiles" })
		const providerRow = profileList.closest("li")!
		expect(within(providerRow).getByText("OpenAI Compatible")).toBeInTheDocument()
		expect(within(providerRow).getByRole("button", { name: "Edit OpenAI Compatible setup" })).toBeInTheDocument()
		expect(within(profileList).getAllByRole("listitem")).toHaveLength(2)
		for (const profile of profiles) {
			expect(within(profileList).getByText(profile.name)).toBeInTheDocument()
			expect(within(profileList).getByText(profile.baseUrl)).toBeInTheDocument()
		}
		expect(screen.getAllByRole("button", { name: "Edit OpenAI Compatible setup" })).toHaveLength(1)
		editProvider("OpenAI Compatible")
		expect(screen.queryByRole("list", { name: "OpenAI Compatible profiles" })).not.toBeInTheDocument()
	})

	it("provides an editable OpenAI Compatible row when only named profiles are configured", () => {
		useSettingsStore.setState({ configuredApiProviders: [], apiConfiguration: { openAiCompatibleProfiles: profiles } })
		render(<ApiConfigurationSection />)

		expect(screen.queryByText(/No providers configured yet/)).not.toBeInTheDocument()
		expect(screen.getByRole("list", { name: "OpenAI Compatible profiles" })).toBeInTheDocument()
		editProvider("OpenAI Compatible")
		expect(screen.getByRole("heading", { name: "OpenAI Compatible setup" })).toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toHaveAttribute("data-provider", "openai")
	})
})
