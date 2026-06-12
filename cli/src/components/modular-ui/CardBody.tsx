import { RenderType } from "@shared/ExtensionMessage"
import React from "react"
import { Text, Box } from "ink"
import { Diff } from "./Diff"
import { linkifyPaths } from "../../utils/terminal-link"
import { clipTextToWindow } from "../../utils/text-clipping"
import { Markdown } from "./Markdown"

interface CardBodyProps {
    body?: string
    maxLines?: number
    renderType: RenderType
    scrollOffset?: number
    renderWidth?: number
}

export const CardBody: React.FC<CardBodyProps> = ({ body, maxLines, renderType, scrollOffset, renderWidth }) => {
    if (!body) return null
    const columns = Math.max(1, renderWidth ?? (process.stdout.columns || 80) - 6)
    const { visibleText, hasMoreAbove, hasMoreBelow } = maxLines
        ? clipTextToWindow(body, maxLines, columns, scrollOffset ?? 0)
        : { visibleText: body, hasMoreAbove: false, hasMoreBelow: false }
    return (
        <React.Fragment>
            {renderContent(visibleText, renderType, columns)}
            {(hasMoreAbove || hasMoreBelow) && (
                <Box marginTop={0}>
                    <Text color="gray" dimColor>
                        {hasMoreAbove ? "↑ " : ""}scroll{hasMoreBelow ? " ↓" : ""}
                    </Text>
                </Box>
            )}
        </React.Fragment>
    )
}

function renderContent(body: string, renderType: RenderType, width: number): React.ReactNode {
    switch (renderType) {
        case "markdown":
            return <Markdown width={width}>{body}</Markdown>
        case "diff":
            return <Diff content={body} width={width} />
        case "text":
        default:
            return <Text>{linkifyPaths(body)}</Text>
    }
}
