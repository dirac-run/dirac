import { DiracApiReqInfo, DiracMessage, DiracMessageType, Mode } from "@shared/ExtensionMessage"
import { useChatStore } from "@/features/chat/store/chatStore"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { useCallback, useLayoutEffect, useMemo, useState } from "react"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { getEnvironmentColor } from "@/shared/lib/environmentColors"
import Thumbnails from "@/shared/ui/Thumbnails"
import CopyTaskButton from "./buttons/CopyTaskButton"
import DeleteTaskButton from "./buttons/DeleteTaskButton"
import OpenDiskConversationHistoryButton from "./buttons/OpenDiskConversationHistoryButton"
import { formatLargeNumber as formatTokenNumber } from "@/shared/lib/format"
import { CheckpointError } from "./CheckpointError"
import ContextWindow from "./ContextWindow"
import { highlightText } from "./Highlights"

const IS_DEV = process.env.IS_DEV === '"true"'
interface TaskHeaderProps {
	task: DiracMessage
	totalCost: number
	lastApiReqInfo?: DiracApiReqInfo
	onClose: () => void
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

const getUsageColor = (percentage: number) => {
	if (percentage < 50) return "text-emerald-400"
	if (percentage < 80) return "text-amber-400"
	return "text-rose-400"
}

const BUTTON_CLASS = "max-h-3 border-0 font-bold bg-transparent hover:opacity-100 text-foreground"

const TaskHeader: React.FC<TaskHeaderProps> = ({
	task,
	totalCost,
	lastApiReqInfo,
	onClose,
	onSendMessage,
}) => {
	const {
		apiConfiguration,
		currentTaskItem,
		checkpointManagerErrorMessage,
		navigateToSettings,
		mode,
		expandTaskHeader: isTaskExpanded,
		setExpandTaskHeader: setIsTaskExpanded,
		environment,
	} = useSettingsStore()

	const { selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, mode as Mode)
	const modeFields = getModeSpecificFields(apiConfiguration, mode as Mode)
	const { diracMessages } = useChatStore()

	const [isHighlightedTextExpanded, setIsHighlightedTextExpanded] = useState(false)
	const [isTextOverflowing, setIsTextOverflowing] = useState(false)
	const highlightedTextRef = React.useRef<HTMLDivElement>(null)

	const taskText = task.content.type === DiracMessageType.MARKDOWN ? task.content.content : ""
	const highlightedText = useMemo(() => highlightText(taskText, false), [taskText])


	// Check if text overflows the container (i.e., needs clamping)
	useLayoutEffect(() => {
		const el = highlightedTextRef.current
		if (el && isTaskExpanded && !isHighlightedTextExpanded) {
			// Check if content height exceeds the max-height
			setIsTextOverflowing(el.scrollHeight > el.clientHeight)
		}
	}, [taskText, isTaskExpanded, isHighlightedTextExpanded])


	// Handle click outside to collapse
	React.useEffect(() => {
		if (!isHighlightedTextExpanded) {
			return
		}

		const handleClickOutside = (event: MouseEvent) => {
			if (highlightedTextRef.current && !highlightedTextRef.current.contains(event.target as Node)) {
				setIsHighlightedTextExpanded(false)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [isHighlightedTextExpanded])

	// Simplified computed values
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

	const tokenPercentage = useMemo(() => {
		if (!contextWindow || !lastApiReqTotalTokens) return 0
		return (lastApiReqTotalTokens / contextWindow) * 100
	}, [contextWindow, lastApiReqTotalTokens])


	const isCostAvailable =
		(totalCost &&
			modeFields.apiProvider === "openai" &&
			modeFields.openAiModelInfo?.inputPrice &&
			modeFields.openAiModelInfo?.outputPrice) ||
		(modeFields.apiProvider !== "vscode-lm" &&
			modeFields.apiProvider !== "lmstudio" &&
			modeFields.apiProvider !== "openai-codex") // Subscription-based, no per-token costs

	// Event handlers
	const toggleTaskExpanded = useCallback(() => setIsTaskExpanded(!isTaskExpanded), [setIsTaskExpanded, isTaskExpanded])

	const handleCheckpointSettingsClick = useCallback(() => {
		navigateToSettings("features")
	}, [navigateToSettings])

	const environmentBorderColor = getEnvironmentColor(environment, "border")

	return (
		<div className="py-2 px-4 flex flex-col gap-1">
			{/* Display Checkpoint Error */}
			<CheckpointError
				checkpointManagerErrorMessage={checkpointManagerErrorMessage}
				handleCheckpointSettingsClick={handleCheckpointSettingsClick}
			/>
			{/* Task Header */}
			<div
				className={cn(
					"relative overflow-hidden cursor-pointer rounded-md flex flex-col gap-1.5 z-10 py-2.5 px-3 hover:opacity-100 bg-(--vscode-toolbar-hoverBackground)/40 transition-all duration-200 ease-in-out",
					{
						"opacity-100 border-1": isTaskExpanded, // No hover effects when expanded, add border
						"hover:bg-toolbar-hover border-1": !isTaskExpanded, // Hover effects only when collapsed
					},
				)}
				style={{
					borderColor: environmentBorderColor,
				}}>
				{/* Task Title */}
				<div
					aria-label={isTaskExpanded ? "Collapse task header" : "Expand task header"}
					className="flex justify-between items-center cursor-pointer"
					onClick={toggleTaskExpanded}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault()
							e.stopPropagation()
							toggleTaskExpanded()
						}
					}}
					tabIndex={0}>
					<div className="flex items-center gap-2 min-w-0 flex-1">
						<div className="shrink-0 opacity-70">
							{isTaskExpanded ? <ChevronDownIcon size="16" /> : <ChevronRightIcon size="16" />}
						</div>
						<div className="whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0">
							<span className="ph-no-capture text-sm font-medium opacity-90">
								{isTaskExpanded ? "Task Details" : highlightedText}
							</span>
						</div>
					</div>
					<div className="inline-flex items-center justify-end select-none shrink-0 gap-2">
						{/* Compact Context Window Info */}
						{contextWindow > 0 && (
							<div className="flex items-center gap-1 px-2 py-1 rounded-md bg-foreground/5 text-xs font-mono border border-foreground/5">
								<span className="opacity-50 mr-0.5">CTX</span>
								<span className={cn("font-bold", getUsageColor(tokenPercentage))}>
									{formatTokenNumber(lastApiReqTotalTokens)}
								</span>
							</div>
						)}

						{isCostAvailable && (
							<div className="px-2 py-1 rounded-md bg-foreground/5 text-xs font-mono border border-foreground/5 text-blue-400/90 font-bold">
								${totalCost?.toFixed(4)}
							</div>
						)}

						<div className="flex items-center gap-0.5">
							{isTaskExpanded && (
								<>
									<CopyTaskButton className={BUTTON_CLASS} taskText={taskText} />

									<DeleteTaskButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} taskSize={currentTaskItem?.size} />
									{IS_DEV && <OpenDiskConversationHistoryButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />}
								</>
							)}
						</div>
					</div>
				</div>

				{/* Expanded Content */}
				{isTaskExpanded && (
					<div className="flex flex-col gap-3 mt-1 animate-in fade-in slide-in-from-top-1 duration-200" key={`task-details-${currentTaskItem?.id}`}>
						<div className="ph-no-capture whitespace-pre-wrap break-words px-1 text-sm leading-relaxed opacity-90 max-h-[40vh] overflow-y-auto custom-scrollbar">
							{highlightedText}
						</div>

						{((task.content.type === DiracMessageType.MARKDOWN && task.content.images && task.content.images.length > 0) || (task.content.type === DiracMessageType.MARKDOWN && task.content.files && task.content.files.length > 0)) && (

							<div className="px-1">
								<Thumbnails files={(task.content.type === DiracMessageType.MARKDOWN ? task.content.files : []) ?? []} images={(task.content.type === DiracMessageType.MARKDOWN ? task.content.images : []) ?? []} />

							</div>
						)}

						<div className="border-t border-foreground/5 pt-2">
							<ContextWindow onSendMessage={onSendMessage} lastApiReqInfo={lastApiReqInfo} />
						</div>
					</div>
				)}
			</div>

		</div>
	)
}

export default TaskHeader
