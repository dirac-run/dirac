import { Card, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { cn } from "@/lib/utils"
import { useAutoScroll } from "@/shared/hooks/useAutoScroll"
import React, { useEffect, useRef, useState } from "react"
import { ModularCardHeader } from "./components/ModularCardHeader"
import { ModularCardBody } from "./components/ModularCardBody"

interface ModularCardProps {
    card: Card
    isActive?: boolean
    onAction?: (value: string) => void
}

export const ModularCard: React.FC<ModularCardProps> = ({ card, isActive, onAction }) => {
    const [isCollapsed, setIsCollapsed] = useState(card.collapsed ?? false)
    const { status, body, autoScroll } = card
    const hasAutoCollapsed = useRef(false)

    useEffect(() => {
        if (!hasAutoCollapsed.current && isFinalStatus(status) && !card.do_not_auto_collapse) {
            setIsCollapsed(true)
            hasAutoCollapsed.current = true
        }
    }, [status])

    const scrollRef = useAutoScroll({
        dependency: body,
        enabled: autoScroll ?? status === CardStatus.RUNNING,
    })

    return (
        <div
            className={cn(
                "flex flex-col transition-all duration-200 overflow-hidden",
                isCollapsed ? "my-px bg-transparent" : "my-px rounded-md border border-foreground/10 bg-foreground/[0.02]",
            )}>
            <ModularCardHeader
                card={card}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
                onAction={onAction}
            />

            {!isCollapsed && (
                <div className="animate-in fade-in duration-200">
                    <ModularCardBody card={card} isActive={isActive} onAction={onAction} scrollRef={scrollRef} />
                </div>
            )}
        </div>
    )
}
