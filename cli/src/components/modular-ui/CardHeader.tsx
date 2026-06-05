import { CardStatus } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"


import Spinner from "ink-spinner"

import React from "react"
import { getIcon, getStatusColor, getStatusIcon } from "../../utils/icon-mapping"
import { extractFirstPath, getPathUrl, terminalLink } from "../../utils/terminal-link"


interface CardHeaderProps {
    header: string
    status: CardStatus
    icon?: string
    isCollapsed?: boolean
    compact?: boolean
}

const truncateHeader = (text: string) => {
    if (text.length <= 50) return text
    const prefix = text.substring(0, 23)
    const suffix = text.substring(text.length - 24)
    return `${prefix}...${suffix}`
}

const StatusBadge: React.FC<{ status: CardStatus }> = ({ status }) => {
    const color = getStatusColor(status)
    const icon = getStatusIcon(status)
    const isRunning = status === "running" || status === "building"

    return (
        <Box>
            <Text color={color}>{isRunning ? <Spinner type="dots" /> : icon}</Text>
            <Box marginLeft={1}>
                <Text color={color} dimColor={status === "pending" || status === "skipped"}>
                    {status.toUpperCase()}
                </Text>
            </Box>
        </Box>
    )
}
export const CardHeader: React.FC<CardHeaderProps> = ({ header, status, icon, isCollapsed, compact }) => {
    const filePath = extractFirstPath(header)
    const displayHeader = truncateHeader(header)

    // Compact mode: single-line for collapsed chip — just icon + header, no status badge or chevron
    if (compact) {
        return (
            <Text bold>
                {getIcon(icon)} {displayHeader}{" "}
                <Text color={getStatusColor(status)}>{getStatusIcon(status)}</Text>
            </Text>
        )
    }

    return (
        <Box alignItems="center" flexDirection="row">
            <Box marginRight={1}>
                <StatusBadge status={status} />
            </Box>
            <Box flexGrow={1}>
                <Text bold>
                    {getIcon(icon)} {displayHeader}
                    {filePath && (
                        <Text color="blue" dimColor>
                            {"  "}
                            {terminalLink(`${getIcon("external-link")} open`, getPathUrl(filePath))}
                        </Text>
                    )}
                </Text>
            </Box>
            <Box marginLeft={1}>
                <Text color="gray" dimColor>
                    {getIcon(isCollapsed ? "chevron-right" : "chevron-down")}
                </Text>
            </Box>
        </Box>
    )
}

