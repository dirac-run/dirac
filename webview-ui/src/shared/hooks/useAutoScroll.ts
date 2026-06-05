import { useEffect, useRef } from "react"

interface UseAutoScrollOptions {
    dependency: any
    enabled: boolean
    delay?: number
}

export const useAutoScroll = ({ dependency, enabled, delay = 50 }: UseAutoScrollOptions) => {
    const scrollRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (enabled && scrollRef.current) {
            const scrollToBottom = () => {
                if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                }
            }

            // Batch scroll with next paint to avoid forced layout recalc
            const rafId = requestAnimationFrame(scrollToBottom)

            // Delayed scroll for slower renders
            const timer = setTimeout(scrollToBottom, delay)
            return () => {
                cancelAnimationFrame(rafId)
                clearTimeout(timer)
            }
        }
    }, [dependency, enabled, delay])

    return scrollRef
}
