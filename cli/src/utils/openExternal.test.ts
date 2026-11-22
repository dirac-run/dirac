import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openExternal } from "@/utils/env"

const mocks = vi.hoisted(() => ({ hostOpen: vi.fn(), fallbackOpen: vi.fn() }))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { env: { openExternal: mocks.hostOpen } } }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn() } }))
vi.mock("open", () => ({ default: mocks.fallbackOpen }))

describe("openExternal", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.hostOpen.mockRejectedValue(new Error("Host opener unavailable"))
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("does not launch a fallback when the host opens the URL", async () => {
		mocks.hostOpen.mockResolvedValue({})
		await openExternal("https://example.com")
		expect(mocks.fallbackOpen).not.toHaveBeenCalled()
	})

	it("propagates fallback invocation failures", async () => {
		mocks.fallbackOpen.mockRejectedValue(new Error("No browser available"))
		await expect(openExternal("https://example.com")).rejects.toThrow("No browser available")
	})

	it.each([true, false])("does not wait for browser exit (already spawned: %s)", async (alreadySpawned) => {
		vi.useFakeTimers()
		const child = Object.assign(new EventEmitter(), { pid: alreadySpawned ? 123 : undefined })
		mocks.fallbackOpen.mockResolvedValue(child)
		const result = openExternal("https://example.com")
		await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1))
		if (!alreadySpawned) child.emit("spawn")
		await vi.advanceTimersByTimeAsync(1000)
		await expect(result).resolves.toBeUndefined()
		expect(child.listenerCount("spawn")).toBe(0)
		expect(child.listenerCount("error")).toBe(0)
		expect(child.listenerCount("close")).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["spawn error", "nonzero exit", "signal", "success"])("reports launcher outcome: %s", async (outcome) => {
		const child = new EventEmitter()
		mocks.fallbackOpen.mockResolvedValue(child)
		const result = openExternal("https://example.com")
		const assertion =
			outcome === "success"
				? expect(result).resolves.toBeUndefined()
				: expect(result).rejects.toThrow(outcome === "spawn error" ? "ENOENT" : "Browser launcher failed")
		await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1))
		if (outcome === "spawn error") child.emit("error", new Error("ENOENT"))
		else
			child.emit(
				"close",
				outcome === "success" ? 0 : outcome === "signal" ? null : 3,
				outcome === "signal" ? "SIGTERM" : null,
			)
		await assertion
		expect(mocks.fallbackOpen).toHaveBeenCalledWith("https://example.com")
	})

	it("normalizes Windows drive paths to file URLs without throwing disallowed scheme error", async () => {
		mocks.hostOpen.mockResolvedValue({})
		await openExternal("C:\\Users\\test\\AppData\\Roaming\\dirac\\cli.log")
		expect(mocks.hostOpen).toHaveBeenCalledWith({
			value: "file:///C:/Users/test/AppData/Roaming/dirac/cli.log",
		})
	})

	it("normalizes Windows forward-slash drive paths to file URLs", async () => {
		mocks.hostOpen.mockResolvedValue({})
		await openExternal("d:/projects/dirac/log.txt")
		expect(mocks.hostOpen).toHaveBeenCalledWith({
			value: "file:///d:/projects/dirac/log.txt",
		})
	})

	it("accepts file:// URLs directly", async () => {
		mocks.hostOpen.mockResolvedValue({})
		await openExternal("file:///C:/Users/test/file.txt")
		expect(mocks.hostOpen).toHaveBeenCalledWith({
			value: "file:///C:/Users/test/file.txt",
		})
	})

	it("blocks URLs with disallowed schemes", async () => {
		await expect(openExternal("javascript:alert(1)")).rejects.toThrow("Blocked URL with disallowed scheme 'javascript:'")
		await expect(openExternal("data:text/html,<b>hello</b>")).rejects.toThrow("Blocked URL with disallowed scheme 'data:'")
	})

	it("throws on invalid URLs", async () => {
		await expect(openExternal("http://")).rejects.toThrow("Invalid URL: http://")
	})
})
