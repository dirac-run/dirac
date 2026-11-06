import type { GoalChildStatus, GoalViewState } from "@shared/goal"
import { Box, Text, useInput } from "ink"
import React, { useEffect, useMemo, useState } from "react"
import { theme } from "../constants/theme"
import { useStdinContext } from "../context/StdinContext"

const NONTERMINAL_CHILD_STATUSES: readonly GoalChildStatus[] = ["accepted", "starting", "running", "waiting"]
const CHILD_PAGE_SIZE = 5

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "unavailable"
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
	if (totalSeconds < 60) return `${totalSeconds}s`
	const totalMinutes = Math.floor(totalSeconds / 60)
	if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`
	const totalHours = Math.floor(totalMinutes / 60)
	return `${totalHours}h ${totalMinutes % 60}m`
}

function statusColor(status: GoalViewState["status"] | GoalChildStatus): string {
	if (status === "achieved" || status === "completed") return theme.success
	if (status === "blocked" || status === "failed") return theme.error
	if (status === "waiting" || status === "paused" || status === "interrupted") return theme.warning
	if (status === "stopped" || status === "cancelled") return theme.muted
	return theme.link
}

function statusSymbol(status: GoalViewState["status"] | GoalChildStatus): string {
	if (status === "achieved" || status === "completed") return theme.symbols.success
	if (status === "blocked" || status === "failed") return theme.symbols.failure
	if (status === "waiting" || status === "paused" || status === "interrupted") return theme.symbols.warning
	if (status === "stopped" || status === "cancelled") return theme.symbols.inactive
	if (status === "accepted") return theme.symbols.inactive
	return theme.symbols.active
}

function accountingSummary(goal: GoalViewState): string {
	const entries: string[] = []
	const accounting = goal.accounting
	if (accounting.totalTokens !== undefined) entries.push(`${accounting.totalTokens.toLocaleString()} tokens`)
	if (accounting.inputTokens !== undefined) entries.push(`${accounting.inputTokens.toLocaleString()} in`)
	if (accounting.outputTokens !== undefined) entries.push(`${accounting.outputTokens.toLocaleString()} out`)
	if (accounting.reasoningTokens !== undefined) entries.push(`${accounting.reasoningTokens.toLocaleString()} reasoning`)
	if (accounting.cacheReadTokens !== undefined) entries.push(`${accounting.cacheReadTokens.toLocaleString()} cache read`)
	if (accounting.cacheWriteTokens !== undefined) entries.push(`${accounting.cacheWriteTokens.toLocaleString()} cache write`)
	if (accounting.cost !== undefined) entries.push(`$${accounting.cost.toFixed(4)}`)
	return entries.length > 0 ? entries.join(` ${theme.symbols.separator} `) : "unavailable"
}

function goalControls(goal: GoalViewState): string {
	if (goal.hasLocalExecution === false && (goal.status === "working" || goal.status === "waiting")) {
		return "Ctrl+R Resume here · Ctrl+X Stop (requires ownership)"
	}
	const turnControl = goal.followUpActive ? "Esc Cancel turn · " : ""
	if (goal.status === "working" || goal.status === "waiting") {
		return `${turnControl}Ctrl+P Pause · Ctrl+X Stop permanently`
	}
	if (goal.status === "paused" || goal.status === "blocked") {
		return `${turnControl}Ctrl+R Resume · Ctrl+X Stop permanently · follow-up chat available`
	}
	return goal.followUpActive ? "Esc cancels this turn" : "Follow-up chat available"
}

function plainTextObjective(markdown: string): string {
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

export const GoalSummary: React.FC<{
	goal: GoalViewState
	detailsExpanded: boolean
	height: number
	isProcessing: boolean
	isStopConfirmationPending: boolean
	onPageNavigation: () => void
}> = ({ goal, detailsExpanded, height, isProcessing, isStopConfirmationPending, onPageNavigation }) => {
	const { isRawModeSupported } = useStdinContext()
	const [childPageIndex, setChildPageIndex] = useState(0)
	const childCounts = useMemo(() => {
		const counts = new Map<GoalChildStatus, number>()
		for (const child of goal.children) counts.set(child.status, (counts.get(child.status) ?? 0) + 1)
		return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(` ${theme.symbols.separator} `)
	}, [goal.children])
	const orderedChildren = useMemo(() => {
		const nonterminalChildren = goal.children.filter((child) => NONTERMINAL_CHILD_STATUSES.includes(child.status))
		const terminalChildren = goal.children.filter((child) => !NONTERMINAL_CHILD_STATUSES.includes(child.status)).reverse()
		return [...nonterminalChildren, ...terminalChildren]
	}, [goal.children])
	const childPageCount = Math.max(1, Math.ceil(orderedChildren.length / CHILD_PAGE_SIZE))
	const visibleChildren = orderedChildren.slice(childPageIndex * CHILD_PAGE_SIZE, (childPageIndex + 1) * CHILD_PAGE_SIZE)

	useEffect(() => setChildPageIndex(0), [goal.id])
	useEffect(() => {
		setChildPageIndex((current) => Math.min(current, childPageCount - 1))
	}, [childPageCount])

	useInput(
		(_input, key) => {
			if (key.pageUp) {
				onPageNavigation()
				setChildPageIndex((current) => Math.max(0, current - 1))
			}
			if (key.pageDown) {
				onPageNavigation()
				setChildPageIndex((current) => Math.min(childPageCount - 1, current + 1))
			}
		},
		{ isActive: isRawModeSupported && detailsExpanded && childPageCount > 1 },
	)

	const controls = isProcessing
		? "Applying Goal control…"
		: isStopConfirmationPending
			? "Ctrl+X again within 5s to permanently Stop this Goal (cannot resume) · Esc cancel"
			: goalControls(goal)
	const detailsControl = `Ctrl+G ${detailsExpanded ? "Hide details" : "Details"}`
	const summary = goal.children.length === 0 ? "no children" : childCounts
	const pending =
		goal.pendingInteractionCount > 0
			? ` ${theme.symbols.separator} ${goal.pendingInteractionCount} pending interaction${goal.pendingInteractionCount === 1 ? "" : "s"}`
			: ""

	return (
		<Box
			borderColor={isStopConfirmationPending ? theme.warning : theme.border}
			borderStyle="round"
			flexDirection="column"
			height={height}
			overflow="hidden"
			paddingX={1}
			width="100%">
			<Box justifyContent="space-between" width="100%">
				<Text bold color={theme.primary}>
					{detailsExpanded ? theme.symbols.expanded : theme.symbols.collapsed} Goal
				</Text>
				<Text bold color={statusColor(goal.status)}>
					{statusSymbol(goal.status)} {goal.status.toUpperCase()}
				</Text>
			</Box>
			<Text color={isStopConfirmationPending ? theme.warning : theme.muted} wrap="truncate-end">
				{`${controls} ${theme.symbols.separator} ${detailsControl}`}
			</Text>

			{!detailsExpanded ? (
				<Text color={theme.text} wrap="truncate-end">
					{`${plainTextObjective(goal.objective.markdown)} ${theme.symbols.separator} ${summary}${pending} ${theme.symbols.separator} age ${formatDuration(goal.wallDurationMs)}`}
				</Text>
			) : (
				<React.Fragment>
					{goal.statusReason && (
						<Text color={theme.warning} wrap="truncate-end">
							Reason: {goal.statusReason}
						</Text>
					)}
					<Text color={theme.text} wrap="truncate-end">
						<Text bold color={theme.strongText}>
							Objective
						</Text>
						{` ${theme.symbols.separator} ${plainTextObjective(goal.objective.markdown)}`}
					</Text>
					<Text bold color={theme.strongText}>
						Children{" "}
						<Text color={theme.muted}>
							({summary}
							{pending})
						</Text>
					</Text>
					{visibleChildren.map((child) => (
						<Text key={child.id} wrap="truncate-end">
							<Text color={statusColor(child.status)}>
								{statusSymbol(child.status)} {child.status}
							</Text>
							<Text color={theme.muted}>{` ${theme.symbols.separator} ${child.role}`}</Text>
							{` ${theme.symbols.separator} ${child.title}`}
							{child.runningDurationMs !== undefined && (
								<Text color={theme.muted}>{` ${theme.symbols.separator} run ${formatDuration(child.runningDurationMs)}`}</Text>
							)}
							{child.idleDurationMs !== undefined && (
								<Text color={theme.muted}>{` ${theme.symbols.separator} idle ${formatDuration(child.idleDurationMs)}`}</Text>
							)}
						</Text>
					))}
					{childPageCount > 1 && (
						<Text color={theme.muted}>
							{`PgUp/PgDn children ${theme.symbols.separator} page ${childPageIndex + 1}/${childPageCount}`}
						</Text>
					)}
					{goal.latestVerification && (
						<Text color={statusColor(goal.latestVerification.status)} wrap="truncate-end">
							Verification {theme.symbols.separator} {statusSymbol(goal.latestVerification.status)}{" "}
							{goal.latestVerification.status} {theme.symbols.separator} {goal.latestVerification.title}
							{goal.latestVerification.terminalSummary
								? ` ${theme.symbols.separator} ${goal.latestVerification.terminalSummary}`
								: ""}
						</Text>
					)}
					<Text color={theme.muted} wrap="truncate-end">
						{`${goal.id} ${theme.symbols.separator} age ${formatDuration(goal.wallDurationMs)} ${theme.symbols.separator} active ${formatDuration(goal.activeDurationMs)}`}
					</Text>
					<Text
						color={theme.muted}
						wrap="truncate-end">{`Accounting ${theme.symbols.separator} ${accountingSummary(goal)}`}</Text>
				</React.Fragment>
			)}
		</Box>
	)
}
