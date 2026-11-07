import { memo } from "react"
import { useChatStore } from "@/features/chat/store/chatStore"

/** Lifecycle counts have their own subscription; child streaming never renders this indicator. */
export const TaskletActivityIndicator = memo(function TaskletActivityIndicator() {
	const availability = useChatStore((state) => state.taskletActivity?.availability)
	const activeCount = useChatStore((state) => state.taskletActivity?.activeCount)
	if (!availability) return null

	const isLive = availability === "live" && activeCount !== null
	return (
		<span
			aria-live="polite"
			className="shrink-0 whitespace-nowrap px-1 text-xs text-(--vscode-descriptionForeground)"
			title={isLive
				? "Active agents, including those waiting for the parent or settling. Use /agents for a local snapshot."
				: "Saved history cannot establish live activity. Use /agents for a local snapshot."}>
			{isLive ? `Agents · ${activeCount} active` : "Agents · saved"}
		</span>
	)
})
