import { DiracApiReqInfo, DiracMessage, DiracMessageType, Mode } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { useCallback, useMemo } from "react"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { getEnvironmentColor } from "@/shared/lib/environmentColors"
import { formatLargeNumber as formatTokenNumber } from "@/shared/lib/format"
import Thumbnails from "@/shared/ui/Thumbnails"
import CopyTaskButton from "./buttons/CopyTaskButton"
import DeleteTaskButton from "./buttons/DeleteTaskButton"
import OpenDiskConversationHistoryButton from "./buttons/OpenDiskConversationHistoryButton"
import { CheckpointError } from "./CheckpointError"
import ContextWindow from "./ContextWindow"
import { highlightText } from "./Highlights"

const IS_DEV = process.env.IS_DEV === '"true"'
interface TaskHeaderProps {
	task: DiracMessage
	totalCost: number
	cacheHitRate: number
	lastApiReqInfo?: DiracApiReqInfo
	onClose: () => void
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

const getUsageColor = (percentage: number) => {
	if (percentage < 50) return "text-emerald-400"
	if (percentage < 80) return "text-amber-400"
	return "text-rose-400"
}

const getCacheHitColor = (rate: number): string => {
	const hue = rate * 150 // 0 (red) → 150 (green)
	return `hsla(${hue}, 75%, 45%, 0.9)`
}

const BUTTON_CLASS = "max-h-3 border-0 font-bold bg-transparent hover:opacity-100 text-foreground"

const TaskHeader: React.FC<TaskHeaderProps> = ({ task, totalCost, cacheHitRate, lastApiReqInfo, onSendMessage }) => {
	const {
		apiConfiguration,
		checkpointManagerErrorMessage,
		navigateToSettings,
		mode,
		expandTaskHeader: isTaskExpanded,
		setExpandTaskHeader: setIsTaskExpanded,
		environment,
	} = useSettingsStore()
	const currentTaskItem = useTaskStore((state) => state.currentTaskItem)

	const { selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, mode as Mode)
	const modeFields = getModeSpecificFields(apiConfiguration, mode as Mode)

	const taskText = task.content.type === DiracMessageType.MARKDOWN ? task.content.content : ""
	const highlightedText = useMemo(() => highlightText(taskText, false), [taskText])
	const taskDetailsId = `task-details-${task.id}`

	const contextWindow = selectedModelInfo?.contextWindow || 0

	const lastApiReqTotalTokens = useMemo(
		() =>
			(lastApiReqInfo?.tokensIn || 0) +
			(lastApiReqInfo?.tokensOut || 0) +
			(lastApiReqInfo?.cacheWrites || 0) +
			(lastApiReqInfo?.cacheReads || 0),
		[lastApiReqInfo],
	)

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
			modeFields.apiProvider !== "openai-codex")

	const toggleTaskExpanded = useCallback(() => setIsTaskExpanded(!isTaskExpanded), [setIsTaskExpanded, isTaskExpanded])

	const handleCheckpointSettingsClick = useCallback(() => {
		navigateToSettings("features")
	}, [navigateToSettings])

	const environmentBorderColor = getEnvironmentColor(environment, "border")

	return (
		<div className="py-2 px-4 flex flex-col gap-1">
			<CheckpointError
				checkpointManagerErrorMessage={checkpointManagerErrorMessage}
				handleCheckpointSettingsClick={handleCheckpointSettingsClick}
			/>
			<div
				className={cn(
					"relative overflow-hidden rounded-md flex flex-col gap-1.5 z-10 py-2.5 px-3 hover:opacity-100 bg-(--vscode-toolbar-hoverBackground)/40 transition-all duration-200 ease-in-out",
					{
						"opacity-100 border-1": isTaskExpanded,
						"hover:bg-toolbar-hover border-1": !isTaskExpanded,
					},
				)}
				style={{ borderColor: environmentBorderColor }}>
				<div className="flex min-w-0 items-center gap-1">
					<button
						aria-controls={taskDetailsId}
						aria-expanded={isTaskExpanded}
						aria-label={isTaskExpanded ? "Collapse task header" : "Expand task header"}
						className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-sm bg-transparent text-left text-inherit focus-visible:outline-2 focus-visible:outline-ring"
						onClick={toggleTaskExpanded}
						type="button">
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<div aria-hidden="true" className="shrink-0 opacity-70">
								{isTaskExpanded ? <ChevronDownIcon size="16" /> : <ChevronRightIcon size="16" />}
							</div>
							<div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
								<span className="ph-no-capture text-sm font-medium opacity-90">
									{isTaskExpanded ? "Task Details" : highlightedText}
								</span>
							</div>
						</div>

						<div className="inline-flex shrink-0 select-none items-center justify-end gap-2">
							{contextWindow > 0 && (
								<div className="flex items-center gap-1 rounded-md border border-foreground/5 bg-foreground/5 px-2 py-1 font-mono text-xs">
									<span className="mr-0.5 opacity-50">CTX</span>
									<span className={cn("font-bold", getUsageColor(tokenPercentage))}>
										{formatTokenNumber(lastApiReqTotalTokens)}
									</span>
								</div>
							)}

							{isCostAvailable && (
								<div className="rounded-md border border-foreground/5 bg-foreground/5 px-2 py-1 font-mono text-xs font-bold text-blue-400/90">
									${totalCost?.toFixed(4)}
								</div>
							)}

							{cacheHitRate > 0 && (
								<div
									className="rounded-md border border-foreground/5 bg-foreground/5 px-2 py-1 font-mono text-xs font-bold"
									style={{ color: getCacheHitColor(cacheHitRate) }}>
									{(cacheHitRate * 100).toFixed(0)}% cache
								</div>
							)}
						</div>
					</button>

					{isTaskExpanded && (
						<div className="flex shrink-0 items-center gap-0.5">
							<CopyTaskButton className={BUTTON_CLASS} taskText={taskText} />
							<DeleteTaskButton
								className={BUTTON_CLASS}
								taskId={currentTaskItem?.id}
								taskSize={currentTaskItem?.size}
							/>
							{IS_DEV && (
								<OpenDiskConversationHistoryButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />
							)}
						</div>
					)}
				</div>

				{isTaskExpanded && (
					<div
						className="flex flex-col gap-3 mt-1 animate-in fade-in slide-in-from-top-1 duration-200"
						id={taskDetailsId}>
						<div className="ph-no-capture whitespace-pre-wrap break-words px-1 text-sm leading-relaxed opacity-90 max-h-[40vh] overflow-y-auto custom-scrollbar">
							{highlightedText}
						</div>

						{((task.content.type === DiracMessageType.MARKDOWN &&
							task.content.images &&
							task.content.images.length > 0) ||
							(task.content.type === DiracMessageType.MARKDOWN &&
								task.content.files &&
								task.content.files.length > 0)) && (
							<div className="px-1">
								<Thumbnails
									files={(task.content.type === DiracMessageType.MARKDOWN ? task.content.files : []) ?? []}
									images={(task.content.type === DiracMessageType.MARKDOWN ? task.content.images : []) ?? []}
								/>
							</div>
						)}

						<div className="border-t border-foreground/5 pt-2">
							<ContextWindow lastApiReqInfo={lastApiReqInfo} onSendMessage={onSendMessage} />
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

export default TaskHeader
