import { afterEach, describe, expect, it, vi } from "vitest"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { useSettingsStore } from "./settingsStore"

describe("OpenAI endpoint model suggestions", () => {
	afterEach(() => vi.restoreAllMocks())

	it("passes endpoint headers and ignores an older endpoint response", async () => {
		let finishA!: (value: { values: string[] }) => void
		const fetch = vi.spyOn(ModelsServiceClient, "refreshOpenAiModels")
			.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve }))
			.mockResolvedValueOnce({ values: ["model-b"] })
		const refresh = useSettingsStore.getState().refreshOpenAiModels
		const first = refresh("https://a.example/v1", "key-a", { "X-Endpoint": "a" })
		await refresh("http://localhost:1234/v1", undefined, { "X-Endpoint": "b" })
		finishA({ values: ["model-a"] })
		await first
		expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({
			baseUrl: "http://localhost:1234/v1", apiKey: "", headers: { "X-Endpoint": "b" },
		}))
		expect(Object.keys(useSettingsStore.getState().openAiModels)).toEqual(["model-b"])
	})

	it("clears suggestions and invalidates pending responses when a blank new endpoint is selected", async () => {
		let finish!: (value: { values: string[] }) => void
		vi.spyOn(ModelsServiceClient, "refreshOpenAiModels").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
		const refresh = useSettingsStore.getState().refreshOpenAiModels
		const pending = refresh("https://a.example/v1", "key-a")
		await refresh("")
		finish({ values: ["model-a"] })
		await pending
		expect(useSettingsStore.getState().openAiModels).toEqual({})
	})
})
