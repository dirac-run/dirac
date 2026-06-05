import { StringRequest } from "@shared/proto/dirac/common"
import { ArrowDownToLineIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

const OpenDiskConversationHistoryButton: React.FC<{
	taskId?: string
	className?: string
}> = ({ taskId, className }) => {
	const handleOpenDiskConversationHistory = () => {
		if (!taskId) {
			return
		}

		FileServiceClient.openDiskConversationHistory(StringRequest.create({ value: taskId })).catch((err) => {
			console.error(err)
		})
	}

	return (
		<Tooltip>
			<TooltipContent>Open Conversation History File</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label="Open Disk Conversation History"
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						handleOpenDiskConversationHistory()
					}}
					size="icon"
					variant="icon">
					<ArrowDownToLineIcon />
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

OpenDiskConversationHistoryButton.displayName = "OpenDiskConversationHistoryButton"
export default OpenDiskConversationHistoryButton
