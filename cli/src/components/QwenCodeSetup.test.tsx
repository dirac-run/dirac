// biome-ignore lint/correctness/noUnusedImports: Vitest uses the classic JSX runtime.
import React from "react"
import { type Key } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import { QwenCodeSetup } from "./QwenCodeSetup"

const mocks = vi.hoisted(() => ({
	input: undefined as ((text: string, key: Key) => void) | undefined,
	exists: vi.fn(), save: vi.fn(), config: vi.fn(),
}))
vi.mock("ink", async (original) => ({ ...(await original<typeof import("ink")>()), useInput: (callback: typeof mocks.input) => { mocks.input = callback } }))
vi.mock("node:fs", () => ({ existsSync: mocks.exists }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => ({ getApiConfiguration: mocks.config }) } }))
vi.mock("../utils/provider-config", () => ({ saveProviderSetup: mocks.save }))
const views: ReturnType<typeof render>[] = []
const key = (name: string) => ({ [name]: true }) as unknown as Key
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("QWEN_HOME", "~/qwen-account")
	mocks.exists.mockReturnValue(true)
	mocks.config.mockReturnValue({})
	mocks.save.mockResolvedValue(undefined)
})
afterEach(() => { for (const view of views.splice(0)) view.unmount(); vi.unstubAllEnvs() })

describe("Qwen Code subscription setup", () => {
	it("shows official CLI sign-in guidance and saves automatic cache lookup without an API key", async () => {
		const complete = vi.fn()
		const view = render(<QwenCodeSetup onComplete={complete} onCancel={vi.fn()} />)
		views.push(view)
		expect(view.lastFrame()).toContain("/auth")
		expect(view.lastFrame()).toContain("Plus / Pro")
		expect(view.lastFrame()).toContain("subscription_credentials.json")
		mocks.input!("", key("return"))
		await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
		expect(mocks.exists).toHaveBeenCalledWith(path.join(os.homedir(), "qwen-account", "subscription_credentials.json"))
		expect(mocks.save).toHaveBeenCalledWith({ providerId: "qwen-code", qwenCodeOauthPath: "", controller: undefined })
	})

	it("reports a missing custom file without saving or claiming authentication succeeded", async () => {
		mocks.config.mockReturnValue({ qwenCodeOauthPath: "~/missing/subscription_credentials.json" })
		mocks.exists.mockReturnValue(false)
		const complete = vi.fn()
		const view = render(<QwenCodeSetup onComplete={complete} onCancel={vi.fn()} />)
		views.push(view)
		mocks.input!("", key("return"))
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Credentials not found"))
		expect(mocks.exists).toHaveBeenCalledWith(path.join(os.homedir(), "missing", "subscription_credentials.json"))
		expect(mocks.save).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})

	it("keeps persistence failures visible and allows cancellation", async () => {
		mocks.save.mockRejectedValue(new Error("disk full"))
		const cancel = vi.fn()
		const complete = vi.fn()
		const view = render(<QwenCodeSetup onComplete={complete} onCancel={cancel} />)
		views.push(view)
		mocks.input!("", key("return"))
		await vi.waitFor(() => expect(view.lastFrame()).toContain("disk full"))
		expect(complete).not.toHaveBeenCalled()
		mocks.input!("", key("escape"))
		expect(cancel).toHaveBeenCalledOnce()
	})
})
