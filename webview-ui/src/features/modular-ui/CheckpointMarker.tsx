import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react"
import { CheckpointRestoreRequest } from "@shared/proto/dirac/checkpoints"
import { Int64Request } from "@shared/proto/dirac/common"
import { DiracCheckpointRestore } from "@shared/WebviewMessage"
import { BookmarkIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { CheckpointsServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { DiracMessage } from "@shared/ExtensionMessage"

interface CheckpointMarkerProps {
	message: DiracMessage
}

const popupClasses = cn(
	"fixed bg-background border border-(--vscode-editorGroup-border) p-3.5 rounded-[5px]",
	"w-[min(calc(100vw-54px),200px)] z-1000 shadow-[0_4px_12px_rgba(0,0,0,0.3)]",
	// Safe hover zone (invisible padding)
	"before:content-[''] before:absolute before:left-0 before:right-0 before:h-2",
	// Arrow
	"after:content-[''] after:absolute after:w-2.5 after:h-2.5 after:right-6",
	"after:border-l after:border-t after:border-(--vscode-editorGroup-border) after:bg-background after:rotate-45 after:z-[1]",
	// Bottom placement (default): safe zone above, arrow above
	"before:-top-2 after:-top-[5px]",
	// Top placement: safe zone below, arrow below
	"data-[placement^=top]:before:top-auto data-[placement^=top]:before:-bottom-2",
	"data-[placement^=top]:after:top-auto data-[placement^=top]:after:-bottom-[5px] data-[placement^=top]:after:rotate-[225deg]",
)

export const CheckpointMarker = ({ message }: CheckpointMarkerProps) => {
	const messageTs = message.ts
	const isCheckpointCheckedOut = message.isCheckpointCheckedOut

	const [compareDisabled, setCompareDisabled] = useState(false)
	const [restoreTaskDisabled, setRestoreTaskDisabled] = useState(false)
	const [restoreWorkspaceDisabled, setRestoreWorkspaceDisabled] = useState(false)
	const [restoreBothDisabled, setRestoreBothDisabled] = useState(false)
	const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
	const [showMoreOptions, setShowMoreOptions] = useState(false)
	const { onRelinquishControl } = useSettingsStore()

	// Debounce
	const closeMenuTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const scheduleCloseRestore = useCallback(() => {
		if (closeMenuTimeoutRef.current) {
			clearTimeout(closeMenuTimeoutRef.current)
		}
		closeMenuTimeoutRef.current = setTimeout(() => {
			setShowRestoreConfirm(false)
		}, 350)
	}, [])

	const cancelCloseRestore = useCallback(() => {
		if (closeMenuTimeoutRef.current) {
			clearTimeout(closeMenuTimeoutRef.current)
			closeMenuTimeoutRef.current = null
		}
	}, [])

	// Debounce cleanup
	useEffect(() => {
		return () => {
			if (closeMenuTimeoutRef.current) {
				clearTimeout(closeMenuTimeoutRef.current)
				closeMenuTimeoutRef.current = null
			}
		}
	}, [showRestoreConfirm])

	// Clear "Restore Files" button when checkpoint is no longer checked out
	useEffect(() => {
		if (!isCheckpointCheckedOut && restoreWorkspaceDisabled) {
			setRestoreWorkspaceDisabled(false)
		}
	}, [isCheckpointCheckedOut, restoreWorkspaceDisabled])

	const { refs, floatingStyles, update, placement } = useFloating({
		placement: "bottom-end",
		middleware: [
			offset({
				mainAxis: 8,
				crossAxis: 10,
			}),
			flip(),
			shift(),
		],
	})

	useEffect(() => {
		if (!refs.reference.current || !refs.floating.current) return
		return autoUpdate(refs.reference.current, refs.floating.current, update, { ancestorScroll: true, ancestorResize: true })
	}, [update, refs.reference, refs.floating])

	useEffect(() => {
		if (showRestoreConfirm) {
			update()
		}
	}, [showRestoreConfirm, update])

	// Use the onRelinquishControl hook instead of message event
	useEffect(() => {
		return onRelinquishControl(() => {
			setCompareDisabled(false)
			setRestoreTaskDisabled(false)
			setRestoreWorkspaceDisabled(false)
			setRestoreBothDisabled(false)
			setShowRestoreConfirm(false)
			setShowMoreOptions(false)
		})
	}, [onRelinquishControl])

	const handleRestoreTask = async () => {
		setRestoreTaskDisabled(true)
		try {
			const restoreType: DiracCheckpointRestore = "task"
			await CheckpointsServiceClient.checkpointRestore(
				CheckpointRestoreRequest.create({
					number: messageTs,
					restoreType,
				}),
			)
		} catch (err) {
			console.error("Checkpoint restore task error:", err)
		} finally {
			setRestoreTaskDisabled(false)
		}
	}

	const handleRestoreWorkspace = async () => {
		setRestoreWorkspaceDisabled(true)
		try {
			const restoreType: DiracCheckpointRestore = "workspace"
			await CheckpointsServiceClient.checkpointRestore(
				CheckpointRestoreRequest.create({
					number: messageTs,
					restoreType,
				}),
			)
		} catch (err) {
			console.error("Checkpoint restore workspace error:", err)
		} finally {
			setRestoreWorkspaceDisabled(false)
		}
	}

	const handleRestoreBoth = async () => {
		setRestoreBothDisabled(true)
		try {
			const restoreType: DiracCheckpointRestore = "taskAndWorkspace"
			await CheckpointsServiceClient.checkpointRestore(
				CheckpointRestoreRequest.create({
					number: messageTs,
					restoreType,
				}),
			)
		} catch (err) {
			console.error("Checkpoint restore both error:", err)
		} finally {
			setRestoreBothDisabled(false)
		}
	}

	const handleMouseEnter = () => {
		cancelCloseRestore()
	}

	const handleMouseLeave = () => {
		scheduleCloseRestore()
	}

	const handleControlsMouseEnter = () => {
		cancelCloseRestore()
	}

	const handleControlsMouseLeave = () => {
		scheduleCloseRestore()
	}

	const containerClasses = cn(
		"flex items-center py-0 px-0 gap-1 relative min-w-0 min-h-[17px] -mt-[2px] mb-px h-2",
		"transition-opacity",
		isCheckpointCheckedOut || showRestoreConfirm ? "opacity-100" : "opacity-50",
		"group/chkpt hover:opacity-100",
	)

	return (
		<div className={containerClasses} onMouseEnter={handleControlsMouseEnter} onMouseLeave={handleControlsMouseLeave}>
			<BookmarkIcon
				className={cn("text-xs shrink-0 size-2", {
					"text-link": isCheckpointCheckedOut,
					"text-description": !isCheckpointCheckedOut,
				})}
			/>
			<DottedLine isCheckedOut={isCheckpointCheckedOut} className="group-hover/chkpt:hidden flex-1" />
			<div className="hidden group-hover/chkpt:flex flex-1 items-center gap-1">
				<span
					className={cn("text-[9px] shrink-0", {
						"text-link": isCheckpointCheckedOut,
						"text-description": !isCheckpointCheckedOut,
					})}>
					{isCheckpointCheckedOut ? "Checkpoint (restored)" : "Checkpoint"}
				</span>
				<DottedLine isCheckedOut={isCheckpointCheckedOut} />
				<div className="flex items-center gap-1 shrink-0">
					<CheckpointButton
						isCheckedOut={isCheckpointCheckedOut}
						disabled={compareDisabled}
						onClick={async () => {
							setCompareDisabled(true)
							try {
								await CheckpointsServiceClient.checkpointDiff(
									Int64Request.create({
										value: messageTs,
									}),
								)
							} catch (err) {
								console.error("CheckpointDiff error:", err)
							} finally {
								setCompareDisabled(false)
							}
						}}
						className={cn(compareDisabled && "cursor-wait")}>
						Compare
					</CheckpointButton>
					<DottedLine isCheckedOut={isCheckpointCheckedOut} small />
					<div ref={refs.setReference} className="relative -mt-0.5">
						<CheckpointButton
							isCheckedOut={isCheckpointCheckedOut}
							isActive={showRestoreConfirm}
							onClick={() => setShowRestoreConfirm(true)}>
							Restore
						</CheckpointButton>
						{showRestoreConfirm &&
							createPortal(
								<div
									className={popupClasses}
									data-placement={placement}
									onMouseEnter={handleMouseEnter}
									onMouseLeave={handleMouseLeave}
									ref={refs.setFloating}
									style={floatingStyles}>
									<div className="mb-3">
										<Button
											disabled={restoreBothDisabled}
											onClick={handleRestoreBoth}
											className={cn(restoreBothDisabled && "cursor-wait")}>
											<i className="codicon codicon-debug-restart mr-1.5" />
											Restore Files & Task
										</Button>
										<p className="mt-2 mb-0 text-description text-[11px] leading-[14px]">
											Revert files and clear messages after this point
										</p>
									</div>

									<button
										className="w-full py-0.5 bg-transparent border-none text-link text-[11px] cursor-pointer flex items-center justify-start transition-opacity hover:opacity-100 opacity-80 -mb-1"
										onClick={() => setShowMoreOptions(!showMoreOptions)}>
										More options
										<i
											className={`codicon codicon-chevron-${showMoreOptions ? "up" : "down"} ml-1 text-[10px]`}
										/>
									</button>

									{showMoreOptions && (
										<div className="pt-2 mt-1.5 border-t border-(--vscode-editorGroup-border) animate-[slideDown_0.15s_ease-out]">
											<div className="mb-3">
												<Button
													disabled={restoreWorkspaceDisabled || isCheckpointCheckedOut}
													onClick={handleRestoreWorkspace}
													className={cn(
														isCheckpointCheckedOut
															? "cursor-not-allowed"
															: restoreWorkspaceDisabled
																? "cursor-wait"
																: "cursor-pointer",
													)}
													variant="secondary">
													<i className="codicon codicon-file-symlink-directory mr-1.5" />
													Restore Files Only
												</Button>
												<p className="mt-2 mb-0 text-description text-[11px] leading-[14px]">
													Revert files to this checkpoint
												</p>
											</div>
											<div>
												<Button
													disabled={restoreTaskDisabled}
													onClick={handleRestoreTask}
													className={cn(restoreTaskDisabled && "cursor-wait")}
													variant="secondary">
													<i className="codicon codicon-comment-discussion mr-1.5" />
													Restore Task Only
												</Button>
												<p className="mt-2 mb-0 text-description text-[11px] leading-[14px]">
													Clear messages after this point
												</p>
											</div>
										</div>
									)}
								</div>,
								document.body,
							)}
					</div>
					<DottedLine isCheckedOut={isCheckpointCheckedOut} small />
				</div>
			</div>
		</div>
	)
}

/** Dotted separator line using a repeating linear gradient */
function DottedLine({ isCheckedOut, small, className }: { isCheckedOut?: boolean; small?: boolean; className?: string }) {
	const color = isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"
	return (
		<div
			className={cn("h-px min-w-[5px] chkpt-dotted-line", small ? "flex-none w-[5px]" : "flex-1", className)}
			style={{ "--chkpt-color": color } as React.CSSProperties}
		/>
	)
}

/** Dotted-border button used for Compare/Restore actions */
function CheckpointButton({
	children,
	isCheckedOut,
	isActive,
	disabled,
	onClick,
	style,
	className,
}: {
	children: React.ReactNode
	isCheckedOut?: boolean
	isActive?: boolean
	disabled?: boolean
	onClick?: () => void
	style?: React.CSSProperties
	className?: string
}) {
	const borderColor = isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"
	const showSolid = isActive || disabled

	return (
		<button
			className={cn(
				"border-none px-1.5 py-0.5 text-[9px] cursor-pointer relative",
				"hover:not-disabled:text-(--vscode-editor-background) transition-colors",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				className,
			)}
			disabled={disabled}
			onClick={onClick}
			style={{
				background: showSolid ? borderColor : "transparent",
				color: showSolid
					? "var(--vscode-editor-background)"
					: isCheckedOut
						? borderColor
						: "var(--vscode-descriptionForeground)",
				...style,
			}}>
			{!showSolid && (
				<span
					className="absolute inset-0 rounded-[1px] pointer-events-none chkpt-dotted-border"
					style={{ "--chkpt-color": borderColor } as React.CSSProperties}
				/>
			)}
			{children}
		</button>
	)
}
