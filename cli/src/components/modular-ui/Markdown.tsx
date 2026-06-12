import { Text } from "ink"
import { lexer, type Token, type Tokens } from "marked"
import React, { useMemo } from "react"
import { linkifyPaths } from "../../utils/terminal-link"
import { styles } from "../../constants/theme"

/**
 * Render an array of marked tokens as Ink React nodes.
 */
function renderTokens(tokens: Token[], color?: string, width?: number): React.ReactNode[] {
    return tokens.map((token, i) => renderToken(token, i, color, width))
}

/**
 * Render a single marked token (block or inline) as an Ink React node.
 * All block tokens use plain <Text> with explicit \n instead of <Box>
 * to avoid layout overflow issues in Ink's dynamic region.
 */
function renderToken(token: Token, key: number, color?: string, width?: number): React.ReactNode {
    switch (token.type) {
        // --- Block tokens ---

        case "heading": {
            const { depth, tokens } = token as Tokens.Heading
            const headingStyle = depth <= 2 ? styles.markdown.heading : styles.markdown.headingSub
            return (
                <React.Fragment key={key}>
                    {depth <= 2 && <Text>{"\n"}</Text>}
                    <Text {...headingStyle} {...(depth > 2 && color ? { color } : {})}>
                        {renderTokens(tokens, color, width)}
                    </Text>
                    <Text>{"\n"}</Text>
                    {depth === 1 && <Text>{"\n"}</Text>}
                </React.Fragment>
            )
        }

        case "paragraph":
            return (
                <React.Fragment key={key}>
                    <Text color={color}>{renderTokens((token as Tokens.Paragraph).tokens, color, width)}</Text>
                    <Text>{"\n"}</Text>
                </React.Fragment>
            )

        case "code": {
            const maxCodeWidth = (width ?? process.stdout.columns ?? 80) - 4
            const rawLines = (token as Tokens.Code).text.split("\n")
            const wrappedLines = rawLines.flatMap((line) => {
                if (line.length <= maxCodeWidth || maxCodeWidth <= 0) return [line]
                const chunks: string[] = []
                for (let i = 0; i < line.length; i += maxCodeWidth) {
                    chunks.push(line.slice(i, i + maxCodeWidth))
                }
                return chunks
            })
            const padWidth = Math.max(...wrappedLines.map((l) => l.length), 1)
            return (
                <React.Fragment key={key}>
                    <Text>{"\n"}</Text>
                    <Text color="brightBlack">{"┌" + "─".repeat(padWidth + 2) + "┐\n"}</Text>
                    {wrappedLines.map((line, i) => (
                        <Text key={i}>
                            <Text color="brightBlack">{"│ "}</Text>
                            <Text {...styles.markdown.codeBlock}>{(line || " ").padEnd(padWidth)}</Text>
                            <Text color="brightBlack">{" │\n"}</Text>
                        </Text>
                    ))}
                    <Text color="brightBlack">{"└" + "─".repeat(padWidth + 2) + "┘\n"}</Text>
                </React.Fragment>
            )
        }

        case "list": {
            const { ordered, start, items } = token as Tokens.List
            return (
                <React.Fragment key={key}>
                    {items.map((item, i) => (
                        <Text key={i}>
                            <Text color="gray">{ordered ? `${Number(start ?? 1) + i}. ` : "• "}</Text>
                            {renderTokens(item.tokens, color, width)}
                        </Text>
                    ))}
                </React.Fragment>
            )
        }

        case "blockquote":
            return (
                <React.Fragment key={key}>
                    <Text {...styles.markdown.blockquoteBar}>{"│ "}</Text>
                    {renderTokens((token as Tokens.Blockquote).tokens, color, width)}
                </React.Fragment>
            )

        case "space":
            return <Text key={key}>{"\n"}</Text>

        // --- Inline tokens ---

        case "strong":
            return (
                <Text {...styles.markdown.strong} {...(color ? { color } : {})} key={key}>
                    {renderTokens((token as Tokens.Strong).tokens, color, width)}
                </Text>
            )

        case "em":
            return (
                <Text {...styles.markdown.emphasis} {...(color ? { color } : {})} key={key}>
                    {renderTokens((token as Tokens.Em).tokens, color, width)}
                </Text>
            )

        case "codespan":
            return (
                <Text {...styles.markdown.inlineCode} key={key}>
                    {linkifyPaths((token as Tokens.Codespan).text)}
                </Text>
            )

        case "link": {
            const { text, href } = token as Tokens.Link
            return (
                <Text {...styles.markdown.link} key={key}>
                    {text && text !== href ? `${text} (${href})` : href}
                </Text>
            )
        }

        case "text": {
            const { text, tokens } = token as Tokens.Text
            if (tokens?.length) {
                return (
                    <Text color={color} key={key}>
                        {renderTokens(tokens, color, width)}
                    </Text>
                )
            }
            return (
                <Text color={color} key={key}>
                    {linkifyPaths(text)}
                </Text>
            )
        }

        case "hr":
            return (
                <React.Fragment key={key}>
                    <Text {...styles.markdown.hr}>
                        {"─".repeat(width ?? process.stdout.columns ?? 80)}
                    </Text>
                    <Text>{"\n"}</Text>
                </React.Fragment>
            )

        case "table": {
            const { header, rows } = token as Tokens.Table
            const getCellText = (cell: unknown): string => {
                if (cell && typeof cell === "object" && "text" in cell) return String((cell as { text: string }).text)
                if (cell && typeof cell === "object" && "raw" in cell) return String((cell as { raw: string }).raw)
                return ""
            }
            const headerTexts = header.map(getCellText)
            const rowTexts = rows.map((row) => row.map(getCellText))
            let colWidths = headerTexts.map((h, ci) => {
                const maxRowWidth = rowTexts.reduce(
                    (max, row) => Math.max(max, (row[ci] || "").length),
                    0,
                )
                return Math.max(h.length, maxRowWidth)
            })
            // Cap table width to fit within terminal to prevent overflow on Static commit
            const tableIndent = 6 // msg paddingX(1) + card paddingLeft(5)
            const maxTableWidth = (width ?? process.stdout.columns ?? 80) - tableIndent
            const borderOverhead = colWidths.length * 3 + 1 // "│" + 2 padding per col + outer borders
            const availableForContent = maxTableWidth - borderOverhead
            if (availableForContent > 0) {
                const totalNatural = colWidths.reduce((s, w) => s + w, 0)
                if (totalNatural > availableForContent) {
                    const scale = availableForContent / totalNatural
                    colWidths = colWidths.map((w) => Math.max(8, Math.floor(w * scale)))
                }
            }
            const topBorder = colWidths.map((w) => "─".repeat(w + 2)).join("┬")
            const headerSep = colWidths.map((w) => "─".repeat(w + 2)).join("┼")
            const bottomBorder = colWidths.map((w) => "─".repeat(w + 2)).join("┴")
            const renderRow = (cells: string[]): string =>
                "│" + cells.map((c, ci) => ` ${c.padEnd(colWidths[ci])} `).join("│") + "│"
            return (
                <React.Fragment key={key}>
                    <Text {...styles.markdown.tableBorder}>{`┌${topBorder}┐\n`}</Text>
                    <Text {...styles.markdown.tableHeader}>{`${renderRow(headerTexts)}\n`}</Text>
                    <Text {...styles.markdown.tableBorder}>{`├${headerSep}┤\n`}</Text>
                    {rowTexts.map((row, ri) => (
                        <Text key={ri}>{`${renderRow(row)}\n`}</Text>
                    ))}
                    <Text {...styles.markdown.tableBorder}>{`└${bottomBorder}┘\n`}</Text>
                </React.Fragment>
            )
        }

        case "escape":
            return (
                <Text color={color} key={key}>
                    {(token as Tokens.Escape).text}
                </Text>
            )

        case "image": {
            const { text: altText, href } = token as Tokens.Image
            return (
                <Text color={color} key={key}>
                    {altText ? `[${altText}] (${href})` : href}
                </Text>
            )
        }

        case "br":
            return <Text key={key}>{"\n"}</Text>

        // Fallback for any unhandled token type
        default:
            return "raw" in token ? (
                <Text color={color} key={key}>
                    {(token as { raw: string }).raw}
                </Text>
            ) : null
    }
}

/**
 * Render a markdown string as Ink components for Modular UI.
 * Uses pure <Text> (no <Box>) to avoid layout overflow issues in Ink's
 * dynamic rendering region — Box nodes that exceed terminal height cause
 * infinite scroll because Ink's log-update cannot erase-and-replace them.
 */
export const Markdown: React.FC<{ children: string; color?: string; width?: number }> = ({ children, color, width }) => {
    const tokens = useMemo(() => lexer(children), [children])
    return <Text>{renderTokens(tokens, color, width)}</Text>
}
