import { DiracApiReqInfo, Mode } from "@shared/ExtensionMessage"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import debounce from "debounce"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChatStore } from "@/features/chat/store/chatStore"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { formatLargeNumber as formatTokenNumber } from "@/shared/lib/format"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card"
import { Progress } from "@/shared/ui/progress"
import CompactTaskButton from "./buttons/CompactTaskButton"
import { ContextWindowSummary } from "./ContextWindowSummary"

// Type definitions
interface ContextWindowInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
}

interface ContextWindowProgressProps {
	onSendMessage?: (command: string, files: string[], images: string[]) => void
	lastApiReqInfo?: DiracApiReqInfo
}

const ConfirmationDialog = memo<{
	onConfirm: (e: React.MouseEvent) => void
	onCancel: (e: React.MouseEvent) => void
}>(({ onConfirm, onCancel }) => (
	<div className="text-sm my-2 flex items-center gap-0 justify-between">
		<span className="font-semibold text-sm">Compact the current task?</span>
		<span className="flex gap-1">
			<VSCodeButton
				appearance="secondary"
				className="text-sm"
				onClick={onCancel}
				title="No, keep the task as is"
				type="button">
				Cancel
			</VSCodeButton>
			<VSCodeButton
				appearance="primary"
				autoFocus={true}
				className="text-sm"
				onClick={onConfirm}
				title="Yes, compact the task"
				type="button">
				Yes
			</VSCodeButton>
		</span>
	</div>
))
ConfirmationDialog.displayName = "ConfirmationDialog"

const ContextWindow: React.FC<ContextWindowProgressProps> = ({ onSendMessage, lastApiReqInfo }) => {
	const { apiConfiguration, mode } = useSettingsStore()
	const { diracMessages } = useChatStore()

	const { selectedModelInfo } = useMemo(
		() => normalizeApiConfiguration(apiConfiguration, mode as Mode),
		[apiConfiguration, mode],
	)
	const contextWindow = selectedModelInfo?.contextWindow || 0

	const [tokensIn, tokensOut, cacheWrites, cacheReads, lastApiReqTotalTokens] = useMemo(() => {
		if (lastApiReqInfo) {
			return [
				lastApiReqInfo.tokensIn,
				lastApiReqInfo.tokensOut,
				lastApiReqInfo.cacheWrites,
				lastApiReqInfo.cacheReads,
				(lastApiReqInfo.tokensIn || 0) + (lastApiReqInfo.tokensOut || 0) + (lastApiReqInfo.cacheWrites || 0) + (lastApiReqInfo.cacheReads || 0),
			]
		}
		return [0, 0, 0, 0, 0]
	}, [lastApiReqInfo])

	const tokenData = useMemo(() => {
		if (!contextWindow) {
			return null
		}
		return {
			percentage: (lastApiReqTotalTokens / contextWindow) * 100,
			max: contextWindow,
			used: lastApiReqTotalTokens,
		}
	}, [contextWindow, lastApiReqTotalTokens])
	const [isOpened, setIsOpened] = useState(false)
	const [confirmationNeeded, setConfirmationNeeded] = useState(false)
	const progressBarRef = useRef<HTMLDivElement>(null)

	const handleCompactClick = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			setConfirmationNeeded(!confirmationNeeded)
		},
		[confirmationNeeded],
	)

	const handleConfirm = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			onSendMessage?.("/compact", [], [])
			setConfirmationNeeded(false)
		},
		[onSendMessage],
	)

	const handleCancel = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded(false)
	}, [])

	const debounceCloseHover = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		const showHover = debounce((open: boolean) => setIsOpened(open), 100)

		return showHover(false)
	}, [])

	const handleFocus = useCallback(() => {
		setIsOpened(true)
	}, [])

	// Close tooltip when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Element
			const isInsideProgressBar = progressBarRef.current?.contains(target as Node)

			// Check if click is inside any tooltip content by looking for our custom class
			const isInsideTooltipContent = target.closest(".context-window-tooltip-content") !== null

			if (!isInsideProgressBar && !isInsideTooltipContent) {
				setIsOpened(false)
			}
		}

		if (isOpened) {
			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [isOpened])

	if (!tokenData) {
		return null
	}

	return (
		<div className="flex flex-col my-1.5" onMouseLeave={debounceCloseHover}>
			<div className="flex gap-1 flex-row @max-xs:flex-col @max-xs:items-start items-center text-sm">
				<div className="flex items-center gap-1.5 flex-1 whitespace-nowrap">
					<span className="cursor-pointer text-sm" title="Current tokens used in this request">
						{formatTokenNumber(tokenData.used)}
					</span>
					<div className="flex relative items-center gap-1 flex-1 w-full h-full" onMouseEnter={() => setIsOpened(true)}>
						<HoverCard>
							<HoverCardContent className="bg-menu rounded-xs shadow-sm">
								<ContextWindowSummary
									contextWindow={tokenData.max}
									percentage={tokenData.percentage}
									tokenUsed={tokenData.used}
								/>
							</HoverCardContent>
							<HoverCardTrigger asChild>
								{/* TODO: Re-add role="slider", aria-value*, onKeyDown, onClick, and tabIndex
								    when click-to-set-threshold is implemented. See PR #9348 for context. */}
								<div
									className="relative w-full text-foreground context-window-progress brightness-100"
									onFocus={handleFocus}
									ref={progressBarRef}>
									<Progress
										aria-label="Context window usage progress"
										color="success"
										value={tokenData.percentage}
									/>
									{isOpened}
								</div>
							</HoverCardTrigger>
						</HoverCard>
					</div>
					<span className="cursor-pointer text-sm" title="Maximum context window size for this model">
						{formatTokenNumber(tokenData.max)}
					</span>
				</div>
				<CompactTaskButton onClick={handleCompactClick} />
			</div>
			{confirmationNeeded && <ConfirmationDialog onCancel={handleCancel} onConfirm={handleConfirm} />}
		</div>
	)
}

export default memo(ContextWindow)
