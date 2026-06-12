import { Card as CardType, isFinalStatus } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React, { useEffect, useRef } from "react"
import { getStatusColor } from "../../utils/icon-mapping"
import { summarizeFirstLine } from "../../utils/text-clipping"
import { CardBody } from "./CardBody"
import { CardHeader } from "./CardHeader"
import { CardInteractions } from "./CardInteractions"

function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`
    }
    return `${seconds}s`
}

interface ModularCardProps {
    card: CardType
    isStreaming?: boolean
    scrollOffset?: number

    isExpanded?: boolean
    onCollapse?: () => void
    isCompact?: boolean
    maxBodyLines?: number
    suppressBody?: boolean
}

export const ModularCard: React.FC<ModularCardProps> = ({ card, isExpanded = false, isCompact = false, maxBodyLines, onCollapse, scrollOffset, suppressBody = false }) => {
    const {
        header,
        status,
        body,
        renderType,
        icon,
        requireApproval,
        requireFeedback,
        actions,
    } = card

    // Track previous status to detect first terminal transition → auto-collapse
    const prevStatusRef = useRef(status)
    useEffect(() => {
        const wasTerminal = isFinalStatus(prevStatusRef.current)
        const isTerminal = isFinalStatus(status)
        if (isTerminal && !wasTerminal && isExpanded && !card.do_not_auto_collapse) {
            onCollapse?.()
        }
        prevStatusRef.current = status
    }, [status, isExpanded, onCollapse])

    // Collapsed: single-line chip
    // Permission/feedback cards must show their body while awaiting input so the user knows what they're approving.
    const shouldForceExpand = (requireApproval || requireFeedback) && !isFinalStatus(status) && !suppressBody
    if ((isCompact || !isExpanded) && !shouldForceExpand) {
        const elapsed = card.startTime && card.endTime
            ? formatElapsed(card.endTime - card.startTime)
            : undefined
        return (
            <Text>
                <Text color="gray">⎿ </Text>
                <CardHeader header={header} icon={icon} isCollapsed={true} status={status} compact={true} />
                {card.outcome && (
                    <React.Fragment>
                        <Text color="gray"> · </Text>
                        <Text color="gray" dimColor>{card.outcome}</Text>
                    </React.Fragment>
                )}
                {elapsed && (
                    <React.Fragment>
                        <Text color="gray"> · </Text>
                        <Text color="gray" dimColor>{elapsed}</Text>
                    </React.Fragment>
                )}
                {body && !card.outcome && (
                    <React.Fragment>
                        <Text color="gray"> · </Text>
                        <Text color="gray" dimColor italic>
                            {summarizeFirstLine(body, 80)}
                        </Text>
                    </React.Fragment>
                )}
            </Text>
        )
    }

    // Expanded: indented text lines, no Box layout
    return (
        <Box flexDirection="column">
            <Text>
                <Text color={getStatusColor(status)}>  </Text>
                <CardHeader header={header} icon={icon} isCollapsed={false} status={status} />
            </Text>
            {body && !suppressBody && (
                <Box flexDirection="column" paddingLeft={5}>
                    <CardBody body={body} maxLines={maxBodyLines} renderType={renderType} scrollOffset={scrollOffset} />
                </Box>
            )}
            <CardInteractions
                actions={actions}
                feedbackPlaceholder={card.feedbackPlaceholder}
                requireFeedback={requireFeedback}
            />
        </Box>
    )
}

