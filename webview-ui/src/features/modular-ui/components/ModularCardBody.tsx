import { Card } from "@shared/ExtensionMessage"
import { CARD_DECORATORS } from "../decorators"
import { CardContent } from "./CardContent"
import { CardActions } from "./CardActions"
import React, { useMemo } from "react"

interface ModularCardBodyProps {
    card: Card
    isActive?: boolean
    onAction?: (value: string) => void
    scrollRef?: React.RefObject<HTMLDivElement>
}

export const ModularCardBody: React.FC<ModularCardBodyProps> = ({ card, isActive, onAction, scrollRef }) => {
    const { body, maxHeight, renderType } = card
    const decorators = useMemo(
        () => CARD_DECORATORS.filter((d) => d.shouldApply(card)),
        [card]
    )

    // Find the first decorator that provides a body wrapper
    const bodyWrapper = decorators.find((d) => d.renderBodyWrapper)

    const bodyContent = body && (
        <div
            className="p-2 text-xs overflow-y-auto overflow-x-auto"
            ref={scrollRef}
            style={{ maxHeight: maxHeight ? `${maxHeight}px` : "320px" }}>
            <CardContent body={body} renderType={renderType} />
        </div>
    )

    return (
        <div className="flex flex-col border-t border-foreground/10">
            {body && (
                bodyWrapper
                    ? bodyWrapper.renderBodyWrapper!(card, bodyContent)
                    : bodyContent
            )}

            {decorators.map((d) => (
                <React.Fragment key={d.id}>{d.renderFooterExtra?.(card)}</React.Fragment>
            ))}

            <CardActions card={card} isActive={isActive} onAction={onAction} />
        </div>
    )
}
