import { describe, expect, it, vi } from "vitest"
import { ANTHROPIC_MIN_THINKING_BUDGET } from "@shared/api"
import { AdaptiveThinkingInput } from "./AdaptiveThinkingToggle"

describe("AdaptiveThinkingInput", () => {
	it("defaults an unset toggle to adaptive thinking", () => {
		const input = AdaptiveThinkingInput({ onChange: vi.fn() })
		expect(input.props.checked).toBe(true)
		expect(input.props.disabled).toBe(false)
	})

	it("preserves an explicit off setting and toggles only zero/nonzero", () => {
		const onChange = vi.fn()
		const input = AdaptiveThinkingInput({ budgetTokens: 0, onChange })
		expect(input.props.checked).toBe(false)
		input.props.onChange({ target: { checked: true } })
		expect(onChange).toHaveBeenCalledWith(ANTHROPIC_MIN_THINKING_BUDGET)
		input.props.onChange({ target: { checked: false } })
		expect(onChange).toHaveBeenLastCalledWith(0)
	})

	it.each(["xhigh", "max"])("requires adaptive thinking at %s", (effort) => {
		const input = AdaptiveThinkingInput({ budgetTokens: 0, effort, onChange: vi.fn() })
		expect(input.props.checked).toBe(true)
		expect(input.props.disabled).toBe(true)
	})

	it("labels Sonnet's control as up-front thinking", () => {
		const input = AdaptiveThinkingInput({ supportsBetweenToolsThinking: true, onChange: vi.fn() })
		expect(input.props.children).toContain("Enable up-front thinking")
	})
})
