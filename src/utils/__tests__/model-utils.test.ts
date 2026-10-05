import { expect } from "chai"
import { describe, it } from "mocha"
import { parsePrice } from "../model-utils"

describe("parsePrice", () => {
	// Table-driven corpus for the unified model-refresh price helper.
	const cases: Array<[string | undefined, number | undefined, string]> = [
		["0.5", 500_000, "per-token price scales to per-million"],
		["0", 0, "explicit zero is a real free price — must not fall through to static defaults"],
		[undefined, undefined, "absent price stays absent"],
		["", undefined, "empty string is absent, not zero"],
		["garbage", undefined, "NaN input is rejected instead of leaking into ModelInfo"],
		["0.000001", 1, "fractional per-token pricing scales to whole per-million"],
	]

	for (const [input, expected, label] of cases) {
		it(label, () => {
			expect(parsePrice(input)).to.equal(expected)
		})
	}
})
