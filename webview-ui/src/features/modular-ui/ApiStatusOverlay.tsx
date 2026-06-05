import { DiracApiReqInfo } from "@shared/ExtensionMessage"
import { memo } from "react"
import { CoinsIcon, ZapIcon } from "lucide-react"

interface ApiStatusOverlayProps {
	status: DiracApiReqInfo
}

export const ApiStatusOverlay = memo(({ status }: ApiStatusOverlayProps) => {
	const { cost, tokensIn, tokensOut, cacheWrites, cacheReads, contextUsagePercentage } = status

	if (cost === undefined && tokensIn === undefined && tokensOut === undefined) {
		return null
	}

	return (
		<div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground bg-foreground/5 rounded-md border border-foreground/10 w-fit">
			{cost !== undefined && (
				<div className="flex items-center gap-1">
					<CoinsIcon className="size-3" />
					<span>${cost.toFixed(4)}</span>
				</div>
			)}
			{(tokensIn !== undefined || tokensOut !== undefined) && (
				<div className="flex items-center gap-1">
					<ZapIcon className="size-3" />
					<span>
						{tokensIn || 0} in / {tokensOut || 0} out
					</span>
				</div>
			)}
			{contextUsagePercentage !== undefined && (
				<div className="flex items-center gap-1 border-l border-foreground/20 pl-2">
					<span>Context: {Math.round(contextUsagePercentage)}%</span>
				</div>
			)}
		</div>
	)
})
