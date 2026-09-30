/**
 * Regression tests for the spontaneous upward-scroll RCA (implementation plan:
 * .devin/plan-review/plan-review-fast-20260930T160918Z/implementation-plan.md).
 * Objective: the DOM scroller is the sole at-bottom authority, bottom-seeking
 * writes anchor to the exact scrollHeight, and deliberate gestures still
 * release the pin — including inside the bottom band.
 */

import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { useScrollBehavior } from "./useScrollBehavior"

const SCROLL_HEIGHT = 4000
const CLIENT_HEIGHT = 800
const AT_BOTTOM_DISTANCE = SCROLL_HEIGHT - CLIENT_HEIGHT // scrollTop at exact bottom: 3200

function makeScroller() {
	const scroller = document.createElement("div")
	Object.defineProperty(scroller, "scrollHeight", { value: SCROLL_HEIGHT, configurable: true })
	Object.defineProperty(scroller, "clientHeight", { value: CLIENT_HEIGHT, configurable: true })
	const scrollToSpy = vi.fn() // jsdom has no Element.scrollTo — stub it on the instance
	Object.defineProperty(scroller, "scrollTo", { value: scrollToSpy, configurable: true })
	return { scroller, scrollToSpy }
}

function dispatchScroll(scroller: HTMLElement, scrollTop: number) {
	scroller.scrollTop = scrollTop // jsdom stores scrollTop as a plain property
	act(() => {
		scroller.dispatchEvent(new Event("scroll"))
	})
}

function setup() {
	const messages: DiracMessage[] = [{ id: "task", ts: 0, content: { type: DiracMessageType.MARKDOWN, content: "task" } }]
	const setExpandedRows: React.Dispatch<React.SetStateAction<Record<string, boolean>>> = () => {}
	const { result } = renderHook(() => useScrollBehavior(messages, ["task"], ["task"], {}, setExpandedRows))
	const { scroller, scrollToSpy } = makeScroller()
	act(() => {
		result.current.setScrollerEl(scroller)
	})
	return { result, scroller, scrollToSpy }
}

describe("useScrollBehavior", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("drives at-bottom state and the button from DOM scroll events", () => {
		const { result, scroller } = setup()
		act(() => {
			result.current.isFollowingRef.current = false
		})

		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 80) // distance 80 > 64px threshold
		expect(result.current.showScrollToBottom).toBe(true)
		expect(result.current.isAtBottomRef.current).toBe(false)

		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 65) // boundary: just outside the band
		expect(result.current.showScrollToBottom).toBe(true)
		expect(result.current.isAtBottomRef.current).toBe(false)

		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 64) // boundary: inside the band re-arms following
		expect(result.current.showScrollToBottom).toBe(false)
		expect(result.current.isAtBottomRef.current).toBe(true)
		expect(result.current.isFollowingRef.current).toBe(true)
	})

	it("shows the scroll-to-bottom button even while isFollowingRef is stuck true", () => {
		const { result, scroller } = setup()
		expect(result.current.isFollowingRef.current).toBe(true) // the stuck bug state

		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 200)
		expect(result.current.showScrollToBottom).toBe(true)
		expect(result.current.isAtBottomRef.current).toBe(false)
	})

	it("anchors to the exact scrollHeight on a list height change while following", () => {
		const { result, scrollToSpy } = setup()
		act(() => {
			result.current.handleListHeightChanged(3900)
		})
		act(() => {
			vi.runAllTimers()
		})
		expect(scrollToSpy).toHaveBeenCalledTimes(1)
		expect(scrollToSpy).toHaveBeenCalledWith({ top: SCROLL_HEIGHT })
	})

	it("drops a scheduled smooth bottom-seek when a gesture releases the pin first", () => {
		const { result, scroller, scrollToSpy } = setup()
		act(() => {
			result.current.scrollToBottomSmooth()
		})
		act(() => {
			result.current.handleScrollWheel({ deltaY: -10, currentTarget: scroller } as React.WheelEvent)
		})
		act(() => {
			vi.runAllTimers()
		})
		expect(scrollToSpy).not.toHaveBeenCalled()
	})

	it("still fires scrollToIndex for scrollToTop while not following", () => {
		const { result } = setup()
		const scrollToIndex = vi.fn()
		const virtuosoRef = result.current.virtuosoRef as unknown as React.MutableRefObject<unknown>
		virtuosoRef.current = { scrollToIndex }

		act(() => {
			result.current.scrollToTop()
		})
		expect(result.current.isFollowingRef.current).toBe(false)

		act(() => {
			vi.runAllTimers()
		})
		expect(scrollToIndex).toHaveBeenCalledTimes(1)
		expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "start", behavior: "smooth" })
	})

	it("recomputes at-bottom state on a geometry change with no scroll event", () => {
		const { result, scroller, scrollToSpy } = setup()
		act(() => {
			result.current.isFollowingRef.current = false
		})
		scroller.scrollTop = AT_BOTTOM_DISTANCE - 200

		act(() => {
			result.current.handleListHeightChanged(3900)
		})
		act(() => {
			vi.runAllTimers()
		})
		expect(scrollToSpy).not.toHaveBeenCalled()
		expect(result.current.showScrollToBottom).toBe(true)
		expect(result.current.isAtBottomRef.current).toBe(false)
	})

	it("keeps the pin released when a wheel-up lands inside the bottom band", () => {
		const { result, scroller } = setup()
		dispatchScroll(scroller, AT_BOTTOM_DISTANCE) // distance 0 — at bottom
		expect(result.current.isAtBottomRef.current).toBe(true)

		act(() => {
			result.current.handleScrollWheel({ deltaY: -10, currentTarget: scroller } as React.WheelEvent)
		})
		expect(result.current.isFollowingRef.current).toBe(false)

		// Scroll events inside the band must not re-arm following (edge-triggered).
		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 30)
		expect(result.current.isFollowingRef.current).toBe(false)
		dispatchScroll(scroller, AT_BOTTOM_DISTANCE - 50)
		expect(result.current.isFollowingRef.current).toBe(false)
	})
})
