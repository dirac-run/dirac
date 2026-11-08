import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelProviderSelection } from "@shared/api"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { MainModelSelection } from "./MainModelSelection"

const save = vi.hoisted(() => vi.fn())
vi.mock("./utils/useApiConfigurationHandlers", () => ({ useApiConfigurationHandlers: () => ({ handleFieldsChange: save }) }))
vi.mock("./ModelSelectionEditor", () => ({ ModelSelectionEditor: ({ selection, onChange }: { selection: ModelProviderSelection; onChange: (value: ModelProviderSelection) => void }) => <button onClick={() => onChange({ ...selection, modelId: "next-model", thinkingBudgetTokens: 0, reasoningEffort: "none" })}>Select</button> }))

describe("main selection bindings", () => {
	beforeEach(() => { save.mockClear(); useSettingsStore.setState({ apiConfiguration: { planModeApiProvider: "together", actModeApiProvider: "together", planModeTogetherModelId: "plan-old", actModeTogetherModelId: "act-old" } }) })
	it.each([true, false])("binds separate=%s without writing Utility", (separate) => {
		useSettingsStore.setState({ planActSeparateModelsSetting: separate })
		render(<MainModelSelection mode="plan" label="Plan" />)
		fireEvent.click(screen.getByText("Select"))
		const patch = save.mock.calls[0][0]
		expect(patch.planModeTogetherModelId).toBe("next-model")
		expect(patch.planModeThinkingBudgetTokens).toBe(0)
		expect(patch.planModeReasoningEffort).toBe("none")
		expect(patch.actModeTogetherModelId).toBe(separate ? undefined : "next-model")
		expect(patch).not.toHaveProperty("utilityModelSelection")
		expect(patch).not.toHaveProperty("openAiApiKey")
	})
})
