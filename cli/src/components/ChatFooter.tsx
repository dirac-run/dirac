import React from "react"
import { Box, Text } from "ink"
import { COLORS } from "../constants/colors"
import { createContextBar } from "../utils/display"
import type { GitDiffStats } from "../utils/git"
import type { TaskStatus } from "@shared/ExtensionMessage"
import { TaskStatusIndicator } from "./modular-ui/TaskStatusIndicator"

interface ChatFooterProps {
    mode: "act" | "plan"
    modelId: string
    provider: string
    lastApiReqTotalTokens: number
    contextWindowSize: number
    totalCost: number
    workspacePath: string
    gitBranch: string | null
    gitDiffStats: GitDiffStats | null
    autoApproveAll: boolean
    verboseBatch: boolean
    taskStatus?: TaskStatus
    show?: boolean
}

export const ChatFooter: React.FC<ChatFooterProps> = ({
    mode,
    modelId,
    provider,
    lastApiReqTotalTokens,
    contextWindowSize,
    totalCost,
    workspacePath,
    gitBranch,
    gitDiffStats,
    autoApproveAll,
    verboseBatch,
    taskStatus,
    show = true,
}) => {
    if (!show) return null

    return (
        <Box flexDirection="column" width="100%">
            {/* Row 1: Instructions (left, can wrap) | Plan/Act toggle (right, no wrap) */}
            <Box justifyContent="space-between" paddingLeft={1} paddingRight={1} width="100%">
                <Box flexShrink={1} flexWrap="wrap">
                    <Text color="gray">/ for commands · @ for files · Shift+↓ newline · Tab switch mode</Text>
                </Box>
                <Box flexShrink={0} gap={1}>
                    <Box>
                        <Text bold={mode === "plan"} color={mode === "plan" ? "yellow" : undefined}>
                            {mode === "plan" ? "●" : "○"} Plan
                        </Text>
                    </Box>
                    <Box>
                        <Text bold={mode === "act"} color={mode === "act" ? COLORS.primaryBlue : undefined}>
                            {mode === "act" ? "●" : "○"} Act
                        </Text>
                    </Box>
                    <Text color="gray">(Tab)</Text>
                </Box>
            </Box>

            {/* Row 2: Model/context/tokens/cost/status */}
            <Box paddingLeft={1} paddingRight={1}>
                <Text>
                    {provider}:{" "}{modelId} {(() => {
                        const ratio = contextWindowSize > 0 ? lastApiReqTotalTokens / contextWindowSize : 0
                        const barColor = ratio > 0.8 ? "red" : ratio > 0.5 ? "yellow" : "green"
                        const bar = createContextBar(lastApiReqTotalTokens, contextWindowSize)
                        return (
                            <Text>
                                <Text color={barColor}>{bar.filled}</Text>
                                <Text color="gray">{bar.empty}</Text>
                            </Text>
                        )
                    })()}{" "}
                    <Text color="gray">
                        ({lastApiReqTotalTokens.toLocaleString()}) · {(() => {
                            const costColor = totalCost > 5 ? "red" : totalCost > 1 ? "yellow" : "green"
                            return <Text color={costColor}>${totalCost.toFixed(3)}</Text>
                        })()}
                    </Text>{" "}
                </Text>
                <TaskStatusIndicator status={taskStatus} />
            </Box>

            {/* Row 3: Repo/branch/diff stats */}
            <Box paddingLeft={1} paddingRight={1}>
                <Text>
                    {workspacePath.split("/").pop() || workspacePath}
                    {gitBranch && ` (${gitBranch})`}
                    {gitDiffStats && gitDiffStats.files > 0 && (
                        <Text color="gray">
                            {" "}
                            · {gitDiffStats.files} file{gitDiffStats.files !== 1 ? "s" : ""}{" "}
                            <Text color="green">+{gitDiffStats.additions}</Text>{" "}
                            <Text color="red">-{gitDiffStats.deletions}</Text>
                        </Text>
                    )}
                </Text>
            </Box>

            {/* Row 4: Auto-approve toggle */}
            <Box paddingLeft={1} paddingRight={1} gap={2}>
                {autoApproveAll ? (
                    <Text>
                        <Text color="green">⏵⏵ Auto-approve all enabled</Text>
                        <Text color="gray"> (Shift+Tab)</Text>
                    </Text>
                ) : (
                    <Text color="gray">Auto-approve all disabled (Shift+Tab)</Text>
                )}
                <Text color="gray">·</Text>
                {verboseBatch ? (
                    <Text>
                        <Text color="green">⏵⏵ Verbose batch details on</Text>
                        <Text color="gray"> (b)</Text>
                    </Text>
                ) : (
                    <Text color="gray">Verbose batch details off (b)</Text>
                )}
            </Box>
        </Box>
    )
}
