import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it } from "vitest"
import { normalizeApiConfiguration } from "../providerUtils"

describe.each(["plan", "act"] as const)("Qwen Subscription model normalization in %s mode", (mode) => {
	it("preserves an account model ID without substituting static model metadata", () => {
		const configuration: ApiConfiguration = {
			planModeApiProvider: "qwen-code",
			actModeApiProvider: "qwen-code",
			planModeApiModelId: mode === "plan" ? "account-model" : "other-mode",
			actModeApiModelId: mode === "act" ? "account-model" : "other-mode",
		}
		expect(normalizeApiConfiguration(configuration, mode)).toEqual({
			selectedProvider: "qwen-code",
			selectedModelId: "account-model",
			selectedModelInfo: { supportsPromptCache: false },
		})
	})
})
