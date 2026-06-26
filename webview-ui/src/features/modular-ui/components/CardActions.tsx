import React from "react"
import { Card, CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Button } from "@/shared/ui/button"
import { cn } from "@/lib/utils"
import { CheckIcon, XIcon } from "lucide-react"

interface CardActionsProps {
	card: Card
	onAction?: (value: string) => void
	isActive?: boolean
}

export const CardActions: React.FC<CardActionsProps> = ({ card, isActive, onAction }) => {
	const { requireApproval, actions, status } = card
	const hasActions = (actions && actions.length > 0) || requireApproval

	const showActions = isActive || status === CardStatus.WAITING_FOR_INPUT

	if (!showActions || !hasActions) {
		return null
	}

	return (
		<div
			className={cn(
				"p-2 bg-foreground/[0.03] border-t flex flex-col gap-2",
				requireApproval ? "border-warning/20" : "border-foreground/10",
			)}>
			{requireApproval && <div className="flex items-center gap-1.5 text-xs text-warning font-medium">Action required</div>}
			<div className="flex flex-wrap gap-2">
				{actions && actions.length > 0 ? (
					actions.map((action, index) => (
						<Button
							key={index}
							asChild={!!action.url}
							variant={
								action.style === "danger" ? "danger" : action.style === "secondary" ? "secondary" : "default"
							}
							size="sm"
							className={cn("h-6 text-xs px-3", action.primary && "ring-1 ring-primary")}
							onClick={() => !action.url && onAction?.(action.value)}>
							{action.url ? (
								<a
									href={action.url}
									target="_blank"
									rel="noopener noreferrer"
									className="no-underline text-inherit">
									{action.label}
								</a>
							) : (
								action.label
							)}
						</Button>
					))
				) : requireApproval ? (
					<>
						<Button
							variant="success"
							size="sm"
							className="h-6 text-xs px-3 gap-1 ring-1 ring-success/30"
							onClick={() => onAction?.(DiracAskResponse.APPROVE)}>
							<CheckIcon className="size-3" />
							Approve
						</Button>
						<Button
							variant="danger"
							size="sm"
							className="h-6 text-xs px-3 gap-1"
							onClick={() => onAction?.(DiracAskResponse.REJECT)}>
							<XIcon className="size-3" />
							Reject
						</Button>
					</>
				) : null}
			</div>
		</div>
	)
}
