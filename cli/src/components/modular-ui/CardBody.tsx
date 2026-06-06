import { RenderType } from "@shared/ExtensionMessage"
import { Box, Text, useInput } from "ink"
import React, { useCallback, useEffect, useState } from "react"
import { Diff } from "./Diff"
import { linkifyPaths } from "../../utils/terminal-link"
import { Markdown } from "./Markdown"
import { scrollableCardActive } from "./scrollable-card-state"
export type CardBodyMode = "teaser" | "collapsed" | "expanded"

interface CardBodyProps {
    body?: string
    renderType: RenderType
    isExpanded?: boolean
    maxHeight?: number
    mode?: CardBodyMode
}

const TEASER_MAX_CHARS = 50

/**
 * Extract a single-line plain-text teaser from the body.
 * Strips markdown formatting and takes the first meaningful line.
 */
function extractTeaser(body: string, renderType: RenderType): string {
    const lines = body.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length === 0) return ""
    let first = lines[0].trim()

    // Strip common markdown formatting for a clean teaser
    first = first.replace(/^#{1,6}\s+/, "") // headings
    first = first.replace(/[*_`~]+/g, "") // bold/italic/code
    first = first.replace(/^[-*+]\s+/, "") // list markers
    first = first.replace(/^>\s+/, "") // blockquotes

    // For diffs, show a summary hint
    if (renderType === "diff") {
        const added = lines.filter((l) => l.startsWith("+")).length
        const removed = lines.filter((l) => l.startsWith("-")).length
        if (added > 0 || removed > 0) {
            return `+${added} -${removed} lines`
        }
    }

    if (first.length > TEASER_MAX_CHARS) {
        return first.substring(0, TEASER_MAX_CHARS - 1) + "…"
    }
    return first
}

const RESERVED_LINES = 22

export const CardBody: React.FC<CardBodyProps> = ({ body, renderType, isExpanded = true, maxHeight, mode = "expanded" }) => {
    if (!body) return null

    // Teaser mode: single-line plain text for collapsed chip
    if (mode === "teaser") {
        const teaser = extractTeaser(body, renderType)
        if (!teaser) return null
        return (
            <Text color="gray" italic>
                {teaser}
            </Text>
        )
    }

    const lines = body.split("\n")
    const previewLines = 1
    const defaultMaxLines = 8
    const baseMaxLines = isExpanded ? (maxHeight ? Math.floor(maxHeight / 1) : defaultMaxLines) : previewLines

    // When expanded, cap to terminal viewport to prevent Ink overflow repaint loop
    const terminalRows = process.stdout.rows || 24
    const maxAllowed = Math.max(5, terminalRows - RESERVED_LINES)
    const needsScroll = isExpanded && lines.length > maxAllowed

    let content: React.ReactNode

    if (needsScroll) {
        content = <ScrollableCardBody
            lines={lines}
            visibleLines={maxAllowed}
            renderType={renderType}
        />
    } else {
        const maxLines = baseMaxLines
        const shouldTruncate = lines.length > maxLines
        const displayBody = shouldTruncate ? lines.slice(0, maxLines).join("\n") : body.trim()

        content = (
            <React.Fragment>
                {renderContent(displayBody, renderType)}
                {shouldTruncate && (
                    <Box marginTop={0}>
                        <Text color="gray" dimColor italic>
                            ... {lines.length - maxLines} more lines {isExpanded ? "" : "(Press [v] to expand)"}
                        </Text>
                    </Box>
                )}
            </React.Fragment>
        )
    }

    return (
        <Box flexDirection="column" flexGrow={1}>
            {content}
        </Box>
    )
}

function ScrollableCardBody({
    lines,
    visibleLines,
    renderType,
}: {
    lines: string[]
    visibleLines: number
    renderType: RenderType
}) {
    const [scrollTop, setScrollTop] = useState(0)

    // Signal that this scrollable card is active so the input handler
    // skips arrow-key processing (history, cursor movement)
    useEffect(() => {
        scrollableCardActive.current = true
        return () => { scrollableCardActive.current = false }
    }, [])
    const maxScrollTop = Math.max(0, lines.length - visibleLines)

    const clamp = useCallback(
        (value: number) => Math.max(0, Math.min(value, maxScrollTop)),
        [maxScrollTop],
    )

    useInput(
        (_input, key) => {
            if (key.upArrow) {
                setScrollTop((prev) => clamp(prev - 1))
            } else if (key.downArrow) {
                setScrollTop((prev) => clamp(prev + 1))
            } else if (key.pageUp) {
                setScrollTop((prev) => clamp(prev - visibleLines))
            } else if (key.pageDown) {
                setScrollTop((prev) => clamp(prev + visibleLines))
            }
        },
        { isActive: true },
    )

    const visibleLinesSlice = lines.slice(scrollTop, scrollTop + visibleLines)
    const displayBody = visibleLinesSlice.join("\n")

    const scrollIndicatorTop = scrollTop > 0 ? `↑ ${Math.round((scrollTop / maxScrollTop) * 100)}%` : ""
    const scrollIndicatorBottom = scrollTop < maxScrollTop ? `↓ ${Math.round(((lines.length - scrollTop - visibleLines) / maxScrollTop) * 100)}%` : ""

    return (
        <Box flexDirection="column">
            {scrollIndicatorTop && (
                <Box>
                    <Text color="yellow" dimColor>
                        {scrollIndicatorTop} more above | ↑↓/PgUp/PgDn to scroll
                    </Text>
                </Box>
            )}
            {renderContent(displayBody, renderType)}
            {scrollIndicatorBottom && (
                <Box>
                    <Text color="yellow" dimColor>
                        {scrollIndicatorBottom} more below | ↑↓/PgUp/PgDn to scroll
                    </Text>
                </Box>
            )}
        </Box>
    )
}

function renderContent(body: string, renderType: RenderType): React.ReactNode {
    switch (renderType) {
        case "markdown":
            return <Markdown>{body}</Markdown>
        case "diff":
            return <Diff content={body} />
        case "text":
        default:
            return <Text>{linkifyPaths(body)}</Text>
    }
}