import { Box, Text } from "ink"
import React, { useMemo } from "react"
import { type ComputedDiff, computeDiff, type DiffBlock, type DiffLine, getGutterWidth } from "../../utils/DiffComputer"
import { linkifyPaths } from "../../utils/terminal-link"
import { useTerminalSize } from "../../hooks/useTerminalSize"

interface DiffProps {
    /** Diff content (SEARCH/REPLACE format, ApplyPatch format, or raw content for new files) */
    content?: string
    /** File path (used for potential syntax highlighting in the future) */
    filePath?: string
    /** Number of context lines to show before/after changes (default: 3) */
    contextLines?: number
}

import { theme } from "../../constants/theme"

const DIFF_COLORS = theme.diff

// Default number of context lines to show
const DEFAULT_CONTEXT_LINES = 2

/**
 * Render a single diff line with gutter and colored content
 */
const DiffLineRow: React.FC<{
    line: DiffLine
    gutterWidth: number
}> = ({ line, gutterWidth }) => {
    if (line.type === "separator") {
        return <Text> </Text>
    }

    const lineNum =
        line.type === "add" ? line.newLineNumber : line.type === "remove" ? line.oldLineNumber : line.newLineNumber
    const lineNumStr = lineNum !== undefined ? lineNum.toString().padStart(gutterWidth, " ") : " ".repeat(gutterWidth)
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " "

    const bgColor = line.type === "add" ? DIFF_COLORS.addBg : line.type === "remove" ? DIFF_COLORS.removeBg : undefined
    const fgColor = line.type === "add" ? DIFF_COLORS.addFg : line.type === "remove" ? DIFF_COLORS.removeFg : undefined

    return (
        <Box flexDirection="row" width="100%">
            {/* Gutter (Line Numbers) */}
            <Box flexShrink={0} width={gutterWidth + 2}>
                <Text color={DIFF_COLORS.gutterFg} dimColor>
                    {lineNumStr}
                    {"  "}
                </Text>
            </Box>

            {/* Content */}
            <Box backgroundColor={bgColor} flexGrow={1} paddingX={1}>
                <Text color={fgColor} dimColor={line.type === "context"}>
                    {prefix} {linkifyPaths(line.content || " ")}
                </Text>
            </Box>
        </Box>
    )
}

/**
 * Render a separator between diff blocks
 */
const BlockSeparator: React.FC = () => {
    const { columns: terminalWidth } = useTerminalSize()
    const ruleWidth = Math.min(40, Math.max(10, terminalWidth - 4))
    return (
        <Box marginY={0}>
            <Text color="gray">{"─".repeat(ruleWidth)}</Text>
        </Box>
    )
}

/**
 * Render an ellipsis row for collapsed context lines
 */
const CollapsedRow: React.FC<{ count: number; gutterWidth: number }> = ({ count, gutterWidth }) => (
    <Box flexDirection="row">
        <Box flexShrink={0}>
            <Text color="gray">{" ".repeat(gutterWidth)} </Text>
        </Box>
        <Box flexGrow={1}>
            <Text color="gray" dimColor italic>
                {"  "}... {count} unchanged line{count === 1 ? "" : "s"} ...
            </Text>
        </Box>
    </Box>
)

/**
 * Represents either a diff line or a collapsed section marker
 */
type DisplayLine =
    | { type: "line"; line: DiffLine }
    | { type: "collapsed"; count: number; startLineNumber: number; endLineNumber: number }

/**
 * Collapse long runs of context lines, keeping only contextLines before/after changes
 */
function collapseContext(block: DiffBlock, contextLines: number): DisplayLine[] {
    const lines = block.lines
    const result: DisplayLine[] = []

    // Find indices of all change lines (add/remove)
    const changeIndices: number[] = []
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].type === "add" || lines[i].type === "remove") {
            changeIndices.push(i)
        }
    }

    // If no changes, show all (shouldn't happen but handle it)
    if (changeIndices.length === 0) {
        return lines.map((line) => ({ type: "line", line }))
    }

    // Build a set of indices to keep (within contextLines of any change)
    const keepIndices = new Set<number>()
    for (const changeIdx of changeIndices) {
        for (let i = Math.max(0, changeIdx - contextLines); i <= Math.min(lines.length - 1, changeIdx + contextLines); i++) {
            keepIndices.add(i)
        }
    }

    // Process lines, grouping consecutive hidden context lines
    let hiddenStart: number | null = null
    let hiddenCount = 0
    let hiddenStartLineNum = 0
    let hiddenEndLineNum = 0

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        if (keepIndices.has(i)) {
            // Emit any pending collapsed section
            if (hiddenCount > 0) {
                result.push({
                    type: "collapsed",
                    count: hiddenCount,
                    startLineNumber: hiddenStartLineNum,
                    endLineNumber: hiddenEndLineNum,
                })
                hiddenCount = 0
                hiddenStart = null
            }
            result.push({ type: "line", line })
        } else {
            // Context line that should be hidden
            if (hiddenStart === null) {
                hiddenStart = i
                hiddenStartLineNum = line.newLineNumber ?? line.oldLineNumber ?? 0
            }
            hiddenEndLineNum = line.newLineNumber ?? line.oldLineNumber ?? 0
            hiddenCount++
        }
    }

    // Emit any remaining collapsed section
    if (hiddenCount > 0) {
        result.push({
            type: "collapsed",
            count: hiddenCount,
            startLineNumber: hiddenStartLineNum,
            endLineNumber: hiddenEndLineNum,
        })
    }

    return result
}

/**
 * Diff component for Modular UI.
 */
export const Diff: React.FC<DiffProps> = ({ content, contextLines = DEFAULT_CONTEXT_LINES }) => {
    const diff = useMemo((): ComputedDiff | null => {
        if (!content) return null
        return computeDiff(content)
    }, [content])

    const gutterWidth = useMemo(() => {
        if (!diff) return 1
        return getGutterWidth(diff)
    }, [diff])

    // Collapse context lines for each block
    const collapsedBlocks = useMemo(() => {
        if (!diff) return []
        return diff.blocks.map((block) => collapseContext(block, contextLines))
    }, [diff, contextLines])

    if (!diff || diff.blocks.length === 0) {
        return null
    }

    return (
        <Box flexDirection="column" width="100%">
            {collapsedBlocks.map((displayLines, blockIdx) => (
                <React.Fragment key={blockIdx}>
                    {blockIdx > 0 && <BlockSeparator />}
                    {displayLines.map((item, lineIdx) =>
                        item.type === "collapsed" ? (
                            <CollapsedRow count={item.count} gutterWidth={gutterWidth} key={`${blockIdx}-${lineIdx}`} />
                        ) : (
                            <DiffLineRow gutterWidth={gutterWidth} key={`${blockIdx}-${lineIdx}`} line={item.line} />
                        ),
                    )}
                </React.Fragment>
            ))}
        </Box>
    )
}
