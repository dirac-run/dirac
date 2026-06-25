import { DiracMessage, CardStatus } from "@shared/ExtensionMessage"
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ScrollBehavior } from "../types/chatTypes"

export function useScrollBehavior(
    messages: DiracMessage[],
    visibleMessages: DiracMessage[],
    renderedMessages: DiracMessage[],
    expandedRows: Record<string, boolean>,
    setExpandedRows: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
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
    const footerRef = useRef<HTMLDivElement>(null)
    const disableAutoScrollRef = useRef(false)
    const isAtBottomRef = useRef(false)
    const programmaticScrollRef = useRef(false)
    const scrollRafIdRef = useRef(0)


    // Debounce timer for at-bottom state changes to absorb scroll jitter
    const atBottomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Keep refs for scrollToMessage to avoid stale closures
    const messagesRef = useRef(messages)
    messagesRef.current = messages
    const visibleMessagesRef = useRef(visibleMessages)
    visibleMessagesRef.current = visibleMessages
    const renderedMessagesRef = useRef(renderedMessages)
    renderedMessagesRef.current = renderedMessages

    // State
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)
    const [isAtBottom, setIsAtBottom] = useState(false)
    const setIsAtBottomSynced = useCallback((value: SetStateAction<boolean>) => {
        const resolved = typeof value === "function" ? value(isAtBottomRef.current) : value
        isAtBottomRef.current = resolved
        setIsAtBottom(resolved)
    }, [])
    const [pendingScrollToMessage, setPendingScrollToMessage] = useState<number | null>(null)
    // Handler for when visible range changes in Virtuoso (kept for compatibility but not used for sticky)
    const handleRangeChanged = useCallback((_range: ListRange) => {
        // Range changed callback - we now use scroll position instead
        // but keep this for potential future use
    }, [])
    // Instant scroll to bottom using Virtuoso's scrollToIndex for precise positioning.
    const scrollToBottomNow = useCallback(() => {
        cancelAnimationFrame(scrollRafIdRef.current)
        scrollRafIdRef.current = requestAnimationFrame(() => {
            programmaticScrollRef.current = true
            const count = renderedMessagesRef.current.length
            if (count > 0) {
                virtuosoRef.current?.scrollToIndex({
                    index: count - 1,
                    align: "end",
                    behavior: "auto",
                })
            } else {
                footerRef.current?.scrollIntoView({ block: "end", behavior: "auto" })
            }
        })
    }, [])

    // Smooth scroll to bottom — for user-initiated actions (scroll-to-bottom button).
    const scrollToBottomSmooth = useCallback(() => {
        programmaticScrollRef.current = true
        const count = renderedMessagesRef.current.length
        if (count > 0) {
            virtuosoRef.current?.scrollToIndex({
                index: count - 1,
                align: "end",
                behavior: "smooth",
            })
        } else {
            footerRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
        }
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
            const rendered = renderedMessagesRef.current
            const targetMessage = msgs[messageIndex]
            if (!targetMessage) {
                setPendingScrollToMessage(null)
                return
            }

            const visMsgs = visibleMessagesRef.current
            const visibleIndex = visMsgs.findIndex((msg) => msg.id === targetMessage.id)
            if (visibleIndex === -1) {
                setPendingScrollToMessage(null)
                return
            }

            const renderedIndex = rendered.findIndex((msg) => msg.id === targetMessage.id)
            if (renderedIndex === -1) {
                setPendingScrollToMessage(null)
                return
            }

            setPendingScrollToMessage(null)
            disableAutoScrollRef.current = true

            // Use scrollToIndex - Virtuoso handles this more reliably than manual scrollTo
            requestAnimationFrame(() => {
                virtuosoRef.current?.scrollToIndex({
                    index: renderedIndex,
                    align: "start",
                    behavior: "smooth",
                })
            })
        },
        [], // No deps — reads from refs
    )

    // scroll when user toggles certain rows
    const toggleRowExpansion = useCallback(
        (id: string) => {
            const isCollapsing = expandedRows[id] ?? false
            const lastMessage = renderedMessages.at(-1)
            const isLast = lastMessage?.id === id
            const secondToLastMessage = renderedMessages.at(-2)
            const isSecondToLast = secondToLastMessage?.id === id

            const isLastCollapsedApiReq =
                isLast &&
                lastMessage?.content.type === "api_status" &&
                !expandedRows[lastMessage.id]

            setExpandedRows((prev) => ({
                ...prev,
                [id]: !prev[id],
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
        [renderedMessages, expandedRows, scrollToBottomAuto],
    )


    useEffect(() => {
        if (pendingScrollToMessage !== null) {
            scrollToMessage(pendingScrollToMessage)
        }
    }, [pendingScrollToMessage, renderedMessages, scrollToMessage])

    useEffect(() => {
        if (!messages?.length) {
            setShowScrollToBottom(false)
        }
    }, [messages.length])

    // Scroll to bottom when a card requires user input (approval buttons appear)
    const lastCardStatusRef = useRef<string | undefined>()
    useEffect(() => {
        const lastMessage = renderedMessages.at(-1)
        if (!lastMessage) return
        const currentStatus = lastMessage.content.type === "card" ? lastMessage.content.card.status : undefined
        if (currentStatus === CardStatus.WAITING_FOR_INPUT && lastCardStatusRef.current !== CardStatus.WAITING_FOR_INPUT) {
            disableAutoScrollRef.current = false
            scrollToBottomAuto()
        }
        lastCardStatusRef.current = currentStatus
    }, [renderedMessages, scrollToBottomAuto])

    return {
        virtuosoRef,
        footerRef,
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
        atBottomDebounceRef,
    }
}
