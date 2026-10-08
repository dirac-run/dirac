import "@testing-library/jest-dom/vitest"
import { UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Callbacks } from "@/shared/api/grpc-client-base"
import { UnbiasedProvider } from "./UnbiasedProvider"

const mocks = vi.hoisted(() => ({
	authenticate: vi.fn(),
	signOut: vi.fn(),
	cancel: vi.fn(),
	settings: {
		apiConfiguration: { unbiasedApiKey: "" },
		unbiasedWorkloadName: null as string | null,
		pendingApiConfigurationUpdates: {} as { unbiasedApiKey?: string },
	},
}))
vi.mock("@/shared/api/grpc-client", () => ({
	ModelsServiceClient: { authenticateUnbiased: mocks.authenticate, signOutUnbiased: mocks.signOut },
	FileServiceClient: {},
	UiServiceClient: {},
}))
vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: () => mocks.settings,
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn(), handleModeFieldChange: vi.fn() }),
}))
vi.mock("@/features/settings/components/utils/providerUtils", () => ({
	normalizeApiConfiguration: () => ({ selectedModelId: "pareto", selectedModelInfo: {} }),
}))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => null }))
vi.mock("../common/ModelSelector", () => ({ ModelSelector: () => null }))

function callbacks(index = 0): Callbacks<UnbiasedAuthEvent> {
	return mocks.authenticate.mock.calls[index][1]
}
function mount() {
	return render(<UnbiasedProvider showModelOptions={false} currentMode="act" />)
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
})
afterEach(cleanup)

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
