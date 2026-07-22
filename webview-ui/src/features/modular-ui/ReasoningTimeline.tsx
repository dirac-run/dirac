import React, { memo } from "react"

interface ReasoningTimelineProps {
	content: string
}

export const ReasoningTimeline: React.FC<ReasoningTimelineProps> = memo(({ content }) => {
	// Split content into steps based on double newlines
	const steps = content.split("\n\n").filter((s) => s.trim().length > 0)

	if (steps.length === 0) return null

	return (
		<div className="flex flex-col gap-1.5">
			{steps.map((step, index) => (
				<p key={index} className="whitespace-pre-wrap text-sm leading-relaxed text-description/90">
					{step.trim()}
				</p>
			))}
		</div>
	)
})

ReasoningTimeline.displayName = "ReasoningTimeline"
