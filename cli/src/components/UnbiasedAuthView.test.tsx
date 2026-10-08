import type { Key } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Vitest uses the classic JSX runtime.
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnbiasedAuthView } from "./UnbiasedAuthView"

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	poll: vi.fn(),
	apply: vi.fn(),
	flush: vi.fn(),
	setSecret: vi.fn(),
	setGlobalStateBatch: vi.fn(),
	input: undefined as ((input: string, key: Key) => void) | undefined,
}))
vi.mock("ink", async (original) => ({
	...(await original<typeof import("ink")>()),
	useInput: (input: (input: string, key: Key) => void) => {
		mocks.input = input
	},
}))
vi.mock("../context/StdinContext", () => ({ useStdinContext: () => ({ isRawModeSupported: true }) }))
vi.mock("@/integrations/unbiased/device-auth", () => ({
	startUnbiasedDeviceAuth: mocks.start,
	pollUnbiasedDeviceAuth: mocks.poll,
}))
vi.mock("@/shared/net", () => ({ fetch: vi.fn() }))
vi.mock("@/utils/env", () => ({ openExternal: vi.fn() }))
vi.mock("../utils/clipboard", () => ({ copyToClipboardNative: vi.fn() }))
vi.mock("../utils/provider-config", () => ({ applyProviderConfig: mocks.apply }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getSecretKey: () => "existing-private-key",
			setSecret: mocks.setSecret,
			setGlobalStateBatch: mocks.setGlobalStateBatch,
			flushPendingState: mocks.flush,
		}),
	},
}))

const token = { accessToken: "new-private-key", workloadName: "Dirac workload" }
const pause = () => new Promise((resolve) => setTimeout(resolve, 60))
const views: Array<ReturnType<typeof render>> = []
function mount(onComplete = vi.fn(), onCancel = vi.fn()) {
	const view = render(<UnbiasedAuthView onComplete={onComplete} onCancel={onCancel} />)
	views.push(view)
	return view
}

describe("interactive Unbiased sign-in", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.start.mockResolvedValue({ userCode: "ABCD-EFGH", verificationUri: "https://example.com/activate" })
		mocks.poll.mockResolvedValue(token)
		mocks.flush.mockResolvedValue(undefined)
		mocks.apply.mockResolvedValue(undefined)
	})
	afterEach(() => {
		for (const view of views.splice(0)) view.unmount()
	})

	it("signs in despite an existing key and saves the new key before applying configuration", async () => {
		let finish!: () => void
		mocks.apply.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const complete = vi.fn()
		const view = mount(complete)
		await pause()
		expect(mocks.start).toHaveBeenCalledOnce()
		expect(mocks.poll).toHaveBeenCalledOnce()
		expect(mocks.setSecret).toHaveBeenCalledWith("unbiasedApiKey", token.accessToken)
		expect(mocks.setGlobalStateBatch).toHaveBeenCalledWith({
			unbiasedOAuthApiKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			unbiasedOAuthWorkloadName: token.workloadName,
		})
		expect(mocks.flush).toHaveBeenCalledOnce()
		expect(view.lastFrame()).toContain("Saving Unbiased configuration")
		expect(complete).not.toHaveBeenCalled()
		finish()
		await pause()
		expect(complete).toHaveBeenCalledOnce()
	})

	it("preserves the saved key when a local configuration update fails", async () => {
		mocks.apply.mockRejectedValue(new Error("configuration rejected"))
		const view = mount()
		await pause()
		expect(view.lastFrame()).toContain("configuration rejected")
		expect(mocks.setSecret).toHaveBeenCalledWith("unbiasedApiKey", token.accessToken)
	})

	it("saves a late issued key after cancellation without switching providers", async () => {
		let issue!: (value: typeof token) => void
		mocks.poll.mockImplementation(
			() =>
				new Promise((resolve) => {
					issue = resolve
				}),
		)
		const complete = vi.fn()
		const cancel = vi.fn()
		mount(complete, cancel)
		await pause()
		mocks.input!("", { escape: true } as Key)
		expect(cancel).toHaveBeenCalledOnce()
		issue(token)
		await pause()
		expect(mocks.setSecret).toHaveBeenCalledWith("unbiasedApiKey", token.accessToken)
		expect(mocks.setGlobalStateBatch).toHaveBeenCalledWith(
			expect.objectContaining({ unbiasedOAuthWorkloadName: token.workloadName }),
		)
		expect(mocks.flush).toHaveBeenCalledOnce()
		expect(mocks.apply).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})
})
