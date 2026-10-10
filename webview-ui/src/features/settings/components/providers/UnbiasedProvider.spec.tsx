import "@testing-library/jest-dom/vitest"
import { type ModelInfo, unbiasedModels } from "@shared/api"
import { OpenRouterCompatibleModelInfo, OpenRouterModelInfo, UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Callbacks } from "@/shared/api/grpc-client-base"
import { UnbiasedProvider } from "./UnbiasedProvider"

const mocks = vi.hoisted(() => ({
	authenticate: vi.fn(),
	signOut: vi.fn(),
	cancel: vi.fn(),
	refreshModels: vi.fn(),
	changeModel: vi.fn(),
	modelSelector: vi.fn(
		(_props: {
			models: Record<string, ModelInfo>
			selectedModelId: string
			onChange: (event: { target: { value: string } }) => void
		}) => null,
	),
	modelInfo: vi.fn((_props: { modelInfo: ModelInfo }) => null),
	settings: {
		apiConfiguration: { unbiasedApiKey: "", actModeApiModelId: "pareto", planModeApiModelId: "pareto" },
		unbiasedWorkloadName: null as string | null,
		pendingApiConfigurationUpdates: {} as { unbiasedApiKey?: string },
	},
}))
vi.mock("@/shared/api/grpc-client", () => ({
	ModelsServiceClient: {
		authenticateUnbiased: mocks.authenticate,
		signOutUnbiased: mocks.signOut,
		refreshUnbiasedModelsRpc: mocks.refreshModels,
	},
	FileServiceClient: {},
	UiServiceClient: {},
}))
vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: () => mocks.settings,
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn(), handleModeFieldChange: mocks.changeModel }),
}))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: mocks.modelInfo }))
vi.mock("../common/ModelSelector", () => ({ ModelSelector: mocks.modelSelector }))

function callbacks(index = 0): Callbacks<UnbiasedAuthEvent> {
	return mocks.authenticate.mock.calls[index][1]
}
function mount(showModelOptions = false) {
	return render(<UnbiasedProvider currentMode="act" showModelOptions={showModelOptions} />)
}
function start() {
	const view = mount()
	fireEvent.click(screen.getByRole("button", { name: "Sign in with Unbiased" }))
	return view
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.settings.apiConfiguration.unbiasedApiKey = ""
	mocks.settings.unbiasedWorkloadName = null
	mocks.settings.pendingApiConfigurationUpdates = {}
	mocks.authenticate.mockReturnValue(mocks.cancel)
	mocks.signOut.mockResolvedValue(undefined)
	mocks.refreshModels.mockReturnValue(new Promise(() => {}))
	mocks.settings.apiConfiguration.actModeApiModelId = "pareto"
	mocks.settings.apiConfiguration.planModeApiModelId = "pareto"
})
afterEach(cleanup)

describe("Unbiased pricing presentation", () => {
	it.each(["Dirac workload", ""])("shows subscription coverage for an OAuth account named %s", (workloadName) => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "oauth-key"
		mocks.settings.unbiasedWorkloadName = workloadName
		mount(true)
		expect(screen.getByText(/Covered by your Unbiased subscription/)).toHaveTextContent(
			"$0 incremental token cost, excluding the monthly fee",
		)
		expect(screen.queryByText(/pay-as-you-go/)).not.toBeInTheDocument()
		expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo).toEqual({
			...unbiasedModels.pareto,
			inputPrice: undefined,
			outputPrice: undefined,
			cacheReadsPrice: undefined,
			cacheWritesPrice: undefined,
		})
	})

	it("shows PAYG prices for a manually configured or environment-overridden key", () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "manual-key"
		mount(true)
		expect(screen.getByText(/pay-as-you-go estimates for API-key usage/)).toBeInTheDocument()
		expect(screen.queryByText(/Covered by your Unbiased subscription/)).not.toBeInTheDocument()
		expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo).toEqual(unbiasedModels.pareto)
	})

	it("restores PAYG prices while an OAuth key is being replaced manually", () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "replacement-key"
		mocks.settings.unbiasedWorkloadName = "Old workload"
		mocks.settings.pendingApiConfigurationUpdates = { unbiasedApiKey: "replacement-key" }
		mount(true)
		expect(screen.getByText(/pay-as-you-go estimates for API-key usage/)).toBeInTheDocument()
		expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo).toEqual(unbiasedModels.pareto)
	})
})

describe("Unbiased account presentation", () => {
	it.each([null, "Dirac workload"])("recognizes a saved login with workload %s when settings reopen", (workloadName) => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "existing-private-key"
		mocks.settings.unbiasedWorkloadName = workloadName
		const view = mount()
		const account = screen.getByRole("region", { name: "Unbiased account" })
		expect(account).toHaveTextContent(`Signed in to ${workloadName || "Unbiased"}`)
		expect(within(account).getByRole("button", { name: "Sign out on this device" })).toBeEnabled()
		expect(screen.queryByRole("button", { name: "Sign in with Unbiased" })).not.toBeInTheDocument()
		expect(mocks.authenticate).not.toHaveBeenCalled()
		expect(view.container).not.toHaveTextContent("existing-private-key")
		view.unmount()
		mount()
		expect(screen.getByRole("region", { name: "Unbiased account" })).toHaveTextContent(workloadName || "Unbiased")
	})

	it("returns to sign-in after a successful sign-out and state publication", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "existing-private-key"
		mocks.settings.unbiasedWorkloadName = "Dirac workload"
		mocks.signOut.mockImplementation(async () => {
			mocks.settings.apiConfiguration.unbiasedApiKey = ""
			mocks.settings.unbiasedWorkloadName = null
		})
		mount()
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out on this device" })))
		expect(mocks.signOut).toHaveBeenCalledOnce()
		expect(screen.getByRole("button", { name: "Sign in with Unbiased" })).toBeEnabled()
		expect(screen.queryByRole("region", { name: "Unbiased account" })).not.toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("Signed out locally")
	})

	it("keeps the account visible when sign-out fails", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "existing-private-key"
		mocks.settings.unbiasedWorkloadName = "Dirac workload"
		mocks.signOut.mockRejectedValue(new Error("Remove UNBIASED_API_KEY from the environment to sign out."))
		mount()
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out on this device" })))
		expect(screen.getByRole("alert")).toHaveTextContent("Remove UNBIASED_API_KEY")
		expect(screen.getByRole("region", { name: "Unbiased account" })).toHaveTextContent("Dirac workload")
		expect(screen.getByRole("button", { name: "Sign out on this device" })).toBeEnabled()
		expect(screen.queryByRole("button", { name: "Sign in with Unbiased" })).not.toBeInTheDocument()
	})

	it("hides the old identity while a manual key change is pending", () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "replacement-private-key"
		mocks.settings.unbiasedWorkloadName = "Old workload"
		mocks.settings.pendingApiConfigurationUpdates = { unbiasedApiKey: "replacement-private-key" }
		mount()
		expect(screen.getByRole("region", { name: "Unbiased account" })).toHaveTextContent("Signed in to Unbiased")
		expect(screen.queryByText(/Old workload/)).not.toBeInTheDocument()
	})
})

describe("Unbiased sign-in progress", () => {
	it("shows instructions and replaces sign-in with the connected account", () => {
		start()
		expect(mocks.authenticate).toHaveBeenCalledOnce()
		act(() =>
			callbacks().onResponse(
				UnbiasedAuthEvent.create({
					url: "https://example.com/activate",
					userCode: "ABCD-EFGH",
				}),
			),
		)
		expect(screen.getByText("Waiting for approval…")).toBeInTheDocument()
		expect(screen.getByLabelText("Unbiased verification URL")).toHaveValue("https://example.com/activate")
		expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument()
		mocks.settings.apiConfiguration.unbiasedApiKey = "new-private-key"
		mocks.settings.unbiasedWorkloadName = "Dirac"
		act(() => callbacks().onResponse(UnbiasedAuthEvent.create({ completed: true, workloadName: "Dirac" })))
		expect(screen.getByRole("status")).toHaveTextContent("Signed in to Dirac")
		expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Sign in with Unbiased" })).not.toBeInTheDocument()
		expect(screen.getByRole("region", { name: "Unbiased account" })).toHaveTextContent("Signed in to Dirac")
		expect(screen.getByRole("button", { name: "Sign out on this device" })).toBeEnabled()
	})

	it("ignores instructions from cancelled attempts", () => {
		start()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		fireEvent.click(screen.getByRole("button", { name: "Sign in with Unbiased" }))
		act(() => callbacks(0).onResponse(UnbiasedAuthEvent.create({ url: "https://example.com/old", userCode: "OLD-CODE" })))
		expect(screen.getByText("Preparing sign-in…")).toBeInTheDocument()
		expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument()
	})

	it("displays a specific failure and re-enables sign-in", () => {
		start()
		act(() => callbacks().onError(new Error("Missing or invalid fields: key_name.")))
		expect(screen.getByRole("alert")).toHaveTextContent("key_name")
		expect(screen.getByRole("button", { name: "Sign in with Unbiased" })).toBeEnabled()
	})
})
function catalogResponse(id = "pareto-26.10-preview") {
	return OpenRouterCompatibleModelInfo.create({
		models: {
			pareto: OpenRouterModelInfo.create(unbiasedModels.pareto),
			[id]: OpenRouterModelInfo.create({
				...unbiasedModels.pareto,
				name: "Pareto Preview",
				contextWindow: 1_048_576,
				inputPrice: 0.8,
				outputPrice: 3.2,
				cacheReadsPrice: 0.03,
			}),
		},
	})
}

describe("Unbiased automatic model discovery", () => {
	it("fetches when authenticated settings open and restores the saved version and metadata", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "saved-private-key"
		mocks.settings.apiConfiguration.actModeApiModelId = "pareto-26.10-preview"
		mocks.refreshModels.mockResolvedValue(catalogResponse())
		mount(true)
		await waitFor(() => expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo.contextWindow).toBe(1_048_576))
		expect(mocks.refreshModels).toHaveBeenCalledOnce()
		expect(mocks.modelSelector.mock.calls.at(-1)![0]).toMatchObject({
			selectedModelId: "pareto-26.10-preview",
			models: { "pareto-26.10-preview": { name: "Pareto Preview", supportsTools: true, inputPrice: 0.8 } },
		})
	})

	it("waits for a configured key and skips discovery while a key update is pending", async () => {
		const view = mount(true)
		expect(mocks.refreshModels).not.toHaveBeenCalled()
		mocks.settings.apiConfiguration.unbiasedApiKey = "new-key"
		mocks.settings.pendingApiConfigurationUpdates = { unbiasedApiKey: "new-key" }
		view.rerender(<UnbiasedProvider currentMode="act" showModelOptions />)
		expect(mocks.refreshModels).not.toHaveBeenCalled()
		mocks.settings.pendingApiConfigurationUpdates = {}
		mocks.refreshModels.mockResolvedValue(catalogResponse())
		view.rerender(<UnbiasedProvider currentMode="act" showModelOptions />)
		await waitFor(() => expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toHaveProperty("pareto-26.10-preview"))
		expect(mocks.refreshModels).toHaveBeenCalledOnce()
	})

	it("does not replace a newer credential's catalog with an obsolete response", async () => {
		let finishOld!: (response: OpenRouterCompatibleModelInfo) => void
		mocks.settings.apiConfiguration.unbiasedApiKey = "old-key"
		mocks.refreshModels.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOld = resolve
				}),
		)
		const view = mount(true)
		mocks.settings.apiConfiguration.unbiasedApiKey = "new-key"
		mocks.refreshModels.mockResolvedValueOnce(catalogResponse("pareto-new"))
		view.rerender(<UnbiasedProvider currentMode="act" showModelOptions />)
		await waitFor(() => expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toHaveProperty("pareto-new"))
		await act(async () => finishOld(catalogResponse("pareto-old")))
		expect(mocks.modelSelector.mock.calls.at(-1)![0].models).not.toHaveProperty("pareto-old")
		expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toHaveProperty("pareto-new")
	})

	it("clears discovery on sign-out and ignores an in-flight response", async () => {
		let finish!: (response: OpenRouterCompatibleModelInfo) => void
		mocks.settings.apiConfiguration.unbiasedApiKey = "private-key"
		mocks.refreshModels.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const view = mount(true)
		mocks.settings.apiConfiguration.unbiasedApiKey = ""
		view.rerender(<UnbiasedProvider currentMode="act" showModelOptions />)
		await act(async () => finish(catalogResponse()))
		expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toEqual(unbiasedModels)
		expect(screen.queryByText("Loading Unbiased models…")).not.toBeInTheDocument()
	})

	it("keeps the existing selector usable if the RPC fails", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "private-key"
		mocks.refreshModels.mockRejectedValueOnce(new Error("transport unavailable"))
		mount(true)
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load Unbiased models"))
		expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toEqual(unbiasedModels)
	})

	it("writes the selected version to the existing mode-specific model field", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "private-key"
		mocks.refreshModels.mockResolvedValue(catalogResponse())
		render(<UnbiasedProvider currentMode="plan" showModelOptions />)
		await waitFor(() => expect(mocks.modelSelector.mock.calls.at(-1)![0].models).toHaveProperty("pareto-26.10-preview"))
		mocks.modelSelector.mock.calls.at(-1)![0].onChange({ target: { value: "pareto-26.10-preview" } })
		expect(mocks.changeModel).toHaveBeenCalledWith(
			{ plan: "planModeApiModelId", act: "actModeApiModelId" },
			"pareto-26.10-preview",
			"plan",
		)
	})

	it("continues hiding fetched per-token prices for subscription accounts", async () => {
		mocks.settings.apiConfiguration.unbiasedApiKey = "oauth-key"
		mocks.settings.apiConfiguration.actModeApiModelId = "pareto-26.10-preview"
		mocks.settings.unbiasedWorkloadName = "Dirac workload"
		mocks.refreshModels.mockResolvedValue(catalogResponse())
		mount(true)
		await waitFor(() => expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo.contextWindow).toBe(1_048_576))
		expect(mocks.modelInfo.mock.calls.at(-1)![0].modelInfo).toMatchObject({
			inputPrice: undefined,
			outputPrice: undefined,
			cacheReadsPrice: undefined,
		})
		expect(screen.getByText(/Covered by your Unbiased subscription/)).toBeInTheDocument()
	})
})
