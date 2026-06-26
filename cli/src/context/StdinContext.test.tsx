import { Text } from "ink"
import { render } from "ink-testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StdinProvider } from "./StdinContext"
// biome-ignore lint/correctness/noUnusedImports: React is needed for JSX transform
import React from "react"

const inkMocks = vi.hoisted(() => ({
	resume: vi.fn(),
	setRawMode: vi.fn(),
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

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	})
}

describe("StdinProvider", () => {
	beforeEach(() => {
		inkMocks.resume.mockReset()
		inkMocks.setRawMode.mockReset()
	})

	afterEach(() => {
		setPlatform(originalPlatform)
	})

	it("keeps raw mode enabled for the full provider lifetime on Windows", () => {
		setPlatform("win32")

		const { unmount } = render(
			<StdinProvider isRawModeSupported={true}>
				<Text>child</Text>
			</StdinProvider>,
		)

		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(1, true)
		expect(inkMocks.resume).toHaveBeenCalledTimes(1)

		unmount()

		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(2, false)
	})

	it("does not force raw mode when raw mode is unsupported", () => {
		setPlatform("win32")

		const { unmount } = render(
			<StdinProvider isRawModeSupported={false}>
				<Text>child</Text>
			</StdinProvider>,
		)

		expect(inkMocks.setRawMode).not.toHaveBeenCalled()
		expect(inkMocks.resume).not.toHaveBeenCalled()

		unmount()
		expect(inkMocks.setRawMode).not.toHaveBeenCalled()
	})

	it("does not keep a session raw-mode claim alive on non-Windows platforms", () => {
		setPlatform("linux")

		const { unmount } = render(
			<StdinProvider isRawModeSupported={true}>
				<Text>child</Text>
			</StdinProvider>,
		)

		expect(inkMocks.setRawMode).not.toHaveBeenCalled()
		expect(inkMocks.resume).not.toHaveBeenCalled()

		unmount()
		expect(inkMocks.setRawMode).not.toHaveBeenCalled()
	})

	it("balances the session raw-mode claim across remount cycles on Windows", () => {
		setPlatform("win32")

		const firstRender = render(
			<StdinProvider isRawModeSupported={true}>
				<Text>first mount</Text>
			</StdinProvider>,
		)

		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(1, true)

		firstRender.unmount()
		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(2, false)

		const secondRender = render(
			<StdinProvider isRawModeSupported={true}>
				<Text>second mount</Text>
			</StdinProvider>,
		)

		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(3, true)

		secondRender.unmount()
		expect(inkMocks.setRawMode).toHaveBeenNthCalledWith(4, false)
	})
})
