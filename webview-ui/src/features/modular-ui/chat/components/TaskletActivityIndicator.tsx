import { memo } from "react"
import { useChatStore } from "@/features/chat/store/chatStore"

/** Lifecycle counts have their own subscription; child streaming never renders this indicator. */
export const TaskletActivityIndicator = memo(function TaskletActivityIndicator() {
	const availability = useChatStore((state) => state.taskletActivity?.availability)
	const activeCount = useChatStore((state) => state.taskletActivity?.activeCount ?? 0)
	if (availability !== "live" || activeCount <= 0) return null
	return (
		<span
			aria-live="polite"
			className="shrink-0 whitespace-nowrap text-xs text-(--vscode-descriptionForeground)"
			title="Run /agents to see the list of currently running subagents.">
			{activeCount} {activeCount === 1 ? "agent" : "agents"}
		</span>
	)
})
