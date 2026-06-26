import { Box, Text } from "ink"
import React, { useMemo } from "react"
import { type ComputedDiff, computeDiff, type DiffBlock, type DiffLine, getGutterWidth } from "../../utils/DiffComputer"
import { theme } from "../../constants/theme"
import { useTerminalSize } from "../../hooks/useTerminalSize"
import { linkifyPaths } from "../../utils/terminal-link"

interface DiffProps {
	/** Diff content (SEARCH/REPLACE format, ApplyPatch format, or raw content for new files) */
	content?: string
	/** File path (used for potential syntax highlighting in the future) */
	filePath?: string
	/** Number of context lines to show before/after changes (default: 3) */
	contextLines?: number
	/** Available render width from the parent body. */
	width?: number
	/** Diff layout. Auto uses split when there is enough width, unified otherwise. */
	variant?: "auto" | "unified" | "split"
}

const DIFF_COLORS = theme.diff
const DEFAULT_CONTEXT_LINES = 2
const MIN_SPLIT_WIDTH = 80
const SPLIT_SEPARATOR = " │ "

type DisplayLine =
	| { type: "line"; line: DiffLine }
	| { type: "collapsed"; count: number; startLineNumber: number; endLineNumber: number }

type SplitDisplayRow = { type: "row"; oldLine?: DiffLine; newLine?: DiffLine } | { type: "collapsed"; count: number }

function lineNumberForSide(line: DiffLine | undefined, side: "old" | "new"): number | undefined {
	if (!line) return undefined
	return side === "old" ? line.oldLineNumber : line.newLineNumber
}

function lineTypeForSide(line: DiffLine | undefined, side: "old" | "new"): "add" | "remove" | "context" | undefined {
	if (!line) return undefined
	if (line.type === "context") return "context"
	if (side === "old" && line.type === "remove") return "remove"
	if (side === "new" && line.type === "add") return "add"
	return undefined
}

function prefixForType(type: "add" | "remove" | "context" | undefined): string {
	if (type === "add") return "+"
	if (type === "remove") return "-"
	return " "
}

function colorsForType(type: "add" | "remove" | "context" | undefined): {
	bgColor?: string
	fgColor?: string
	dimColor?: boolean
} {
	if (type === "add") return { bgColor: DIFF_COLORS.addBg, fgColor: DIFF_COLORS.addFg }
	if (type === "remove") return { bgColor: DIFF_COLORS.removeBg, fgColor: DIFF_COLORS.removeFg }
	return { dimColor: type === "context" }
}

function truncateLine(text: string, width: number): string {
	if (width <= 0) return ""
	if (text.length <= width) return text
	if (width === 1) return "…"
	return `${text.slice(0, width - 1)}…`
}

/** Render a single unified diff line with gutter and colored content. */
const UnifiedDiffLineRow: React.FC<{
	line: DiffLine
	gutterWidth: number
}> = ({ line, gutterWidth }) => {
	if (line.type === "separator") {
		return <Text> </Text>
	}

	const lineNum = line.type === "add" ? line.newLineNumber : line.type === "remove" ? line.oldLineNumber : line.newLineNumber
	const lineNumStr = lineNum !== undefined ? lineNum.toString().padStart(gutterWidth, " ") : " ".repeat(gutterWidth)
	const type = line.type
	const prefix = prefixForType(type)
	const { bgColor, fgColor, dimColor } = colorsForType(type)

	return (
		<Box flexDirection="row" width="100%">
			<Box flexShrink={0} width={gutterWidth + 2}>
				<Text color={DIFF_COLORS.gutterFg} dimColor>
					{lineNumStr}
					{"  "}
				</Text>
			</Box>
			<Box backgroundColor={bgColor} flexGrow={1} paddingX={1}>
				<Text color={fgColor} dimColor={dimColor}>
					{prefix} {linkifyPaths(line.content || " ")}
				</Text>
			</Box>
		</Box>
	)
}

const BlockSeparator: React.FC<{ width?: number }> = ({ width }) => {
	const { columns: terminalWidth } = useTerminalSize()
	const availableWidth = width ?? terminalWidth
	const ruleWidth = Math.min(40, Math.max(10, availableWidth - 4))
	return (
		<Box marginY={0}>
			<Text color="gray">{"─".repeat(ruleWidth)}</Text>
		</Box>
	)
}

const UnifiedCollapsedRow: React.FC<{ count: number; gutterWidth: number }> = ({ count, gutterWidth }) => (
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

const SplitCollapsedRow: React.FC<{ count: number; width: number }> = ({ count, width }) => (
	<Text color="gray" dimColor italic>
		{truncateLine(`... ${count} unchanged line${count === 1 ? "" : "s"} ...`, width)}
	</Text>
)

const SplitCell: React.FC<{
	line?: DiffLine
	side: "old" | "new"
	gutterWidth: number
	width: number
}> = ({ line, side, gutterWidth, width }) => {
	const type = lineTypeForSide(line, side)
	const lineNum = lineNumberForSide(line, side)
	const lineNumStr = lineNum !== undefined ? lineNum.toString().padStart(gutterWidth, " ") : " ".repeat(gutterWidth)
	const prefix = prefixForType(type)
	const { bgColor, fgColor, dimColor } = colorsForType(type)
	const contentWidth = Math.max(1, width - gutterWidth - 3)
	const content = line ? truncateLine(line.content || " ", contentWidth) : ""

	return (
		<Box backgroundColor={bgColor} flexDirection="row" flexShrink={0} width={width}>
			<Box flexShrink={0} width={gutterWidth + 1}>
				<Text color={DIFF_COLORS.gutterFg} dimColor>
					{lineNumStr}
				</Text>
			</Box>
			<Box flexShrink={0} width={Math.max(1, width - gutterWidth - 1)}>
				<Text color={fgColor} dimColor={dimColor}>
					{prefix} {linkifyPaths(content)}
				</Text>
			</Box>
		</Box>
	)
}

const SplitDiffRow: React.FC<{
	row: SplitDisplayRow
	gutterWidth: number
	width: number
}> = ({ row, gutterWidth, width }) => {
	if (row.type === "collapsed") {
		return <SplitCollapsedRow count={row.count} width={width} />
	}

	const sideWidth = Math.max(10, Math.floor((width - SPLIT_SEPARATOR.length) / 2))
	return (
		<Box flexDirection="row" width="100%">
			<SplitCell gutterWidth={gutterWidth} line={row.oldLine} side="old" width={sideWidth} />
			<Text color="gray" dimColor>
				{SPLIT_SEPARATOR}
			</Text>
			<SplitCell gutterWidth={gutterWidth} line={row.newLine} side="new" width={sideWidth} />
		</Box>
	)
}

function collapseContext(block: DiffBlock, contextLines: number): DisplayLine[] {
	const lines = block.lines
	const result: DisplayLine[] = []
	const changeIndices: number[] = []

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].type === "add" || lines[i].type === "remove") {
			changeIndices.push(i)
		}
	}

	if (changeIndices.length === 0) {
		return lines.map((line) => ({ type: "line", line }))
	}

	const keepIndices = new Set<number>()
	for (const changeIdx of changeIndices) {
		for (let i = Math.max(0, changeIdx - contextLines); i <= Math.min(lines.length - 1, changeIdx + contextLines); i++) {
			keepIndices.add(i)
		}
	}

	let hiddenStart: number | null = null
	let hiddenCount = 0
	let hiddenStartLineNum = 0
	let hiddenEndLineNum = 0

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		if (keepIndices.has(i)) {
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
			if (hiddenStart === null) {
				hiddenStart = i
				hiddenStartLineNum = line.newLineNumber ?? line.oldLineNumber ?? 0
			}
			hiddenEndLineNum = line.newLineNumber ?? line.oldLineNumber ?? 0
			hiddenCount++
		}
	}

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

function toSplitRows(displayLines: DisplayLine[]): SplitDisplayRow[] {
	const rows: SplitDisplayRow[] = []
	let index = 0

	while (index < displayLines.length) {
		const item = displayLines[index]

		if (item.type === "collapsed") {
			rows.push({ type: "collapsed", count: item.count })
			index++
			continue
		}

		if (item.line.type === "context") {
			rows.push({ type: "row", oldLine: item.line, newLine: item.line })
			index++
			continue
		}

		const removes: DiffLine[] = []
		const adds: DiffLine[] = []
		while (index < displayLines.length) {
			const changeItem = displayLines[index]
			if (changeItem.type !== "line" || (changeItem.line.type !== "remove" && changeItem.line.type !== "add")) break
			if (changeItem.line.type === "remove") removes.push(changeItem.line)
			if (changeItem.line.type === "add") adds.push(changeItem.line)
			index++
		}

		const rowCount = Math.max(removes.length, adds.length)
		for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
			rows.push({ type: "row", oldLine: removes[rowIndex], newLine: adds[rowIndex] })
		}
	}

	return rows
}

function shouldRenderSplit(variant: NonNullable<DiffProps["variant"]>, width: number): boolean {
	if (variant === "split") return true
	if (variant === "unified") return false
	return width >= MIN_SPLIT_WIDTH
}

/** Diff component for Modular UI. */
export const Diff: React.FC<DiffProps> = ({ content, contextLines = DEFAULT_CONTEXT_LINES, width, variant = "auto" }) => {
	const { columns: terminalWidth } = useTerminalSize()
	const renderWidth = Math.max(1, width ?? terminalWidth)

	const diff = useMemo((): ComputedDiff | null => {
		if (!content) return null
		return computeDiff(content)
	}, [content])

	const gutterWidth = useMemo(() => {
		if (!diff) return 1
		return getGutterWidth(diff)
	}, [diff])

	const collapsedBlocks = useMemo(() => {
		if (!diff) return []
		return diff.blocks.map((block) => collapseContext(block, contextLines))
	}, [diff, contextLines])

	const splitBlocks = useMemo(() => collapsedBlocks.map(toSplitRows), [collapsedBlocks])

	if (!diff || diff.blocks.length === 0) {
		return null
	}

	const renderSplit = shouldRenderSplit(variant, renderWidth)

	return (
		<Box flexDirection="column" width="100%">
			{collapsedBlocks.map((displayLines, blockIdx) => (
				<React.Fragment key={blockIdx}>
					{blockIdx > 0 && <BlockSeparator width={renderWidth} />}
					{renderSplit
						? splitBlocks[blockIdx].map((row, lineIdx) => (
								<SplitDiffRow
									gutterWidth={gutterWidth}
									key={`${blockIdx}-${lineIdx}`}
									row={row}
									width={renderWidth}
								/>
							))
						: displayLines.map((item, lineIdx) =>
								item.type === "collapsed" ? (
									<UnifiedCollapsedRow
										count={item.count}
										gutterWidth={gutterWidth}
										key={`${blockIdx}-${lineIdx}`}
									/>
								) : (
									<UnifiedDiffLineRow
										gutterWidth={gutterWidth}
										key={`${blockIdx}-${lineIdx}`}
										line={item.line}
									/>
								),
							)}
				</React.Fragment>
			))}
		</Box>
	)
}
