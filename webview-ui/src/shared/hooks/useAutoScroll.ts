import { useCallback, useLayoutEffect, useRef } from "react"

interface UseAutoScrollOptions {
	dependency: unknown
	enabled: boolean
	bottomThreshold?: number
}

/**
 * Keeps a nested streaming region pinned only while the user is already following
 * its output. A user who scrolls up is never pulled back to the bottom.
 */
export const useAutoScroll = ({ dependency, enabled, bottomThreshold = 24 }: UseAutoScrollOptions) => {
	const scrollElementRef = useRef<HTMLDivElement | null>(null)
	const removeScrollListenerRef = useRef<(() => void) | null>(null)
	const shouldFollowRef = useRef(true)
	const frameRef = useRef<number | null>(null)

	const scrollRef = useCallback(
		(element: HTMLDivElement | null) => {
			removeScrollListenerRef.current?.()
			removeScrollListenerRef.current = null
			scrollElementRef.current = element
			if (!element) return

			const updateFollowState = () => {
				const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
				shouldFollowRef.current = distanceFromBottom <= bottomThreshold
			}

			// Preserve whether this card was following before virtualization or a
			// disclosure toggle detached its scroll element.
			if (enabled && shouldFollowRef.current) element.scrollTop = element.scrollHeight
			else updateFollowState()
			element.addEventListener("scroll", updateFollowState, { passive: true })
			removeScrollListenerRef.current = () => element.removeEventListener("scroll", updateFollowState)
		},
		[bottomThreshold, enabled],
	)

	useLayoutEffect(() => {
		if (!enabled || !shouldFollowRef.current || !scrollElementRef.current) return
		if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
		frameRef.current = requestAnimationFrame(() => {
			const element = scrollElementRef.current
			if (element && shouldFollowRef.current) element.scrollTop = element.scrollHeight
			frameRef.current = null
		})
		return () => {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current)
				frameRef.current = null
			}
		}
	}, [dependency, enabled])

	useLayoutEffect(
		() => () => {
			removeScrollListenerRef.current?.()
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
		},
		[],
	)

	return scrollRef
}
