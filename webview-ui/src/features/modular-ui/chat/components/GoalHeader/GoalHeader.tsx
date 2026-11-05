import type { GoalAccounting, GoalStatus, GoalTaskSummary, GoalViewState } from "@shared/goal"
import { GoalControlRequest } from "@shared/proto/dirac/goal"
import {
	AlertTriangleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CirclePauseIcon,
	CirclePlayIcon,
	CircleStopIcon,
	GoalIcon,
	MoreHorizontalIcon,
} from "lucide-react"
import { useCallback, useId, useMemo, useRef, useState } from "react"
import { GoalServiceClient } from "@/shared/api/grpc-client"
import { formatLargeNumber } from "@/shared/lib/format"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog"
import MarkdownBlock from "@/shared/ui/MarkdownBlock"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"

type GoalAction = "resume" | "pause" | "stop"

const STATUS_CLASSES: Record<GoalStatus, string> = {
	working: "border-(--vscode-textLink-foreground) text-(--vscode-textLink-foreground)",
	waiting: "border-(--vscode-editorWarning-foreground) text-(--vscode-editorWarning-foreground)",
	paused: "border-(--vscode-descriptionForeground) text-(--vscode-descriptionForeground)",
	blocked: "border-(--vscode-errorForeground) text-(--vscode-errorForeground)",
	achieved: "border-(--vscode-testing-iconPassed) text-(--vscode-testing-iconPassed)",
	stopped: "border-(--vscode-descriptionForeground) text-(--vscode-descriptionForeground)",
}

export function plainTextObjective(markdown: string): string {
	return markdown
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/```[^\n]*\n?/g, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/g, "$1")
		.replace(/\*\*|~~|\*/g, "")
		.replace(/\\([\\`*_[\]{}()#+.!-])/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "—"
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
	const hours = Math.floor(totalSeconds / 3_600)
	const minutes = Math.floor((totalSeconds % 3_600) / 60)
	const seconds = totalSeconds % 60
	if (hours > 0) return `${hours}h ${minutes}m`
	if (minutes > 0) return `${minutes}m ${seconds}s`
	return `${seconds}s`
}

function formatTokens(value: number | undefined): string {
	return value === undefined ? "—" : formatLargeNumber(value)
}

function formatCost(value: number | undefined): string {
	return value === undefined ? "—" : `$${value.toFixed(4)}`
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 items-center justify-between gap-2">
			<span className="text-description">{label}</span>
			<span className="truncate font-mono text-foreground">{value}</span>
		</div>
	)
}

function AccountingMetrics({ accounting }: { accounting: GoalAccounting }) {
	return (
		<div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-sm border border-foreground/5 bg-foreground/5 p-2 text-xs min-[360px]:grid-cols-2">
			<Metric label="Tokens" value={formatTokens(accounting.totalTokens)} />
			<Metric label="Input" value={formatTokens(accounting.inputTokens)} />
			<Metric label="Output" value={formatTokens(accounting.outputTokens)} />
			<Metric label="Reasoning" value={formatTokens(accounting.reasoningTokens)} />
			<Metric label="Cache read" value={formatTokens(accounting.cacheReadTokens)} />
			<Metric label="Cache write" value={formatTokens(accounting.cacheWriteTokens)} />
			<Metric label="Cost" value={formatCost(accounting.cost)} />
		</div>
	)
}

function ChildSummary({ child }: { child: GoalTaskSummary }) {
	return (
		<li className="rounded-sm border border-foreground/5 bg-foreground/5 px-2 py-1.5">
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<span className="min-w-0 flex-1 truncate text-xs font-medium">{child.title}</span>
				<Badge className="shrink-0 capitalize" type="default" variant="outline">
					{child.status}
				</Badge>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-description">
				{child.runningDurationMs !== undefined && <span>Running {formatDuration(child.runningDurationMs)}</span>}
				{child.idleDurationMs !== undefined && <span>Idle {formatDuration(child.idleDurationMs)}</span>}
				{child.pendingInteractionCount > 0 && (
					<span className="text-warning">
						{child.pendingInteractionCount} pending request{child.pendingInteractionCount === 1 ? "" : "s"}
						{child.pendingInteraction ? ` · ${child.pendingInteraction.kind}` : ""}
					</span>
				)}
			</div>
			{child.terminalSummary && <p className="mb-0 mt-1 line-clamp-2 text-xs text-description">{child.terminalSummary}</p>}
		</li>
	)
}

interface GoalHeaderProps {
	goal: GoalViewState
}

const GoalHeader = ({ goal }: GoalHeaderProps) => {
	const [isExpanded, setIsExpanded] = useState(false)
	const [isOverflowOpen, setIsOverflowOpen] = useState(false)
	const [isStopDialogOpen, setIsStopDialogOpen] = useState(false)
	const [pendingAction, setPendingAction] = useState<GoalAction>()
	const [controlError, setControlError] = useState<string>()
	const detailsId = useId()
	const overflowTriggerRef = useRef<HTMLButtonElement>(null)
	const stopMenuItemRef = useRef<HTMLButtonElement>(null)
	const cancelStopRef = useRef<HTMLButtonElement>(null)
	const objectivePreview = useMemo(() => plainTextObjective(goal.objective.markdown), [goal.objective.markdown])
	const taskChildren = useMemo(() => goal.children.filter((child) => child.role === "task"), [goal.children])
	const pendingChildren = useMemo(() => goal.children.filter((child) => child.pendingInteractionCount > 0), [goal.children])
	const activeStatus = goal.status === "working" || goal.status === "waiting"
	const canResume = goal.status === "paused" || goal.status === "blocked" || (activeStatus && goal.hasLocalExecution === false)
	const canPause = activeStatus && goal.hasLocalExecution !== false
	const canStop = goal.status !== "achieved" && goal.status !== "stopped"

	const runControl = useCallback(
		async (action: GoalAction) => {
			setPendingAction(action)
			setControlError(undefined)
			try {
				const request = GoalControlRequest.create({
					goalId: goal.id,
					...(action === "pause" ? { reason: "Paused from the Goal header" } : {}),
					...(action === "stop" ? { reason: "Stopped from the Goal header" } : {}),
				})
				if (action === "resume") await GoalServiceClient.resumeGoal(request)
				if (action === "pause") await GoalServiceClient.pauseGoal(request)
				if (action === "stop") await GoalServiceClient.stopGoal(request)
			} catch (error) {
				console.error(`[GoalHeader] Failed to ${action} Goal ${goal.id}:`, error)
				const pastTense = action === "resume" ? "resumed" : action === "pause" ? "paused" : "stopped"
				setControlError(`Goal could not be ${pastTense}.`)
			} finally {
				setPendingAction(undefined)
			}
		},
		[goal.id],
	)

	const confirmStop = useCallback(async () => {
		await runControl("stop")
		setIsStopDialogOpen(false)
		window.setTimeout(() => overflowTriggerRef.current?.focus(), 0)
	}, [runControl])

	return (
		<div className="flex flex-col px-3 py-1.5 min-[420px]:px-4">
			<div className="relative z-10 flex flex-col gap-1.5 rounded-md border border-foreground/10 bg-(--vscode-toolbar-hoverBackground)/40 px-2.5 py-2">
				<div className="flex min-w-0 items-center gap-1.5">
					<button
						aria-controls={detailsId}
						aria-expanded={isExpanded}
						aria-label={isExpanded ? "Collapse Goal details" : "Expand Goal details"}
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm bg-transparent text-left text-inherit focus-visible:outline-2 focus-visible:outline-ring"
						onClick={() => setIsExpanded((expanded) => !expanded)}
						type="button">
						{isExpanded ? (
							<ChevronDownIcon aria-hidden="true" className="shrink-0 text-description" size={14} />
						) : (
							<ChevronRightIcon aria-hidden="true" className="shrink-0 text-description" size={14} />
						)}
						<GoalIcon aria-hidden="true" className="shrink-0 text-link" size={14} />
						<span className="min-w-0 flex-1 truncate text-sm font-medium ph-no-capture" title={objectivePreview}>
							{objectivePreview || "Untitled Goal"}
						</span>
					</button>

					<output
						aria-atomic="true"
						aria-label={`Goal status: ${goal.status}${goal.statusReason ? `. ${goal.statusReason}` : ""}`}
						aria-live="polite"
						className="shrink-0"
						title={goal.statusReason}>
						<span
							className={`inline-flex items-center rounded border bg-transparent px-1.5 py-0.5 text-xs font-medium capitalize ${STATUS_CLASSES[goal.status]}`}>
							{goal.status}
						</span>
					</output>

					{goal.followUpActive && (
						<Badge className="hidden shrink-0 min-[520px]:inline-flex" variant="info">
							Follow-up
						</Badge>
					)}

					{canResume && (
						<Button
							aria-label="Resume Goal"
							className="shrink-0"
							disabled={pendingAction !== undefined || goal.followUpActive}
							onClick={() => void runControl("resume")}
							size="xs"
							title={`Resume Goal ${goal.id}`}
							variant="success">
							<CirclePlayIcon aria-hidden="true" />
							<span className="hidden min-[300px]:inline">
								{pendingAction === "resume" ? "Resuming…" : "Resume"}
							</span>
						</Button>
					)}

					{canPause && (
						<Button
							aria-label="Pause Goal"
							className="shrink-0"
							disabled={pendingAction !== undefined}
							onClick={() => void runControl("pause")}
							size="xs"
							title={`Pause Goal ${goal.id}`}
							variant="outline">
							<CirclePauseIcon aria-hidden="true" />
							<span className="hidden min-[300px]:inline">{pendingAction === "pause" ? "Pausing…" : "Pause"}</span>
						</Button>
					)}

					{canStop && (
						<Popover onOpenChange={setIsOverflowOpen} open={isOverflowOpen}>
							<PopoverTrigger asChild>
								<Button
									aria-label="More Goal actions"
									className="shrink-0"
									disabled={pendingAction !== undefined}
									ref={overflowTriggerRef}
									size="icon"
									title="More Goal actions"
									variant="ghost">
									<MoreHorizontalIcon aria-hidden="true" />
								</Button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								aria-label="Goal actions"
								className="w-44 p-1"
								onOpenAutoFocus={(event) => {
									event.preventDefault()
									stopMenuItemRef.current?.focus()
								}}
								role="menu">
								<button
									className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-(--vscode-errorForeground) hover:bg-(--vscode-list-hoverBackground) focus-visible:outline-2 focus-visible:outline-ring"
									onClick={() => {
										setIsOverflowOpen(false)
										setIsStopDialogOpen(true)
									}}
									ref={stopMenuItemRef}
									role="menuitem"
									type="button">
									<CircleStopIcon aria-hidden="true" size={13} />
									Stop Goal…
								</button>
							</PopoverContent>
						</Popover>
					)}
				</div>

				{controlError && (
					<p className="mb-0 mt-0 text-xs text-error" role="alert">
						{controlError}
					</p>
				)}

				{isExpanded && (
					<section
						aria-label="Goal operational details"
						className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto border-t border-foreground/10 pt-2 custom-scrollbar"
						id={detailsId}>
						<section aria-labelledby={`${detailsId}-status`}>
							<h3 className="mb-1 mt-0 text-xs font-medium" id={`${detailsId}-status`}>
								Status and pending work
							</h3>
							<div className="rounded-sm border border-foreground/5 bg-foreground/5 p-2 text-xs">
								<p className="m-0 text-description">
									<span className="font-medium text-foreground">Reason: </span>
									{goal.statusReason ?? `Goal is ${goal.status}.`}
								</p>
								<p className="mb-0 mt-1 text-description">
									<span className="font-medium text-foreground">Pending: </span>
									{goal.pendingInteractionCount === 0
										? "No pending tasklet requests."
										: `${goal.pendingInteractionCount} pending tasklet request${goal.pendingInteractionCount === 1 ? "" : "s"}.`}
								</p>
								{pendingChildren.length > 0 && (
									<ul className="mb-0 mt-1 list-none space-y-0.5 p-0 text-description">
										{pendingChildren.map((child) => (
											<li key={child.id}>
												{child.title} · {child.pendingInteractionCount} pending request{child.pendingInteractionCount === 1 ? "" : "s"}
												{child.pendingInteraction ? ` · ${child.pendingInteraction.kind}` : ""}
											</li>
										))}
									</ul>
								)}
							</div>
						</section>

						<section aria-labelledby={`${detailsId}-objective`}>
							<h3 className="mb-1 mt-0 text-xs font-medium" id={`${detailsId}-objective`}>
								Objective
							</h3>
							<div className="rounded-sm border border-foreground/5 bg-foreground/5 p-2 text-sm ph-no-capture">
								<MarkdownBlock compact markdown={goal.objective.markdown} />
							</div>
						</section>

						<section aria-labelledby={`${detailsId}-tasks`}>
							<div className="mb-1 flex items-center justify-between gap-2">
								<h3 className="m-0 text-xs font-medium" id={`${detailsId}-tasks`}>
									Contained Tasks
								</h3>
								<span className="text-[10px] text-description">{taskChildren.length} total</span>
							</div>
							{taskChildren.length > 0 ? (
								<ul className="m-0 flex list-none flex-col gap-1 p-0">
									{taskChildren.map((child) => (
										<ChildSummary child={child} key={child.id} />
									))}
								</ul>
							) : (
								<p className="mb-0 mt-0 text-xs text-description">No contained Tasks yet.</p>
							)}
						</section>

						<section aria-labelledby={`${detailsId}-verification`}>
							<h3 className="mb-1 mt-0 text-xs font-medium" id={`${detailsId}-verification`}>
								Latest verification
							</h3>
							{goal.latestVerification ? (
								<ul className="m-0 list-none p-0">
									<ChildSummary child={goal.latestVerification} />
								</ul>
							) : (
								<p className="mb-0 mt-0 text-xs text-description">No verification result recorded.</p>
							)}
						</section>

						<section aria-labelledby={`${detailsId}-timing`}>
							<h3 className="mb-1 mt-0 text-xs font-medium" id={`${detailsId}-timing`}>
								Timing and accounting
							</h3>
							<div className="mb-1 grid grid-cols-1 gap-x-4 gap-y-1 rounded-sm border border-foreground/5 bg-foreground/5 p-2 text-xs min-[360px]:grid-cols-2">
								<Metric label="Active" value={formatDuration(goal.activeDurationMs)} />
								<Metric label="Elapsed" value={formatDuration(goal.wallDurationMs)} />
							</div>
							<AccountingMetrics accounting={goal.accounting} />
						</section>
					</section>
				)}
			</div>

			<Dialog
				onOpenChange={(open) => {
					setIsStopDialogOpen(open)
					if (!open) window.setTimeout(() => overflowTriggerRef.current?.focus(), 0)
				}}
				open={isStopDialogOpen}>
				<DialogContent
					hideClose
					onCloseAutoFocus={(event) => event.preventDefault()}
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						cancelStopRef.current?.focus()
					}}
					role="alertdialog">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-base">
							<AlertTriangleIcon
								aria-hidden="true"
								className="shrink-0 text-(--vscode-errorForeground)"
								size={18}
							/>
							Stop this Goal permanently?
						</DialogTitle>
						<DialogDescription>
							Stopping cancels the coordinator and contained Tasks permanently. This Goal cannot be resumed. Changes
							already made in your workspace remain; stopping does not revert them.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2">
						<DialogClose asChild>
							<Button ref={cancelStopRef} variant="secondary">
								Cancel
							</Button>
						</DialogClose>
						<Button disabled={pendingAction !== undefined} onClick={() => void confirmStop()} variant="danger">
							{pendingAction === "stop" ? "Stopping…" : "Stop Goal permanently"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export default GoalHeader
