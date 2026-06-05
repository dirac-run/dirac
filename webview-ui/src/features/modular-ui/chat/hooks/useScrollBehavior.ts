import { DiracMessage, CardStatus } from "@shared/ExtensionMessage"
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ScrollBehavior } from "../types/chatTypes"

export function useScrollBehavior(
    messages: DiracMessage[],
    visibleMessages: DiracMessage[],
    groupedMessages: (DiracMessage | DiracMessage[])[],
    expandedRows: Record<number, boolean>,
    setExpandedRows: React.Dispatch<React.SetStateAction<Record<number, boolean>>>,
): ScrollBehavior & {
    showScrollToBottom: boolean
    setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>
    isAtBottom: boolean
    setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
    pendingScrollToMessage: number | null
    setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
    handleRangeChanged: (range: ListRange) => void
} {
    // Refs
    const virtuosoRef = useRef<VirtuosoHandle>(null)
    const disableAutoScrollRef = useRef(false)
    const isAtBottomRef = useRef(false)
    const programmaticScrollRef = useRef(false)
    const scrollRafIdRef = useRef(0)

    // Keep refs for scrollToMessage to avoid stale closures
    const messagesRef = useRef(messages)
    messagesRef.current = messages
    const visibleMessagesRef = useRef(visibleMessages)
    visibleMessagesRef.current = visibleMessages
    const groupedMessagesRef = useRef(groupedMessages)
    groupedMessagesRef.current = groupedMessages

    // State
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)
    const [isAtBottom, setIsAtBottom] = useState(false)
    const setIsAtBottomSynced = useCallback((value: SetStateAction<boolean>) => {
        const resolved = typeof value === "function" ? value(isAtBottomRef.current) : value
        isAtBottomRef.current = resolved
        setIsAtBottom(resolved)
    }, [])
    const [pendingScrollToMessage, setPendingScrollToMessage] = useState<number | null>(null)
    // Find all user feedback messages
    const userFeedbackMessages = useMemo(() => {
        // In the new protocol, we don't distinguish user feedback messages yet
        // This can be refactored once we add 'role' to DiracMessage if needed
        return []
    }, [])
    // Handler for when visible range changes in Virtuoso (kept for compatibility but not used for sticky)
    const handleRangeChanged = useCallback((_range: ListRange) => {
        // Range changed callback - we now use scroll position instead
        // but keep this for potential future use
    }, [])
    // Instant scroll to bottom, batched via rAF to avoid layout thrashing.
    // Only for programmatic "keep at bottom" scrolls — not user-initiated.
    const scrollToBottomNow = useCallback(() => {
        cancelAnimationFrame(scrollRafIdRef.current)
        scrollRafIdRef.current = requestAnimationFrame(() => {
            programmaticScrollRef.current = true
            virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
        })
    }, [])

    // Smooth scroll to bottom — for user-initiated actions (scroll-to-bottom button).
    const scrollToBottomSmooth = useCallback(() => {
        programmaticScrollRef.current = true
        virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" })
        setTimeout(() => {
            programmaticScrollRef.current = false
        }, 500)
    }, [])

    // Instant scroll to bottom (backward-compat alias)
    const scrollToBottomAuto = useCallback(() => {
        scrollToBottomNow()
    }, [scrollToBottomNow])

    const scrollToMessage = useCallback(
        (messageIndex: number) => {
            setPendingScrollToMessage(messageIndex)

            const msgs = messagesRef.current
            const grouped = groupedMessagesRef.current
            const targetMessage = msgs[messageIndex]
            if (!targetMessage) {
                setPendingScrollToMessage(null)
                return
            }

            const visMsgs = visibleMessagesRef.current
            const visibleIndex = visMsgs.findIndex((msg) => msg.ts === targetMessage.ts)
            if (visibleIndex === -1) {
                setPendingScrollToMessage(null)
                return
            }

            let groupIndex = -1

            for (let i = 0; i < grouped.length; i++) {
                const group = grouped[i]
                if (Array.isArray(group)) {
                    const messageInGroup = group.some((msg) => msg.ts === targetMessage.ts)
                    if (messageInGroup) {
                        groupIndex = i
                        break
                    }
                } else {
                    if (group.ts === targetMessage.ts) {
                        groupIndex = i
                        break
                    }
                }
            }

            if (groupIndex !== -1) {
                setPendingScrollToMessage(null)
                disableAutoScrollRef.current = true

                // Check if this is the first user feedback message (no sticky header would show when scrolling to it)
                const isFirstUserMessage =
                    groupIndex === 0

                // Use scrollToIndex - Virtuoso handles this more reliably than manual scrollTo
                requestAnimationFrame(() => {
                    virtuosoRef.current?.scrollToIndex({
                        index: groupIndex,
                        align: "start",
                        behavior: "smooth",
                    })
                })
            }
        },
        [], // No deps — reads from refs
    )

    // scroll when user toggles certain rows
    const toggleRowExpansion = useCallback(
        (ts: number) => {
            const isCollapsing = expandedRows[ts] ?? false
            const lastGroup = groupedMessages.at(-1)
            const isLast = Array.isArray(lastGroup) ? lastGroup[0].ts === ts : lastGroup?.ts === ts
            const secondToLastGroup = groupedMessages.at(-2)
            const isSecondToLast = Array.isArray(secondToLastGroup)
                ? secondToLastGroup[0].ts === ts
                : secondToLastGroup?.ts === ts

            const isLastCollapsedApiReq =
                isLast &&
                !Array.isArray(lastGroup) && // Make sure it's not a browser session group
                lastGroup?.content.type === "api_status" &&
                !expandedRows[lastGroup.ts]

            setExpandedRows((prev) => ({
                ...prev,
                [ts]: !prev[ts],
            }))

            // disable auto scroll when user expands row
            if (!isCollapsing) {
                disableAutoScrollRef.current = true
            }
            // Only scroll on collapse, never on expand - expanding should stay in place
            if (isCollapsing && isAtBottomRef.current) {
                const timer = setTimeout(() => {
                    scrollToBottomAuto()
                }, 0)
                return () => clearTimeout(timer)
            }
            if (isCollapsing && (isLast || isSecondToLast)) {
                if (isSecondToLast && !isLastCollapsedApiReq) {
                    return
                }
                const timer = setTimeout(() => {
                    scrollToBottomAuto()
                }, 0)
                return () => clearTimeout(timer)
            }
            // When expanding, don't scroll - let the element expand in place
        },
        [groupedMessages, expandedRows, scrollToBottomAuto],
    )


    useEffect(() => {
        if (pendingScrollToMessage !== null) {
            scrollToMessage(pendingScrollToMessage)
        }
    }, [pendingScrollToMessage, groupedMessages, scrollToMessage])

    useEffect(() => {
        if (!messages?.length) {
            setShowScrollToBottom(false)
        }
    }, [messages.length])

    // Scroll to bottom when a card requires user input (approval buttons appear)
    const lastCardStatusRef = useRef<string | undefined>()
    useEffect(() => {
        const lastGroup = groupedMessages.at(-1)
        if (!lastGroup) return
        const lastMsg = Array.isArray(lastGroup) ? lastGroup.at(-1) : lastGroup
        const currentStatus = lastMsg?.content.type === "card" ? lastMsg.content.card.status : undefined
        if (currentStatus === CardStatus.WAITING_FOR_INPUT && lastCardStatusRef.current !== CardStatus.WAITING_FOR_INPUT) {
            disableAutoScrollRef.current = false
            scrollToBottomAuto()
        }
        lastCardStatusRef.current = currentStatus
    }, [groupedMessages, scrollToBottomAuto])

    return {
        virtuosoRef,
        disableAutoScrollRef,
        scrollToBottomSmooth,
        scrollToBottomAuto,
        scrollToBottomNow,
        scrollToMessage,
        programmaticScrollRef,
        toggleRowExpansion,
        showScrollToBottom,
        setShowScrollToBottom,
        isAtBottom,
        isAtBottomRef,
        setIsAtBottom: setIsAtBottomSynced,
        pendingScrollToMessage,
        setPendingScrollToMessage,
        handleRangeChanged,
    }
}
