import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { useApiConfigurationHandlers } from "./useApiConfigurationHandlers"

vi.mock("@/shared/api/grpc-client", () => ({
	ModelsServiceClient: { updateApiConfigurationPartial: vi.fn() },
}))

describe("API configuration write intent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(ModelsServiceClient.updateApiConfigurationPartial).mockResolvedValue({})
		useSettingsStore.setState({
			apiConfiguration: { planModeApiProvider: "anthropic", actModeApiProvider: "anthropic", apiKey: "main-secret" },
			pendingApiConfigurationUpdates: {},
		})
	})

	it("sends only addressed setup fields and the edited provider, leaving main selection untouched", async () => {
		const { result } = renderHook(() => useApiConfigurationHandlers())
		await act(async () => {
			await result.current.handleFieldsChange({ geminiApiKey: "new-secret" }, "gemini")
		})
		const request = vi.mocked(ModelsServiceClient.updateApiConfigurationPartial).mock.calls[0][0]
		expect(request.setupOnly).toBe(true)
		expect(request.setupProvider).toBe("gemini")
		expect(request.updateMask).toEqual(["geminiApiKey"])
		expect(request.apiConfiguration?.geminiApiKey).toBe("new-secret")
		expect(request.apiConfiguration?.apiKey).toBeUndefined()
		expect(request.apiConfiguration?.planModeApiProvider).toBeUndefined()
		expect(useSettingsStore.getState().apiConfiguration.planModeApiProvider).toBe("anthropic")
	})

	it.each([{ geminiSearchEnabled: true }, { lmStudioMaxTokens: 4096 }])("keeps execution controls on validated activation: %j", async (updates) => {
		const { result } = renderHook(() => useApiConfigurationHandlers())
		await act(async () => { await result.current.handleFieldsChange(updates, "gemini") })
		const request = vi.mocked(ModelsServiceClient.updateApiConfigurationPartial).mock.calls[0][0]
		expect(request.setupOnly).toBe(false)
		expect(request.setupProvider).toBeUndefined()
	})

	it("allows explicit keyless addition without a selection patch", async () => {
		const { result } = renderHook(() => useApiConfigurationHandlers())
		await act(async () => { await result.current.handleFieldsChange({}, "lmstudio") })
		expect(ModelsServiceClient.updateApiConfigurationPartial).toHaveBeenCalledWith(expect.objectContaining({
			setupOnly: true, setupProvider: "lmstudio", updateMask: [],
		}))
	})
})
