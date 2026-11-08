import { Card, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dirac/common"
import { extractFirstPath } from "@shared/string"
import { readSubagentCardData } from "@shared/subagents"
import { readTaskletPresentation, type TaskletPresentationStatus } from "@shared/taskletPresentation"
import { formatTaskletLabel } from "@shared/taskletLabel"
import { TASKLET_RECEIPT_OUTCOMES, taskletReceiptTitle } from "@shared/taskletReceipt"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react"
import { DynamicIcon } from "lucide-react/dynamic"
import React, { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { Badge } from "@/shared/ui/badge"
import { CARD_DECORATORS } from "../decorators"
import { getStatusTextColorClass } from "../utils/cardUtils"
import { ArchitectureNavigation } from "./ArchitectureNavigation"
import { CardStatusIcon } from "./CardStatusIcon"
import { SubagentAvatar } from "./SubagentAvatar"
import { RECEIPT_TONE_CLASSES, TaskletReceiptBadge } from "./TaskletReceiptBody"

interface ModularCardHeaderProps {
	card: Card
	contentId: string
	isCollapsed: boolean
	onToggleCollapse: () => void
	onAction?: (value: string) => void
}

const TASKLET_STATUS_PRESENTATION: Record<TaskletPresentationStatus, { label: string; status: CardStatus }> = {
	running: { label: "Running", status: CardStatus.RUNNING },
	waiting: { label: "Waiting for parent", status: CardStatus.WAITING_FOR_INPUT },
	completed: { label: "Completed", status: CardStatus.SUCCESS },
	failed: { label: "Failed", status: CardStatus.ERROR },
	interrupted: { label: "Interrupted", status: CardStatus.CANCELLED },
}

export const ModularCardHeader: React.FC<ModularCardHeaderProps> = ({
	card,
	contentId,
	isCollapsed,
	onToggleCollapse,
	onAction,
}) => {
	const tasklet = readTaskletPresentation(card)
	const isTaskletCard = card.rawInput?.isTasklet === true
	const taskletStatus = tasklet ? TASKLET_STATUS_PRESENTATION[tasklet.status] : undefined
	const receipt = card.taskletReceipt
	const header = receipt ? taskletReceiptTitle(receipt) : (tasklet ? formatTaskletLabel(tasklet) : card.header)
	const status = taskletStatus?.status ?? (isTaskletCard ? CardStatus.PENDING : card.status)
	const isTerminal = isFinalStatus(status)
	const subagentData = isTaskletCard ? undefined : readSubagentCardData(card)
	const isAgentCard = tasklet !== undefined || subagentData !== undefined
	const startTime = tasklet?.createdAt ?? card.startTime
	const [currentTime, setCurrentTime] = useState(() => Date.now())
	const filePath = getCardFilePath(card)
	const decorators = useMemo(
		() => (isTaskletCard || receipt ? [] : CARD_DECORATORS.filter((decorator) => decorator.shouldApply(card))),
		[card, isTaskletCard, receipt],
	)
	const iconSizeClass = "size-3.5"
	const elapsedTime = getSubagentCardElapsedTime(card, currentTime)

	useEffect(() => {
		if (!isAgentCard || isTerminal || startTime === undefined) return

		setCurrentTime(Date.now())
		const timer = setInterval(() => setCurrentTime(Date.now()), 1_000)
		return () => clearInterval(timer)
	}, [startTime, isAgentCard, isTerminal])

	return (
		<div
			className={cn(
				"modular-card-header flex min-w-0 items-center gap-1.5 text-base leading-5",
				isCollapsed ? "px-1.5 py-1" : "px-2.5 py-1.5",
				isTerminal && "opacity-70",
			)}
			data-terminal={isTerminal}>
			<button
				aria-controls={contentId}
				aria-expanded={!isCollapsed}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm bg-transparent px-1 text-left text-inherit hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
				onClick={onToggleCollapse}
				title={isCollapsed ? `Expand ${header}` : `Collapse ${header}`}
				type="button">
				{tasklet && <SubagentAvatar agentId={tasklet.taskletId} agentName={tasklet.taskletId} />}
				{subagentData && <SubagentAvatar agentId={subagentData.id} agentName={subagentData.name} />}

				<span aria-hidden="true" className="shrink-0 leading-none">
					{!isTaskletCard && card.icon ? (
						<DynamicIcon
							className={cn(
								iconSizeClass,
								receipt
									? RECEIPT_TONE_CLASSES[TASKLET_RECEIPT_OUTCOMES[receipt.outcome].tone]
									: getStatusTextColorClass(status),
							)}
							name={card.icon as React.ComponentProps<typeof DynamicIcon>["name"]}
						/>
					) : (
						<CardStatusIcon className={iconSizeClass} status={status} />
					)}
				</span>

				<span className={cn("min-w-0 flex-1 font-medium", isCollapsed ? "truncate" : "break-all whitespace-normal")}>
					{header}
				</span>

				{elapsedTime && (
					<span
						aria-label={`${isTaskletCard ? "Tasklet" : "Subagent"} runtime ${elapsedTime}`}
						className="shrink-0 font-mono text-xs font-normal text-muted-foreground"
						role="timer">
						{elapsedTime}
					</span>
				)}

				{receipt ? (
					<TaskletReceiptBadge outcome={receipt.outcome} />
				) : taskletStatus ? (
					<Badge
						className="shrink-0 px-1.5 py-0 text-xs leading-4"
						variant={tasklet?.status === "waiting" ? "warning" : "outline"}>
						{taskletStatus.label}
					</Badge>
				) : !isTaskletCard && status === CardStatus.WAITING_FOR_INPUT ? (
					<Badge className="shrink-0 px-1.5 py-0 text-xs leading-4" variant="warning">
						Awaiting Input
					</Badge>
				) : null}

				<span aria-hidden="true" className="shrink-0 opacity-60 leading-none">
					{isCollapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
				</span>
			</button>

			{!isTaskletCard && card.architectureReference && <ArchitectureNavigation selection={card.architectureReference} />}
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
export function getCardFilePath(card: Card): string | undefined {
	if (card.rawInput?.isTasklet === true || card.taskletReceipt) return undefined
	return card.locations?.[0]?.path ?? extractFirstPath(card.header) ?? undefined
}

export function getSubagentCardElapsedTime(card: Card, now = Date.now()): string | undefined {
	const tasklet = readTaskletPresentation(card)
	if (card.rawInput?.isTasklet === true && !tasklet) return undefined
	const startTime = tasklet?.createdAt ?? card.startTime
	if ((!tasklet && !readSubagentCardData(card)) || startTime === undefined) return undefined

	const isTerminal = tasklet ? tasklet.status !== "running" && tasklet.status !== "waiting" : isFinalStatus(card.status)
	const stopTime = isTerminal ? card.endTime : now
	if (stopTime === undefined) return undefined
	const elapsedSeconds = Math.max(0, Math.floor((stopTime - startTime) / 1_000))
	const minutes = Math.floor(elapsedSeconds / 60)
	const seconds = elapsedSeconds % 60
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}
