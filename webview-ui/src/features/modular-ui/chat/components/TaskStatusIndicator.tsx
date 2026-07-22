import React, { useEffect, useMemo, useState } from "react"
import type { TaskStatus } from "@shared/ExtensionMessage"
import { projectTaskStatus, type TaskStatusTone } from "@shared/taskStatusProjection"
import { cn } from "@/lib/utils"

const ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"]
const SPINNER_INTERVAL_MS = 140

const toneClasses: Record<TaskStatusTone, string> = {
	muted: "text-(--vscode-descriptionForeground) opacity-70",
	active: "text-(--vscode-descriptionForeground) opacity-90",
	warning: "text-(--vscode-descriptionForeground) opacity-85",
	success: "text-success opacity-85",
}

function useAsciiSpinnerFrame(isActive: boolean) {
	const [frameIndex, setFrameIndex] = useState(0)

	useEffect(() => {
		if (!isActive) {
			setFrameIndex(0)
			return
		}

		const interval = window.setInterval(() => {
			setFrameIndex((current) => (current + 1) % ASCII_SPINNER_FRAMES.length)
		}, SPINNER_INTERVAL_MS)

		return () => window.clearInterval(interval)
	}, [isActive])

	return ASCII_SPINNER_FRAMES[frameIndex]
}

interface TaskStatusIndicatorProps {
	status?: TaskStatus
	className?: string
}

export const TaskStatusIndicator: React.FC<TaskStatusIndicatorProps> = ({ status, className }) => {
	const projection = useMemo(() => projectTaskStatus(status), [status])
	const spinnerFrame = useAsciiSpinnerFrame(projection.isBusy)

	return (
		<div
			aria-label={`Task status: ${projection.label}`}
			aria-live="polite"
			className={cn(
				"flex h-5 max-w-[180px] min-w-0 shrink items-center gap-1.5 rounded-sm px-1.5",
				"font-mono text-xs leading-none tracking-tight transition-colors duration-200",
				toneClasses[projection.tone],
				className,
			)}
			title={projection.description}>
			{projection.isBusy && <span className="inline-block w-2 text-center opacity-80">{spinnerFrame}</span>}
			<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{projection.label}</span>
		</div>
	)
}
