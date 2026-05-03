import React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"

interface ApprovalBoxProps {
	children: React.ReactNode
	onApprove: () => void
	onReject: () => void
	isProcessing?: boolean
	description?: string
	onEdit?: () => void
}

export const ApprovalBox: React.FC<ApprovalBoxProps> = ({ children, onApprove, onReject, isProcessing, description, onEdit }) => {
	if (!children) return null
	return (
		<div className={cn("my-2 p-3 border border-editor-group-border rounded-sm bg-code-background/40", isProcessing && "opacity-60 pointer-events-none")}>
			{description && <div className="text-xs font-medium mb-2 opacity-90">{description}</div>}
			<div className="flex flex-col gap-2 mb-3">{children}</div>
			<div className="flex items-center gap-2">
				<Button
					size="sm"
					variant="default"
					className="h-7 text-xs px-4 bg-success hover:bg-success/90 text-white font-semibold transition-all active:scale-95"
					onClick={onApprove}
					disabled={isProcessing}>
					{isProcessing ? "Processing..." : "Approve"}
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="h-7 text-xs px-4 border-editor-group-border hover:bg-error/10 hover:text-error hover:border-error/50 font-semibold transition-all active:scale-95"
					onClick={onReject}
					disabled={isProcessing}>
					Reject
				</Button>
				{onEdit && (
					<Button
						size="sm"
						variant="outline"
						className="h-7 text-xs px-4 border-editor-group-border hover:bg-info/10 hover:text-info hover:border-info/50 font-semibold transition-all active:scale-95"
						onClick={onEdit}
						disabled={isProcessing}>
						Review &amp; Edit
					</Button>
				)}
			</div>
		</div>
	)
}
