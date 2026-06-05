import { ChevronDownIcon, ChevronRightIcon, Lightbulb } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ReasoningTimeline } from "../ReasoningTimeline"

interface ThinkingRowProps {
    showTitle: boolean
    reasoningContent?: string
    isVisible: boolean
    isExpanded: boolean
    onToggle?: () => void
    title?: string
    isStreaming?: boolean
    showChevron?: boolean
    onAskForUpdate?: () => void
}

export const ThinkingRow = memo(
    ({
        showTitle = false,
        reasoningContent,
        isVisible,
        isExpanded,
        onToggle,
        title = "Thinking",
        isStreaming = false,
        showChevron = true,
        onAskForUpdate,
    }: ThinkingRowProps) => {
        const [thinkingTime, setThinkingTime] = useState(0)

        useEffect(() => {
            let interval: NodeJS.Timeout | undefined
            if (isStreaming) {
                interval = setInterval(() => {
                    setThinkingTime((prev) => prev + 1)
                }, 1000)
            } else {
                setThinkingTime(0)
            }
            return () => {
                if (interval) clearInterval(interval)
            }
        }, [isStreaming])

        const scrollRef = useRef<HTMLDivElement>(null)
        const [canScrollUp, setCanScrollUp] = useState(false)
        const [canScrollDown, setCanScrollDown] = useState(false)

        const checkScrollable = useCallback(() => {
            if (scrollRef.current) {
                const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
                setCanScrollUp(scrollTop > 1)
                setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1)
            }
        }, [])

        // Auto-scroll to bottom during streaming
        useEffect(() => {
            if (scrollRef.current && isVisible) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            }
            checkScrollable()
        }, [reasoningContent, isVisible, checkScrollable])

        if (!isVisible) {
            return null
        }

        // Don't render anything if collapsed and no title (nothing to show)
        if (!isExpanded && !showTitle) {
            return null
        }

        const showAskForUpdate = isStreaming && thinkingTime >= 60 && onAskForUpdate

        return (
            <div className="border-l-2 border-link/30 pl-3 my-1 transition-all duration-300">
                {/* Header row */}
                {showTitle && (
                    <div
                        className={cn(
                            "flex items-center gap-1.5 px-1.5 py-1 -ml-0.5 rounded-sm transition-colors duration-150 select-none",
                            onToggle ? "cursor-pointer hover:bg-white/5" : "cursor-default",
                        )}
                        role="button"
                        tabIndex={0}
                        onClick={onToggle}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                onToggle?.()
                            }
                        }}>
                        {/* Thinking indicator */}
                        <span className="flex-shrink-0">
                            <Lightbulb
                                className={cn("size-3 transition-[color,filter,opacity] duration-700 ease-out", {
                                    "text-amber-300/80 animate-bulb-glow": isStreaming,
                                    "text-description/25": !isStreaming,
                                })}
                            />
                        </span>

                        {/* Title text */}
                        <span
                            className={cn("text-[13px] leading-none font-medium tracking-tight text-description", {
                                "animate-shimmer bg-linear-90 from-glow-plan via-description to-glow-plan bg-[length:200%_100%] bg-clip-text text-transparent":
                                    isStreaming,
                            })}>
                            {title}
                        </span>

                        {/* Elapsed time — inline, subtle */}
                        {isStreaming && thinkingTime > 0 && (
                            <span className="text-[11px] text-description/40 leading-none ml-0.5">
                                {formatTime(thinkingTime)}
                            </span>
                        )}

                        {/* Chevron */}
                        {showChevron && (
                            <span className="flex-shrink-0 ml-auto">
                                {isExpanded ? (
                                    <ChevronDownIcon className="size-3 text-description/60" />
                                ) : (
                                    <ChevronRightIcon className="size-3 text-description/60" />
                                )}
                            </span>
                        )}
                    </div>
                )}

                {/* Ask for update — inline after header */}
                {showAskForUpdate && (
                    <button
                        className="ml-1.5 mt-1 text-[11px] text-link/80 hover:text-link underline underline-offset-2 transition-colors duration-150"
                        onClick={(e) => {
                            e.stopPropagation()
                            onAskForUpdate()
                        }}>
                        Ask for update
                    </button>
                )}

                {/* Expanded reasoning content */}
                {isExpanded && (
                    <div className="relative mt-1 animate-in fade-in duration-200">
                        <div
                            className="flex max-h-[200px] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [direction:ltr]"
                            onScroll={checkScrollable}
                            ref={scrollRef}>
                            <div className="flex-1 pr-2 pb-1">
                                <ReasoningTimeline content={reasoningContent || ""} />
                            </div>
                        </div>
                        {canScrollUp && (
                            <div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-background to-transparent" />
                        )}
                        {canScrollDown && (
                            <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-background to-transparent" />
                        )}
                    </div>
                )}
            </div>
        )
    },
)

ThinkingRow.displayName = "ThinkingRow"

function formatTime(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`
    }
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}
