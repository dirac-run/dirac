import { Card as CardType } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"
import { COLORS } from "../constants/colors"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { clipTextToWindow } from "../utils/text-clipping"
import { CardBody } from "./modular-ui/CardBody"
import { CardHeader } from "./modular-ui/CardHeader"

interface PermissionModalProps {
    card: CardType
    scrollOffset: number
    maxScrollOffset: number
    bodyLines: number
    bodyColumns: number
}

export const PermissionModal: React.FC<PermissionModalProps> = ({
    card,
    scrollOffset,
    maxScrollOffset,
    bodyLines,
    bodyColumns,
}) => {
    const { columns, rows } = useTerminalSize()
    const modalWidth = Math.max(1, Math.min(columns - 2, Math.floor(columns * 0.8)))
    const modalHeight = Math.min(Math.max(12, rows - 4), 32)
    const body = card.body || ""
    const clipped = clipTextToWindow(body, bodyLines, bodyColumns, scrollOffset, "… earlier content clipped …")
    const borderColor = card.requireApproval ? "yellow" : COLORS.primaryBlue

    return (
        <Box
            borderColor={borderColor}
            borderStyle="round"
            flexDirection="column"
            height={modalHeight}
            paddingX={1}
            width={modalWidth}>
            <Box flexShrink={0}>
                <Text bold color={borderColor}>Permission required</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
                <Box flexShrink={0}>
                    <CardHeader header={card.header} icon={card.icon} status={card.status} />
                </Box>
                <Box flexDirection="column" marginTop={1}>
                    <CardBody
                        body={clipped.visibleText}
                        renderType={card.renderType}
                        renderWidth={bodyColumns}
                    />
                </Box>
            </Box>
            <Box flexShrink={0}>
                {renderFooter(card, scrollOffset, maxScrollOffset)}
            </Box>
        </Box>
    )
}

function renderFooter(card: CardType, scrollOffset: number, maxScrollOffset: number): React.ReactNode {
    const canScrollUp = scrollOffset < maxScrollOffset
    const canScrollDown = scrollOffset > 0

    return (
        <Box flexDirection="column">
            {maxScrollOffset > 0 && (
                <Text bold color="yellow">
                    {canScrollUp ? "↑" : " "} / {canScrollDown ? "↓" : " "} SCROLL
                </Text>
            )}
            {card.requireApproval && (
                <Text color="gray">
                    [<Text bold color="white">y</Text>]es / [<Text bold color="white">n</Text>]o
                </Text>
            )}
            {card.requireFeedback && card.actions && card.actions.length > 0 && (
                <Text color="gray">
                    {card.actions.map((action, index) => (
                        <Text key={action.value || action.label}>
                            <Text bold color={action.style === "danger" ? "red" : "cyan"}>{index + 1}</Text> {action.label}
                            {index < card.actions!.length - 1 ? "   " : ""}
                        </Text>
                    ))}
                </Text>
            )}
            {card.requireFeedback && (!card.actions || card.actions.length === 0) && (
                <Text color="gray">Type response and press Enter</Text>
            )}
        </Box>
    )
}
