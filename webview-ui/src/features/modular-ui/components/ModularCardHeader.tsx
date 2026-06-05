import { Card, CardStatus } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dirac/common"
import { extractFirstPath } from "@shared/string"
import { cn } from "@/lib/utils"
import { Badge } from "@/shared/ui/badge"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react"
import { DynamicIcon } from "lucide-react/dynamic"
import { CARD_DECORATORS } from "../decorators"
import { CardStatusIcon } from "./CardStatusIcon"
import { getStatusTextColorClass } from "../utils/cardUtils"
import React, { useMemo } from "react"

interface ModularCardHeaderProps {
    card: Card
    isCollapsed: boolean
    onToggleCollapse: () => void
    onAction?: (value: string) => void
}

export const ModularCardHeader: React.FC<ModularCardHeaderProps> = ({ card, isCollapsed, onToggleCollapse, onAction }) => {
    const { header, icon, status } = card
    const filePath = extractFirstPath(header)
    const decorators = useMemo(
        () => CARD_DECORATORS.filter((d) => d.shouldApply(card)),
        [card]
    )
    const iconSizeClass = "size-3.5"

    return (
        <div
            className={cn(
                "flex items-center transition-colors cursor-pointer gap-1.5 text-[10px] leading-4",
                isCollapsed ? "px-2 py-0.5" : "px-3 py-1",
            )}
            onClick={onToggleCollapse}>
            <div className="flex-shrink-0 leading-none">
                {icon ? (
                    <DynamicIcon name={icon as any} className={cn(iconSizeClass, getStatusTextColorClass(status))} />
                ) : (
                    <CardStatusIcon status={status} className={iconSizeClass} />
                )}
            </div>

            <div className="font-medium flex-grow truncate" title={header}>
                <div className="flex items-center gap-1 min-w-0">
                    <span className="truncate">{header}</span>
                    {filePath && !decorators.some((d) => d.renderHeaderActions) && (
                        <button
                            className={cn(
                                "hover:bg-foreground/10 rounded-sm opacity-50 hover:opacity-100 transition-opacity p-1",
                            )}
                            onClick={(e) => {
                                e.stopPropagation()
                                FileServiceClient.openFileRelativePath(StringRequest.create({ value: filePath }))
                            }}
                            title={`Open ${filePath}`}>
                            <ExternalLinkIcon className="size-2.5" />
                        </button>
                    )}
                </div>
            </div>

            {decorators.map((d) => (
                <React.Fragment key={d.id}>{d.renderHeaderActions?.(card, onAction)}</React.Fragment>
            ))}

            <div className="flex items-center gap-2">
                {status === CardStatus.WAITING_FOR_INPUT && (
                    <Badge variant="warning" className={cn("px-1 py-0", "text-[10px] leading-4")}>
                        Awaiting Input
                    </Badge>
                )}
                <div className="flex-shrink-0 opacity-50 leading-none">
                    {isCollapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
                </div>
            </div>
        </div>
    )
}
