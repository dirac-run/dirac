import { PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

const NewTaskButton: React.FC<{
	onClick: () => void
	className?: string
}> = ({ className, onClick }) => {
	return (
		<Tooltip>
			<TooltipContent side="bottom">Start a New Task</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label="New Task (Cmd+Shift+N)"
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						onClick()
					}}
					size="icon"
					variant="icon">
					<PlusIcon size={18} />
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default NewTaskButton
