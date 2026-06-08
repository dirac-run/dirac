import { Card as CardType, isFinalStatus } from "@shared/ExtensionMessage"

function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`
    }
    return `${seconds}s`
}

import { Box, Text } from "ink"
import React, { useEffect, useRef } from "react"
import { getStatusColor } from "../../utils/icon-mapping"
import { CardBody } from "./CardBody"
import { CardHeader } from "./CardHeader"
import { CardInteractions } from "./CardInteractions"

interface ModularCardProps {
    card: CardType
    isStreaming?: boolean
    isExpanded?: boolean
    onCollapse?: () => void
}

export const ModularCard: React.FC<ModularCardProps> = ({ card, isExpanded = false, onCollapse }) => {
    const {
        header,
        status,
        body,
        renderType,
        icon,
        requireApproval,
        requireFeedback,
        actions,
        maxHeight,
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

    // Collapsed: single-row chip — tool icon + header + body teaser
    // Permission/feedback cards must always show their body so the user knows what they're approving
    const shouldForceExpand = requireApproval || requireFeedback
    if (!isExpanded && !shouldForceExpand) {
        const elapsed = card.startTime && card.endTime
            ? formatElapsed(card.endTime - card.startTime)
            : undefined
        return (
            <Box flexDirection="row" marginBottom={0} marginTop={0} width="100%">
                <Box flexDirection="row" flexGrow={1} overflow="hidden">
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
                            <CardBody body={body} mode="teaser" renderType={renderType} />
                        </React.Fragment>
                    )}
                </Box>
            </Box>
        )
    }

    // Expanded: bordered box with status-colored border
    return (
        <Box
            borderColor={getStatusColor(status)}
            borderStyle="round"
            flexDirection="column"
            marginBottom={0}
            marginTop={0}
            paddingX={1}
            width="100%"
        >
            <CardHeader header={header} icon={icon} isCollapsed={false} status={status} />
            <Box flexDirection="column" marginTop={1}>
                <CardBody body={body} isExpanded={true} maxHeight={maxHeight} renderType={renderType} status={status} />
                <CardInteractions
                    actions={actions}
                    feedbackPlaceholder={card.feedbackPlaceholder}
                    requireFeedback={requireFeedback}
                />
            </Box>
        </Box>
    )
}