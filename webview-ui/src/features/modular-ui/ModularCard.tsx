import { Card, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import React, { useLayoutEffect } from "react"
import { useChatStore } from "@/features/chat/store/chatStore"
import { cn } from "@/lib/utils"
import { useAutoScroll } from "@/shared/hooks/useAutoScroll"
import { ModularCardBody } from "./components/ModularCardBody"
import { ModularCardHeader } from "./components/ModularCardHeader"

interface ModularCardProps {
	card: Card
	isActive?: boolean
	onAction?: (value: string) => void
}

const initialCollapsedState = (card: Card) => card.collapsed ?? (isFinalStatus(card.status) && !card.do_not_auto_collapse)

export const ModularCard: React.FC<ModularCardProps> = ({ card, isActive, onAction }) => {
	const storedCollapsed = useChatStore((state) => state.cardCollapsedStates[card.id])
	const userToggled = useChatStore((state) => state.cardUserToggledStates[card.id] ?? false)
	const setCardCollapsedState = useChatStore((state) => state.setCardCollapsedState)
	const terminalAutoCollapse = isFinalStatus(card.status) && !card.do_not_auto_collapse && !userToggled
	const protocolOrAutomaticState = card.collapsed ?? (terminalAutoCollapse ? true : undefined)
	const isCollapsed = userToggled
		? (storedCollapsed ?? initialCollapsedState(card))
		: (protocolOrAutomaticState ?? storedCollapsed ?? initialCollapsedState(card))
	const { status, body, autoScroll } = card
	const bodyId = `card-body-${card.id}`

	// Persist protocol/default state before paint so virtualization remounts cannot
	// restore an obsolete disclosure value. A user choice remains authoritative
	// until the task changes.
	useLayoutEffect(() => {
		if (userToggled || protocolOrAutomaticState === undefined) return
		if (storedCollapsed !== protocolOrAutomaticState) {
			setCardCollapsedState(card.id, protocolOrAutomaticState, false)
		}
	}, [card.id, protocolOrAutomaticState, setCardCollapsedState, storedCollapsed, userToggled])

	const scrollRef = useAutoScroll({
		dependency: body,
		enabled: autoScroll ?? status === CardStatus.RUNNING,
	})

	const toggleCollapsed = () => {
		setCardCollapsedState(card.id, !isCollapsed, true)
	}

	return (
		<div
			className={cn(
				"my-px flex flex-col overflow-hidden",
				isCollapsed
					? "bg-transparent"
					: "rounded-md border border-foreground/10 bg-foreground/[0.025] shadow-[0_1px_2px_color-mix(in_srgb,var(--vscode-widget-shadow)_18%,transparent)]",
			)}>
			<ModularCardHeader
				card={card}
				contentId={bodyId}
				isCollapsed={isCollapsed}
				onAction={onAction}
				onToggleCollapse={toggleCollapsed}
			/>

			{!isCollapsed && (
				<div id={bodyId}>
					<ModularCardBody card={card} isActive={isActive} onAction={onAction} scrollRef={scrollRef} />
				</div>
			)}
		</div>
	)
}
