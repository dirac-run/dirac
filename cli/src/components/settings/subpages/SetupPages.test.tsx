// biome-ignore lint/correctness/noUnusedImports: Vitest uses the classic JSX runtime.
import React from "react"
import type { Key } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BedrockSetupPage } from "./SetupPages"
import { BedrockSetup } from "../../BedrockSetup"

const mocks = vi.hoisted(() => ({ settings: vi.fn(), input: undefined as ((text: string, key: Key) => void) | undefined }))
// Capture only the active hook: the wizard and credential child both subscribe.
vi.mock("ink", async (original) => ({
	...(await original<typeof import("ink")>()),
	useInput: (handler: typeof mocks.input, options?: { isActive?: boolean }) => {
		if (options?.isActive !== false) mocks.input = handler
	},
}))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => ({ getSystemDefaultSettingsKey: mocks.settings }) } }))
vi.mock("../../BedrockCustomModelFlow", () => ({ BedrockCustomModelFlow: () => null }))

const views: ReturnType<typeof render>[] = []
const pause = () => new Promise((resolve) => setTimeout(resolve, 60))
async function input(_view: ReturnType<typeof render>, text: string) {
	const keys: Record<string, Partial<Key>> = { "\r": { return: true }, "\u007f": { backspace: true }, "\u001b": { escape: true }, "\u001b[B": { downArrow: true } }
	mocks.input!(keys[text] ? "" : text, (keys[text] ?? {}) as Key)
	await pause()
}
async function reachEndpoint(view: ReturnType<typeof render>) {
	await pause()
	await input(view, "\r") // AWS profile
	await input(view, "work")
	await input(view, "\r")
	await input(view, "us-east-1")
	await input(view, "\r")
	expect(view.lastFrame()).toContain("Bedrock endpoint URL")
}
async function finish(view: ReturnType<typeof render>) {
	await input(view, "\r") // Endpoint -> options
	await input(view, "\u001b[B") // Done
	await input(view, "\r")
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.settings.mockReturnValue("https://old")
})
afterEach(() => { for (const view of views.splice(0)) view.unmount() })

describe("Bedrock settings setup routing", () => {
	it("prefills the saved endpoint and carries it through the setup completion", async () => {
		const complete = vi.fn()
		const view = render(<BedrockSetupPage isActive onComplete={complete} onCancel={vi.fn()} />)
		views.push(view)
		await reachEndpoint(view)
		expect(mocks.settings).toHaveBeenCalledWith("awsBedrockEndpoint")
		expect(view.lastFrame()).toContain("https://old")
		await finish(view)
		expect(complete).toHaveBeenCalledExactlyOnceWith({ awsAuthentication: "profile", awsProfile: "work", awsRegion: "us-east-1", awsUseCrossRegionInference: false, awsBedrockEndpoint: "https://old" })
	})

	it.each(["https://new", ""])("saves a changed or explicitly cleared endpoint: %j", async (endpoint) => {
		const complete = vi.fn()
		const view = render(<BedrockSetupPage isActive onComplete={complete} onCancel={vi.fn()} />)
		views.push(view)
		await reachEndpoint(view)
		for (const _character of "https://old") await input(view, "\u007f")
		if (endpoint) await input(view, endpoint)
		await input(view, "\r")
		await input(view, "\u001b") // Options -> endpoint, retaining draft
		expect(view.lastFrame()).toContain("Bedrock endpoint URL")
		if (endpoint) expect(view.lastFrame()).toContain(endpoint)
		await input(view, "\u001b") // Endpoint -> region
		expect(view.lastFrame()).toContain("AWS Region")
		await input(view, "\r")
		await finish(view)
		expect(complete).toHaveBeenCalledWith(expect.objectContaining({ awsBedrockEndpoint: endpoint }))
	})

	it("leaves existing setup untouched when onboarding supplies no endpoint and the field stays empty", async () => {
		const complete = vi.fn()
		const view = render(<BedrockSetup isActive onComplete={complete} onCancel={vi.fn()} />)
		views.push(view)
		await reachEndpoint(view)
		await finish(view)
		expect(complete).toHaveBeenCalledOnce()
		expect(complete.mock.calls[0][0]).not.toHaveProperty("awsBedrockEndpoint")
	})
})
