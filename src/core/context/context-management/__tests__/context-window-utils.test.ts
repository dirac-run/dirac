import { describe, it } from "mocha"
import "should"
import type { ApiHandler } from "@core/api"
import { getContextWindowInfo } from "../context-window-utils"

// info.contextWindow of 0 means "not provided" — it must fall back to 256k,
// the same as an absent value, which is why this line stays `||`.
describe("getContextWindowInfo", () => {
	const apiWith = (contextWindow: number | undefined) =>
		({ getModel: () => ({ info: { contextWindow } }) }) as unknown as ApiHandler

	it("uses the 256k fallback when the model reports a contextWindow of 0", () => {
		const info = getContextWindowInfo(apiWith(0))
		info.contextWindow.should.equal(256_000)
	})

	it("uses the 256k fallback when the model contextWindow is undefined", () => {
		const info = getContextWindowInfo(apiWith(undefined))
		info.contextWindow.should.equal(256_000)
	})

	it("uses a real contextWindow value and derives maxAllowedSize from it", () => {
		const info = getContextWindowInfo(apiWith(128_000))
		info.contextWindow.should.equal(128_000)
		const expected = Math.min(1_000_000, Math.max(128_000 - 40_000, 128_000 * 0.8))
		info.maxAllowedSize.should.equal(expected)
	})
})
