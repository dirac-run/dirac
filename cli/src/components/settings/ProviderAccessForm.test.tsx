// biome-ignore lint/correctness/noUnusedImports: Vitest uses the classic JSX runtime.
import React from "react"
import type { Key } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderAccessForm } from "./ProviderAccessForm"

const mocks = vi.hoisted(() => ({ save: vi.fn(), settings: vi.fn(), secret: vi.fn(), input: undefined as ((text: string, key: Key) => void) | undefined }))
// ink-testing-library v4 stdin does not reach Ink 7's internal input emitter.
vi.mock("ink", async (original) => ({ ...(await original<typeof import("ink")>()), useInput: (handler: typeof mocks.input) => { mocks.input = handler } }))
vi.mock("../../utils/provider-config", () => ({ saveProviderSetup: mocks.save }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getSystemDefaultSettingsKey: mocks.settings,
			getSecretKey: mocks.secret,
		})
	}
}))

const views: ReturnType<typeof render>[] = []
const pause = () => new Promise((resolve) => setTimeout(resolve, 60))
async function input(_view: ReturnType<typeof render>, text: string) {
	const keys: Record<string, Partial<Key>> = { "\r": { return: true }, "\t": { tab: true }, "\u007f": { backspace: true } }
	mocks.input!(keys[text] ? "" : text, (keys[text] ?? {}) as Key)
	await pause()
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.secret.mockReturnValue("saved-key")
	mocks.settings.mockImplementation((key: string) => key === "openAiBaseUrl" ? "http://proxy/v1" : {})
	mocks.save.mockResolvedValue(undefined)
})
afterEach(() => { for (const view of views.splice(0)) view.unmount() })

describe("legacy provider access form", () => {
	it("edits headers and saves them together with the displayed key and URL", async () => {
		const done = vi.fn()
		const view = render(<ProviderAccessForm provider="openai" onDone={done} onCancel={vi.fn()} />)
		views.push(view)
		await pause()
		await input(view, "\r")
		await input(view, "\t")
		expect(view.lastFrame()).toContain("› Headers (JSON; {} to clear): {}")
		await input(view, "\u007f")
		await input(view, "\u007f")
		await input(view, '{"X-Proxy":"rotated"}')
		await input(view, "\r")
		expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ providerId: "openai", apiKey: "saved-key", baseUrl: "http://proxy/v1", headers: { "X-Proxy": "rotated" }, controller: undefined })
		expect(done).toHaveBeenCalledOnce()
	})

	it("prefills saved headers and allows clearing them with an empty object", async () => {
		mocks.settings.mockImplementation((key: string) => key === "openAiBaseUrl" ? "http://proxy/v1" : { X: "y" })
		const view = render(<ProviderAccessForm provider="openai" onDone={vi.fn()} onCancel={vi.fn()} />)
		views.push(view)
		await pause()
		expect(view.lastFrame()).toContain('{"X":"y"}')
		await input(view, "\t")
		await input(view, "\t")
		for (const _character of '{"X":"y"}') await input(view, "\u007f")
		await input(view, "{}")
		await input(view, "\r")
		expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ headers: {} }))
	})

	it.each(['{"X":1}', '[]', '{invalid'])('rejects invalid header input without persisting: %s', async (headers) => {
		const done = vi.fn()
		const view = render(<ProviderAccessForm provider="openai" onDone={done} onCancel={vi.fn()} />)
		views.push(view)
		await pause()
		await input(view, "\t")
		await input(view, "\t")
		await input(view, "\u007f")
		await input(view, "\u007f")
		await input(view, headers)
		await input(view, "\r")
		expect(mocks.save).not.toHaveBeenCalled()
		expect(done).not.toHaveBeenCalled()
		expect(view.lastFrame()).toContain(headers)
	})

	it("does not expose or submit OpenAI headers for other providers", async () => {
		mocks.settings.mockReturnValue("")
		const view = render(<ProviderAccessForm provider="anthropic" onDone={vi.fn()} onCancel={vi.fn()} />)
		views.push(view)
		await pause()
		expect(view.lastFrame()).not.toContain("Headers")
		await input(view, "\r")
		await input(view, "\r")
		expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ providerId: "anthropic", headers: undefined }))
	})
})
