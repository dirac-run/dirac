import { QuoteIcon } from "lucide-react"
import React from "react"
import { Button } from "@/shared/ui/button"

interface QuoteButtonProps {
	top: number
	left: number
	onClick: () => void
}

const QuoteButton: React.FC<QuoteButtonProps> = ({ top, left, onClick }) => {
	return (
		<div className="quote-button-class absolute" style={{ top, left }}>
			<Button
				aria-label="Quote selection"
				className="p-3 h-auto min-w-auto rounded-md shadow-sm transition-transform hover:scale-105 z-10"
				onClick={(e) => {
					e.stopPropagation() // Prevent triggering mouseup on the parent
					onClick()
				}}
				size="sm"
				title="Quote selection in reply">
				<QuoteIcon className="size-3 fill-button-foreground rotate-180 stroke-1" />
			</Button>
		</div>
	)
}

export default QuoteButton
