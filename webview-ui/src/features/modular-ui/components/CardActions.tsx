import React from "react"
import { Card, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Button } from "@/shared/ui/button"
import { cn } from "@/lib/utils"
import { CheckIcon, XIcon } from "lucide-react"
import { useChatStore } from "@/features/chat/store/chatStore"

interface CardActionsProps {
	card: Card
	onAction?: (value: string, commandApprovalChoiceId?: string) => void
	isActive?: boolean
}

export const CardActions: React.FC<CardActionsProps> = ({ card, isActive, onAction }) => {
	const hasApprovalTray = useChatStore((state) => state.uiActionState?.pendingApprovalCardIds !== undefined)
	const { requireApproval, actions, status } = card
	const hasActions = (actions && actions.length > 0) || requireApproval

	const showActions = !isFinalStatus(status) && (isActive || status === CardStatus.WAITING_FOR_INPUT)

	// A removed waiter must not regain transcript authority while its card finalizes.
	if ((hasApprovalTray && requireApproval) || !showActions || !hasActions) {
		return null
	}

	return (
		<div
			className={cn(
				"modular-card-actions p-2 bg-foreground/[0.03] border-t flex flex-col gap-2",
				requireApproval ? "border-warning/20" : "border-foreground/10",
			)}>
			{requireApproval && <div className="flex items-center gap-1.5 text-xs text-warning font-medium">Action required</div>}
			<div className={cn("flex gap-2", requireApproval && card.commandApprovalChoices ? "flex-col items-stretch" : "flex-wrap")}>
				{requireApproval && card.commandApprovalChoices ? (
					card.commandApprovalChoices.map((choice) => (
						<Button
							key={choice.id}
							variant={choice.id === "reject" ? "danger" : choice.id === "approve" ? "success" : "secondary"}
							size="sm"
							className="min-h-6 h-auto text-xs px-3 py-1 justify-start whitespace-normal text-left"
							onClick={() => onAction?.(choice.id === "reject" ? DiracAskResponse.REJECT : DiracAskResponse.APPROVE, choice.id)}>
							{choice.label}
						</Button>
					))
				) : actions && actions.length > 0 ? (
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
							className="h-6 text-xs px-3 gap-1"
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
