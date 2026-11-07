import { theme } from "../constants/theme"
import React from "react"
import { Box, Text } from "ink"
import { createContextBar } from "../utils/display"
import type { GitDiffStats } from "../utils/git"
import type { TaskStatus } from "@shared/ExtensionMessage"
import type { TaskletActivitySummary } from "@shared/taskletObservation"
import { TaskStatusIndicator } from "./modular-ui/TaskStatusIndicator"
import path from "node:path"
import { useTerminalSize } from "../hooks/useTerminalSize"
import type { VimMode } from "../utils/vim-editor"

interface ChatFooterProps {
	mode: "act" | "plan"
	modelId: string
	fastModeEnabled: boolean
	provider: string
	lastApiReqTotalTokens: number
	contextWindowSize: number
	totalCost: number
	cacheHitRate: number
	workspacePath: string
	gitBranch: string | null
	gitDiffStats: GitDiffStats | null
	autoApproveAll: boolean
	yoloMode: boolean
	quietMode: boolean
	taskStatus?: TaskStatus
	taskletActivity?: TaskletActivitySummary | null
	show?: boolean
	isGoalActive?: boolean
	vimMode?: VimMode
}

export const ChatFooter: React.FC<ChatFooterProps> = ({
	mode,
	modelId,
	fastModeEnabled,
	provider,
	lastApiReqTotalTokens,
	contextWindowSize,
	totalCost,
	cacheHitRate,
	workspacePath,
	gitBranch,
	gitDiffStats,
	autoApproveAll,
	yoloMode,
	quietMode,
	taskStatus,
	taskletActivity,
	show = true,
	isGoalActive = false,
	vimMode,
}) => {
	const { columns } = useTerminalSize()
	if (!show) return null
	const compact = columns < 64
	const historyHint = columns < 48 ? "Ctrl+↑↓ prompts" : compact ? "Ctrl+↑/↓ history" : "Ctrl+↑/↓ previous prompts"
	const boundedCacheHitRate = Math.max(0, Math.min(1, cacheHitRate))
	const workspaceName = workspacePath.includes("\\") ? path.win32.basename(workspacePath) : path.basename(workspacePath)

	if (isGoalActive) {
		return (
			<Box flexDirection="column" width="100%">
				<Box paddingLeft={1} paddingRight={1} width="100%">
					<Text color={theme.muted} wrap="truncate-end">
						<Text bold color={mode === "plan" ? theme.plan : theme.primary}>
							{theme.symbols.active} {mode === "plan" ? "Plan" : "Act"}
							{compact ? "" : " (Goal)"}
						</Text>
						{vimMode && ` · ${vimMode.toUpperCase()}`}
						{taskletActivity && " · "}
						<AgentActivity activity={taskletActivity} />
						{compact
							? ` · ${historyHint} · @ files · / commands · Ctrl+G details`
							: ` · ${historyHint} · / commands · @ files · Ctrl+G details · Shift+Enter/↓ newline`}
					</Text>
				</Box>
				<Box paddingLeft={1} paddingRight={1} width="100%">
					<Text color={theme.muted} wrap="truncate-end">
						<Text color={theme.text}>
							{provider}: {modelId}
							{fastModeEnabled ? " fast" : ""}
						</Text>
						{` ${theme.symbols.separator} ${workspaceName || workspacePath}${gitBranch ? ` (${gitBranch})` : ""}`}
						{gitDiffStats && gitDiffStats.files > 0 && (
							<Text>
								{" "}
								{theme.symbols.separator} {gitDiffStats.files} files{" "}
								<Text color={theme.success}>+{gitDiffStats.additions}</Text>{" "}
								<Text color={theme.error}>-{gitDiffStats.deletions}</Text>
							</Text>
						)}
						{` ${theme.symbols.separator} Auto ${autoApproveAll ? "on" : "off"} ${theme.symbols.separator} YOLO ${yoloMode ? "on" : "off"} ${theme.symbols.separator} Quiet ${quietMode ? "on" : "off"}`}
					</Text>
				</Box>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" width="100%">
			{/* Row 1: Instructions (left, can wrap) | Plan/Act toggle (right, no wrap) */}
			<Box justifyContent="space-between" paddingLeft={1} paddingRight={1} width="100%">
				{compact ? (
					<Text color={theme.muted} wrap="truncate-end">
						<Text bold color={mode === "plan" ? theme.plan : theme.primary}>
							{mode === "plan" ? "Plan" : "Act"}
						</Text>
						{vimMode && ` · ${vimMode.toUpperCase()}`}
						{` · ${historyHint} · / commands · @ files · Tab mode`}
					</Text>
				) : (
					<Box flexShrink={1}>
						<Text color={theme.muted} wrap="truncate-end">
							{vimMode && `${vimMode.toUpperCase()} · `}
							{historyHint} · / commands · @ files · Shift+Enter/↓ newline · Tab mode
						</Text>
					</Box>
				)}
				{!compact && (
					<Box flexShrink={0} gap={1}>
						<Box>
							<Text bold={mode === "plan"} color={mode === "plan" ? theme.plan : undefined}>
								{mode === "plan" ? theme.symbols.active : theme.symbols.inactive} Plan
							</Text>
						</Box>
						<Box>
							<Text bold={mode === "act"} color={mode === "act" ? theme.primary : theme.muted}>
								{mode === "act" ? theme.symbols.active : theme.symbols.inactive} Act
							</Text>
						</Box>
						<Text color={theme.muted}>(Tab)</Text>
					</Box>
				)}
			</Box>

			{/* Row 2: Model/context/tokens/cost/status */}
			<Box paddingLeft={1} paddingRight={1}>
				<Text wrap="truncate-end">
					<AgentActivity activity={taskletActivity} />
					{taskletActivity && " · "}
					{provider}: {modelId}
					{fastModeEnabled ? " fast" : ""} {(() => {
						const ratio = contextWindowSize > 0 ? lastApiReqTotalTokens / contextWindowSize : 0
						const barColor =
							ratio > theme.contextDanger
								? theme.error
								: ratio > theme.contextWarning
									? theme.warning
									: theme.success
						const bar = createContextBar(lastApiReqTotalTokens, contextWindowSize)
						return (
							<Text>
								<Text color={barColor}>{bar.filled}</Text>
								<Text color={theme.muted}>{bar.empty}</Text>
							</Text>
						)
					})()} <Text color={theme.muted}>
						({lastApiReqTotalTokens.toLocaleString()}) · {(() => {
							const costColor =
								totalCost > theme.costDanger
									? theme.error
									: totalCost > theme.costWarning
										? theme.warning
										: theme.success
							return <Text color={costColor}>${totalCost.toFixed(3)}</Text>
						})()}
					</Text>{" "}
					{boundedCacheHitRate > 0 && (
						<React.Fragment>
							<Text
								color={
									boundedCacheHitRate >= 0.7
										? theme.success
										: boundedCacheHitRate >= 0.35
											? theme.info
											: theme.muted
								}>
								{(boundedCacheHitRate * 100).toFixed(0)}% cache
							</Text>{" "}
						</React.Fragment>
					)}
				</Text>
				<TaskStatusIndicator status={taskStatus} />
			</Box>

			{/* Row 3: Repo/branch/diff stats */}
			<Box paddingLeft={1} paddingRight={1}>
				<Text color={theme.muted} wrap="truncate-end">
					<Text color={theme.text}>{workspaceName || workspacePath}</Text>
					{gitBranch && <Text color={theme.subtle}> ({gitBranch})</Text>}
					{gitDiffStats && gitDiffStats.files > 0 && (
						<Text>
							{" "}
							· {gitDiffStats.files} file{gitDiffStats.files !== 1 ? "s" : ""}{" "}
							<Text color={theme.success}>+{gitDiffStats.additions}</Text>{" "}
							<Text color={theme.error}>-{gitDiffStats.deletions}</Text>
						</Text>
					)}
				</Text>
			</Box>

			{/* Row 4: Auto-approve, YOLO, and quiet mode indicators */}
			<Box paddingLeft={1} paddingRight={1}>
				<Text wrap="truncate-end">
					{autoApproveAll ? (
						<React.Fragment>
							<Text color={theme.success}>⏵⏵ Auto-approve all enabled</Text>
							<Text color={theme.muted}> (Shift+Tab)</Text>
						</React.Fragment>
					) : (
						<Text color={theme.muted}>Auto-approve all disabled (Shift+Tab)</Text>
					)}
					<Text color={theme.muted}> · </Text>
					{yoloMode ? (
						<Text bold color={theme.warning}>
							⚠ YOLO mode enabled
						</Text>
					) : (
						<Text color={theme.muted}>YOLO mode disabled</Text>
					)}
					<Text color={theme.muted}> · </Text>
					{quietMode ? (
						<Text color={theme.success}>Quiet mode enabled (/quiet)</Text>
					) : (
						<Text color={theme.muted}>Quiet mode disabled (/quiet)</Text>
					)}
				</Text>
			</Box>
		</Box>
	)
}

const AgentActivity = React.memo(
	({ activity }: { activity?: TaskletActivitySummary | null }) => {
		if (!activity) return null
		return (
			<Text color={theme.muted}>
				{activity.availability === "live" ? `Agents · ${activity.activeCount} active` : "Agents · saved"}
			</Text>
		)
	},
	(previous, next) =>
		previous.activity?.sourceId === next.activity?.sourceId && previous.activity?.activeCount === next.activity?.activeCount,
)
