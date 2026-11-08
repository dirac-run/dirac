import type { ModelInfo } from "@shared/api"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModelAutocomplete } from "./ModelAutocomplete"

vi.mock("../../../history/components/HistoryView/HistoryView", () => ({
	highlight: (results: { item: { id: string; html: string } }[]) => results.map(({ item }) => item),
}))

const models: Record<string, ModelInfo> = {
	"alpha-model": { supportsPromptCache: false },
	"beta-model": { supportsPromptCache: true },
}
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
const originalResizeObserver = globalThis.ResizeObserver
beforeAll(() => {
	globalThis.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } }
	Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
})
afterAll(() => {
	globalThis.ResizeObserver = originalResizeObserver
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
	else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})
afterEach(cleanup)

describe("compact ModelAutocomplete", () => {
	it("portals the picker without expanding the trigger and commits a clicked model only once", async () => {
		const onChange = vi.fn()
		const { container } = render(<ModelAutocomplete compact models={models} onChange={onChange} selectedModelId="alpha-model" />)
		const trigger = screen.getByRole("button", { name: "Model: alpha-model" })
		expect(trigger).toHaveClass("h-7", "w-fit", "max-w-[220px]")
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		fireEvent.click(trigger)
		const input = screen.getByRole("combobox")
		expect(input).toHaveFocus()
		expect(container.contains(screen.getByRole("listbox"))).toBe(false)
		fireEvent.change(input, { target: { value: "beta" } })
		fireEvent.blur(input)
		expect(onChange).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("option", { name: "beta-model" }))
		expect(onChange).toHaveBeenCalledExactlyOnceWith("beta-model", models["beta-model"])
		await waitFor(() => expect(trigger).toHaveFocus())
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
	})

	it("supports arrow navigation and Enter selection", async () => {
		const onChange = vi.fn()
		render(<ModelAutocomplete compact models={models} onChange={onChange} selectedModelId="alpha-model" />)
		const trigger = screen.getByRole("button")
		fireEvent.keyDown(trigger, { key: "ArrowDown" })
		const input = screen.getByRole("combobox")
		fireEvent.keyDown(input, { key: "ArrowDown" })
		fireEvent.keyDown(input, { key: "ArrowDown" })
		fireEvent.keyDown(input, { key: "ArrowUp" })
		fireEvent.keyDown(input, { key: "ArrowDown" })
		expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "beta-model" }).id)
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onChange).toHaveBeenCalledExactlyOnceWith("beta-model", models["beta-model"])
		await waitFor(() => expect(trigger).toHaveFocus())
	})

	it("discards a query on Escape and restores trigger focus", async () => {
		const onChange = vi.fn()
		render(<ModelAutocomplete compact models={models} onChange={onChange} selectedModelId="alpha-model" />)
		const trigger = screen.getByRole("button")
		fireEvent.click(trigger)
		const input = screen.getByRole("combobox")
		fireEvent.change(input, { target: { value: "uncommitted-custom-model" } })
		fireEvent.keyDown(input, { key: "Escape" })
		await waitFor(() => expect(trigger).toHaveFocus())
		expect(onChange).not.toHaveBeenCalled()
		fireEvent.click(trigger)
		expect(screen.getByRole("combobox")).toHaveValue("")
	})

	it.each([true, false])("honors allowCustomModelId=%s", (allowCustomModelId) => {
		const onChange = vi.fn()
		render(<ModelAutocomplete allowCustomModelId={allowCustomModelId} compact models={{}} onChange={onChange} selectedModelId={undefined} />)
		fireEvent.click(screen.getByRole("button"))
		const input = screen.getByRole("combobox")
		fireEvent.change(input, { target: { value: "private/custom-model" } })
		if (allowCustomModelId) expect(screen.getByRole("option", { name: "Use custom model: private/custom-model" })).toBeInTheDocument()
		else expect(screen.queryByRole("option")).not.toBeInTheDocument()
		fireEvent.keyDown(input, { key: "Enter" })
		if (allowCustomModelId) {
			expect(onChange).toHaveBeenCalledExactlyOnceWith("private/custom-model", undefined)
			expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		} else {
			expect(onChange).not.toHaveBeenCalled()
			expect(input).toBeInTheDocument()
		}
	})
})
