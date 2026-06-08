import { Box, Text } from "ink"
import React from "react"
import { getIcon } from "../../utils/icon-mapping"
import type { ItemSummary, MessageBatch } from "./BatchGrouping"

const MAX_DETAIL_ROWS = 5

const STATUS_ICONS: Record<string, string> = {
    success: "✓",
    error: "✕",
    skipped: "↷",
    cancelled: "⊘",
}

const STATUS_COLORS: Record<string, string> = {
    success: "green",
    error: "red",
    skipped: "gray",
    cancelled: "gray",
}

function StatusSymbol({ status }: { status: ItemSummary["status"] }) {
    return (
        <Text color={STATUS_COLORS[status] || "gray"}>
            {STATUS_ICONS[status] || "✓"}
        </Text>
    )
}

function SummaryLine({ batch, isExpanded }: { batch: MessageBatch; isExpanded: boolean }) {
    const icon = getIcon(batch.icon)
    const hasErrors = batch.errorCount > 0
    const statusText = hasErrors
        ? `${batch.successCount}✓ ${batch.errorCount}✕`
        : `${batch.totalCount}✓`
    const chevron = isExpanded ? "▾" : "▸"

    return (
        <Text bold>
            {icon} {batch.actionVerb} {batch.totalCount} {batch.noun}{" "}
            {hasErrors ? (
                <React.Fragment>
                    <Text color="green">{batch.successCount}✓</Text>{" "}
                    <Text color="red">{batch.errorCount}✕</Text>
                </React.Fragment>
            ) : (
                <Text color="green">{statusText}</Text>
            )}
            {batch.totalAdditions !== undefined && batch.totalDeletions !== undefined && (batch.totalAdditions > 0 || batch.totalDeletions > 0) && (
                <Text color="gray"> · <Text color="green">+{batch.totalAdditions}</Text> <Text color="red">-{batch.totalDeletions}</Text> lines</Text>
            )}
            <Text color="gray"> {chevron}</Text>
        </Text>
    )
}

function DetailRows({ batch, maxRows, verbose }: { batch: MessageBatch; maxRows?: number; verbose?: boolean }) {
    const limit = verbose ? batch.itemSummaries.length : (maxRows ?? MAX_DETAIL_ROWS)
    const shown = batch.itemSummaries.slice(0, limit)
    const remaining = batch.itemSummaries.length - limit
    const connector = (idx: number) => (idx === shown.length - 1 && remaining === 0 ? "└" : "├")

    return (
        <Box flexDirection="column" marginLeft={2}>
            {shown.map((item, idx) => {
                const card = batch.messages[idx]?.content?.type === "card" ? batch.messages[idx].content.card : undefined
                const body = verbose && card?.body ? card.body.trim() : undefined
                return (
                    <Box key={idx} flexDirection="column">
                        <Box flexDirection="row">
                            <Text color="gray"> {connector(idx)} </Text>
                            <StatusSymbol status={item.status} />
                            <Text> {item.text}</Text>
                        </Box>
                        {body && (
                            <Box flexDirection="row" marginLeft={4}>
                                <Text color="gray" dimColor>{body.split("\n")[0]?.substring(0, 80)}</Text>
                            </Box>
                        )}
                    </Box>
                )
            })}
            {remaining > 0 && (
                <Box flexDirection="row">
                    <Text color="gray"> └ </Text>
                    <Text color="gray" dimColor>
                        +{remaining} more
                    </Text>
                </Box>
            )}
        </Box>
    )
}

interface BatchSummaryCardProps {
    batch: MessageBatch
    isExpanded?: boolean
    verbose?: boolean
}

export const BatchSummaryCard: React.FC<BatchSummaryCardProps> = ({ batch, isExpanded = false, verbose = false }) => {
    return (
        <Box flexDirection="column" marginBottom={0} marginTop={0} width="100%">
            <SummaryLine batch={batch} isExpanded={isExpanded} />
            <DetailRows batch={batch} maxRows={isExpanded ? MAX_DETAIL_ROWS : 3} verbose={verbose} />
        </Box>
    )
}
