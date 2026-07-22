import { Card, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
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
	contentId: string
	isCollapsed: boolean
	onToggleCollapse: () => void
	onAction?: (value: string) => void
}

export const ModularCardHeader: React.FC<ModularCardHeaderProps> = ({
	card,
	contentId,
	isCollapsed,
	onToggleCollapse,
	onAction,
}) => {
	const { header, icon, status } = card
	const isTerminal = isFinalStatus(status)
	const filePath = extractFirstPath(header)
	const decorators = useMemo(() => CARD_DECORATORS.filter((decorator) => decorator.shouldApply(card)), [card])
	const iconSizeClass = "size-3.5"

	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-1 text-[10px] leading-4",
				isCollapsed ? "px-1 py-0.5" : "px-2 py-1",
				isTerminal && "opacity-70",
			)}>
			<button
				aria-controls={contentId}
				aria-expanded={!isCollapsed}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm bg-transparent px-1 text-left text-inherit hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
				onClick={onToggleCollapse}
				title={isCollapsed ? `Expand ${header}` : `Collapse ${header}`}
				type="button">
				<span className="shrink-0 leading-none" aria-hidden="true">
					{icon ? (
						<DynamicIcon name={icon as any} className={cn(iconSizeClass, getStatusTextColorClass(status))} />
					) : (
						<CardStatusIcon status={status} className={iconSizeClass} />
					)}
				</span>

				<span className={cn("min-w-0 flex-1 font-medium", isCollapsed ? "truncate" : "break-all whitespace-normal")}>
					{header}
				</span>

				{status === CardStatus.WAITING_FOR_INPUT && (
					<Badge variant="warning" className="shrink-0 px-1 py-0 text-[10px] leading-4">
						Awaiting Input
					</Badge>
				)}

				<span className="shrink-0 opacity-60 leading-none" aria-hidden="true">
					{isCollapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
				</span>
			</button>

			{filePath && !decorators.some((decorator) => decorator.renderHeaderActions) && (
				<button
					aria-label={`Open ${filePath}`}
					className="shrink-0 rounded-sm p-1 opacity-60 transition-opacity hover:bg-foreground/10 hover:opacity-100 focus-visible:opacity-100"
					onClick={() => FileServiceClient.openFileRelativePath(StringRequest.create({ value: filePath }))}
					title={`Open ${filePath}`}
					type="button">
					<ExternalLinkIcon className="size-2.5" />
				</button>
			)}

			{decorators.map((decorator) => (
				<React.Fragment key={decorator.id}>{decorator.renderHeaderActions?.(card, onAction)}</React.Fragment>
			))}
		</div>
	)
}
