import { Text } from "ink"
import { render } from "ink-testing-library"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"

const inkMocks = vi.hoisted(() => ({
	resume: vi.fn(),
	setRawMode: vi.fn(),
}))

const authViewState = vi.hoisted(() => ({
	props: undefined as
		| {
				onNavigateToWelcome?: () => void
		  }
		| undefined,
}))

vi.mock("ink", async () => {
	const actual = await vi.importActual<typeof import("ink")>("ink")

	return {
		...actual,
		useStdin: () => ({
			stdin: { resume: inkMocks.resume },
			setRawMode: inkMocks.setRawMode,
			isRawModeSupported: true,
		}),
	}
})

vi.mock("ink-picture", () => ({
	TerminalInfoProvider: ({ children }: any) => children,
}))

vi.mock("./ChatView", () => ({
	ChatView: () => React.createElement(Text, null, "ChatView"),
}))

vi.mock("./TaskJsonView", () => ({
	TaskJsonView: () => React.createElement(Text, null, "TaskJsonView"),
}))

vi.mock("./HistoryView", () => ({
	HistoryView: () => React.createElement(Text, null, "HistoryView"),
}))

vi.mock("./ConfigView", () => ({
	ConfigView: () => React.createElement(Text, null, "ConfigView"),
}))

vi.mock("./AuthView", () => ({
	AuthView: (props: any) => {
		authViewState.props = props
		return React.createElement(Text, null, "AuthView")
	},
}))

vi.mock("../context/TaskContext", () => ({
	TaskContextProvider: ({ children }: any) => children,
}))

vi.mock("../hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({ columns: 80, rows: 24, resizeKey: 0 }),
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	})
}

describe("App auth navigation", () => {
	beforeEach(() => {
		authViewState.props = undefined
		inkMocks.resume.mockReset()
		inkMocks.setRawMode.mockReset()
	})

	afterEach(() => {
		setPlatform(originalPlatform)
	})

	it("keeps the session raw-mode claim alive across auth to welcome navigation on Windows", async () => {
		setPlatform("win32")

		const { lastFrame, unmount } = render(<App controller={{}} isRawModeSupported={true} view="auth" />)

		await Promise.resolve()

		expect(lastFrame()).toContain("AuthView")
		expect(authViewState.props?.onNavigateToWelcome).toBeTypeOf("function")
		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(1, true)
		expect(inkMocks.resume).toHaveBeenCalledTimes(1)
		expect(inkMocks.setRawMode.mock.calls.some(([isEnabled]) => isEnabled === false)).toBe(false)

		authViewState.props?.onNavigateToWelcome?.()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(lastFrame()).toContain("ChatView")
		expect(inkMocks.setRawMode.mock.calls.some(([isEnabled]) => isEnabled === false)).toBe(false)

		unmount()

		expect(inkMocks.setRawMode.mock.calls.some(([isEnabled]) => isEnabled === false)).toBe(true)
	})
})
