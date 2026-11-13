import type { ApiProvider, ModelInfo } from "@shared/api"
import { useEffect, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { getCostLabel } from "./getCostLabel"
import { getSubscriptionQuotaDisplay } from "./getSubscriptionQuotaDisplay"

interface TaskCostBadgeProps {
	provider: ApiProvider
	modelInfo?: ModelInfo
	totalCost: number
}

const BADGE_CLASS = "rounded-md border border-foreground/5 bg-foreground/5 px-2 py-1 font-mono text-xs font-bold text-blue-400/90"

export function TaskCostBadge({ provider, modelInfo, totalCost }: TaskCostBadgeProps) {
	const isAuthenticated = useSettingsStore((state) => state.openAiCodexIsAuthenticated)
	const snapshot = useSettingsStore((state) => state.openAiCodexUsage)
	const [now, setNow] = useState(() => Date.now())
	const costLabel = getCostLabel(totalCost, modelInfo)
	const showSubscription = provider === "openai-codex" && costLabel === "Free"

	// Update freshness while idle without polling the provider or changing usage accounting.
	useEffect(() => {
		if (!showSubscription) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 60_000)
		return () => window.clearInterval(timer)
	}, [showSubscription, snapshot])

	if (!showSubscription) return <span className={BADGE_CLASS}>{costLabel}</span>

	const quota = getSubscriptionQuotaDisplay(isAuthenticated ? snapshot : undefined, now)
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span aria-label={quota.label} className={BADGE_CLASS} tabIndex={0}>
					{quota.label}
				</span>
			</TooltipTrigger>
			<TooltipContent className="whitespace-pre-line">{quota.description}</TooltipContent>
		</Tooltip>
	)
}
