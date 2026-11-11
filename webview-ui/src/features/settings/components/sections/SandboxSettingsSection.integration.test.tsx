import { SandboxStatus, State, UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "@shared/SandboxSettings"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useAppStore } from "@/app/store/appStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import SandboxSettingsSection from "./SandboxSettingsSection"

const rpc = vi.hoisted(() => ({
	updateSettings: vi.fn(),
	getSandboxStatus: vi.fn(),
	subscribeToState: vi.fn(),
}))
vi.mock("@/shared/api/grpc-client", () => ({
	StateServiceClient: rpc,
	ModelsServiceClient: {},
	UiServiceClient: {
		initializeWebview: () => Promise.resolve(),
		subscribeToHistoryButtonClicked: () => () => {},
		subscribeToSettingsButtonClicked: () => () => {},
		subscribeToChatButtonClicked: () => () => {},
		subscribeToAccountButtonClicked: () => () => {},
	},
}))

let persisted: SandboxSettings
let publish: (settings: SandboxSettings) => void
const mount = () => render(<SandboxSettingsSection renderSectionHeader={() => null} />)
const checkbox = () => screen.getByRole("checkbox", { name: "Sandbox commands" }) as HTMLElement & { checked: boolean }

beforeEach(() => {
	vi.clearAllMocks()
	persisted = structuredClone(DEFAULT_SANDBOX_SETTINGS)
	useSettingsStore.getState().setSettings({ sandboxSettings: persisted })
	rpc.getSandboxStatus.mockResolvedValue(SandboxStatus.create({ effectiveState: "off", hostPlatform: "linux" }))
	rpc.subscribeToState.mockImplementation((_request, observer) => {
		publish = (sandboxSettings) => observer.onResponse(State.create({ stateJson: JSON.stringify({ sandboxSettings }) }))
		return () => {}
	})
	rpc.updateSettings.mockImplementation(async (request) => {
		// Exercise the request codec and the same JSON subscription hydration used by VSCode.
		const decoded = UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(request).finish())
		persisted = decoded.sandboxSettings as SandboxSettings
		await Promise.resolve()
		publish(persisted)
		return {}
	})
})

describe("Sandbox settings with the VSCode toolkit and state subscription", () => {
	it("keeps the saved checkbox checked, reveals profiles, and restores them on reopen", async () => {
		const unsubscribe = useAppStore.getState().hydrate()
		const savedAssignments = {
			mainAgentProfileId: "builtin-workspace",
			subagentProfileId: "builtin-read-only",
			allowUnsandboxedFallback: true,
		}
		act(() => publish({ ...persisted, ...savedAssignments }))
		const view = mount()
		await waitFor(() => expect(rpc.getSandboxStatus).toHaveBeenCalledOnce())
		expect(checkbox().tagName).toBe("VSCODE-CHECKBOX")
		await act(async () => {
			fireEvent.click(checkbox())
		})
		await waitFor(() => expect(checkbox().checked).toBe(true))
		expect(screen.getByLabelText("Main-agent profile")).toBeVisible()
		expect(screen.getByLabelText("Subagent profile")).toBeVisible()
		expect(persisted.enabled).toBe(true)
		expect(persisted).toMatchObject(savedAssignments)
		expect(screen.getByLabelText("Main-agent profile")).toHaveTextContent("Workspace")
		expect(screen.getByLabelText("Subagent profile")).toHaveTextContent("Read-only")
		expect(rpc.updateSettings).toHaveBeenCalledTimes(1)
		view.unmount()
		act(() => publish(persisted))
		await act(async () => {
			mount()
		})
		expect(checkbox().checked).toBe(true)
		expect(screen.getByLabelText("Main-agent profile")).toBeVisible()
		unsubscribe()
	})

	it("restores the unchecked persisted state after a rejected save, including on reopen", async () => {
		const unsubscribe = useAppStore.getState().hydrate()
		rpc.updateSettings.mockRejectedValueOnce(new Error("Disk full"))
		const view = mount()
		await waitFor(() => expect(rpc.getSandboxStatus).toHaveBeenCalledOnce())
		fireEvent.click(checkbox())
		expect(await screen.findByText(/Could not save sandbox settings: Error: Disk full/)).toBeVisible()
		expect(checkbox().checked).toBe(false)
		expect(screen.queryByLabelText("Main-agent profile")).not.toBeInTheDocument()
		expect(persisted.enabled).toBe(false)
		expect(rpc.updateSettings).toHaveBeenCalledTimes(1)
		view.unmount()
		await act(async () => {
			mount()
		})
		expect(checkbox().checked).toBe(false)
		expect(screen.queryByLabelText("Main-agent profile")).not.toBeInTheDocument()
		unsubscribe()
	})

	it("saves fallback and disable clicks once without writing property-only snapshot changes", async () => {
		const unsubscribe = useAppStore.getState().hydrate()
		await act(async () => {
			mount()
		})
		act(() => publish({ ...persisted, enabled: true }))
		expect(checkbox().checked).toBe(true)
		expect(rpc.updateSettings).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("Details and advanced settings"))
		const fallback = screen.getByRole("checkbox", { name: "Allow unsandboxed fallback" }) as HTMLElement & {
			checked: boolean
		}
		await act(async () => {
			fireEvent.click(fallback)
		})
		expect(fallback.checked).toBe(true)
		expect(persisted.allowUnsandboxedFallback).toBe(true)
		expect(rpc.updateSettings).toHaveBeenCalledTimes(1)
		await act(async () => {
			fireEvent.click(checkbox())
		})
		expect(checkbox().checked).toBe(false)
		expect(persisted.enabled).toBe(false)
		expect(persisted.allowUnsandboxedFallback).toBe(true)
		expect(screen.queryByLabelText("Main-agent profile")).not.toBeInTheDocument()
		expect(rpc.updateSettings).toHaveBeenCalledTimes(2)
		unsubscribe()
	})
})
