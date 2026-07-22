import { CardStatus, DiracMessage } from "@shared/ExtensionMessage"
import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react"
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
	const messageScrollRafIdRef = useRef(0)
	const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
	const beginProgrammaticScroll = useCallback((duration: number) => {
		programmaticScrollRef.current = true
		if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current)
		programmaticScrollTimerRef.current = setTimeout(() => {
			programmaticScrollRef.current = false
			programmaticScrollTimerRef.current = null
		}, duration)
	}, [])

	// Instant scroll to bottom using Virtuoso's scrollToIndex for precise positioning.
	const scrollToBottomNow = useCallback(() => {
		cancelAnimationFrame(scrollRafIdRef.current)
		scrollRafIdRef.current = requestAnimationFrame(() => {
			beginProgrammaticScroll(100)
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
	}, [beginProgrammaticScroll])

	// Smooth scrolling is reserved for explicit user actions. Streaming follows instantly.
	const scrollToBottomSmooth = useCallback(() => {
		const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
		beginProgrammaticScroll(prefersReducedMotion ? 100 : 500)
		const behavior: globalThis.ScrollBehavior = prefersReducedMotion ? "auto" : "smooth"
		const count = renderedMessagesRef.current.length
		if (count > 0) {
			virtuosoRef.current?.scrollToIndex({
				index: count - 1,
				align: "end",
				behavior,
			})
		} else {
			footerRef.current?.scrollIntoView({ block: "end", behavior })
		}
	}, [beginProgrammaticScroll])

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
			cancelAnimationFrame(messageScrollRafIdRef.current)
			messageScrollRafIdRef.current = requestAnimationFrame(() => {
				const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
				virtuosoRef.current?.scrollToIndex({
					index: renderedIndex,
					align: "start",
					behavior: prefersReducedMotion ? "auto" : "smooth",
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

			const isLastCollapsedApiReq = isLast && lastMessage?.content.type === "api_status" && !expandedRows[lastMessage.id]

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
				scrollToBottomAuto()
				return
			}
			if (isCollapsing && (isLast || isSecondToLast)) {
				if (isSecondToLast && !isLastCollapsedApiReq) return
				scrollToBottomAuto()
			}
			// Expanding stays anchored at the disclosure control.
		},
		[renderedMessages, expandedRows, scrollToBottomAuto, setExpandedRows],
	)

	useEffect(() => {
		if (pendingScrollToMessage !== null) {
			scrollToMessage(pendingScrollToMessage)
		}
	}, [pendingScrollToMessage, scrollToMessage])

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

	const taskId = messages.at(0)?.id
	useEffect(() => {
		disableAutoScrollRef.current = false
		isAtBottomRef.current = false
		programmaticScrollRef.current = false
		setIsAtBottom(false)
		setShowScrollToBottom(false)
		return () => {
			cancelAnimationFrame(scrollRafIdRef.current)
			cancelAnimationFrame(messageScrollRafIdRef.current)
			if (atBottomDebounceRef.current) {
				clearTimeout(atBottomDebounceRef.current)
				atBottomDebounceRef.current = null
			}
			if (programmaticScrollTimerRef.current) {
				clearTimeout(programmaticScrollTimerRef.current)
				programmaticScrollTimerRef.current = null
			}
		}
	}, [taskId])

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
