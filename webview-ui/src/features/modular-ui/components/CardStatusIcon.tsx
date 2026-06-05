import React from "react"
import { CardStatus } from "@shared/ExtensionMessage"
import { cn } from "@/lib/utils"
import {
    Loader2Icon,
    CheckCircle2Icon,
    XCircleIcon,
    FastForwardIcon,
    GhostIcon,
    CircleIcon,
    MessageSquareIcon,
} from "lucide-react"

interface CardStatusIconProps {
	status: CardStatus
	className?: string
}

export const CardStatusIcon: React.FC<CardStatusIconProps> = ({ status, className }) => {
	switch (status) {
		case CardStatus.BUILDING:
		case CardStatus.PENDING:
			return <CircleIcon className={cn("size-4 text-muted-foreground", className)} />
		case CardStatus.RUNNING:
			return <Loader2Icon className={cn("size-4 text-link animate-spin", className)} />
		case CardStatus.SUCCESS:
			return <CheckCircle2Icon className={cn("size-4 text-success", className)} />
		case CardStatus.ERROR:
			return <XCircleIcon className={cn("size-4 text-error", className)} />
		case CardStatus.SKIPPED:
			return <FastForwardIcon className={cn("size-4 text-muted-foreground", className)} />
		case CardStatus.CANCELLED:
			return <XCircleIcon className={cn("size-4 text-muted-foreground", className)} />
		case CardStatus.ABANDONED:
			return <GhostIcon className={cn("size-4 text-muted-foreground", className)} />
		case CardStatus.WAITING_FOR_INPUT:
			return <MessageSquareIcon className={cn("size-4 text-warning", className)} />
		default:
			return <CircleIcon className={cn("size-4 text-muted-foreground", className)} />
	}
}
