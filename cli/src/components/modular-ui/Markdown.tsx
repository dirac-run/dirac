import { Box, Text } from "ink"
import { lexer, type Token, type Tokens } from "marked"
import React from "react"
import { linkifyPaths } from "../../utils/terminal-link"
import { styles } from "../../constants/theme"

/**
 * Render an array of marked tokens as Ink React nodes.
 */
function renderTokens(tokens: Token[], color?: string): React.ReactNode[] {
    return tokens.map((token, i) => renderToken(token, i, color))
}

/**
 * Render a single marked token (block or inline) as an Ink React node.
 */
function renderToken(token: Token, key: number, color?: string): React.ReactNode {
    switch (token.type) {
        // --- Block tokens ---

        case "heading": {
            const { depth, tokens } = token as Tokens.Heading
            const headingStyle = depth <= 2 ? styles.markdown.heading : styles.markdown.headingSub
            return (
                <Box key={key} marginTop={depth <= 2 ? 1 : 0} marginBottom={depth === 1 ? 1 : 0}>
                    <Text {...headingStyle} {...(depth > 2 && color ? { color } : {})}>
                        {renderTokens(tokens, color)}
                    </Text>
                </Box>
            )
        }

        case "paragraph":
            return (
                <Text color={color} key={key}>
                    {renderTokens((token as Tokens.Paragraph).tokens, color)}
                </Text>
            )

        case "code":
            return (
                <Box
                    borderColor="brightBlack"
                    borderStyle="single"
                    flexDirection="column"
                    key={key}
                    marginY={0}
                    paddingX={1}
                >
                    {(token as Tokens.Code).text.split("\n").map((line, i) => (
                        <Text {...styles.markdown.codeBlock} key={i}>
                            {line || " "}
                        </Text>
                    ))}
                </Box>
            )

        case "list": {
            const { ordered, start, items } = token as Tokens.List
            return (
                <Box flexDirection="column" key={key}>
                    {items.map((item, i) => (
                        <Box flexDirection="row" key={i}>
                            <Text color="gray">{ordered ? `${Number(start ?? 1) + i}. ` : "• "}</Text>
                            <Box flexDirection="column" flexGrow={1}>
                                {renderTokens(item.tokens, color)}
                            </Box>
                        </Box>
                    ))}
                </Box>
            )
        }

        case "blockquote":
            return (
                <Box flexDirection="row" key={key}>
                    <Text {...styles.markdown.blockquoteBar}>│ </Text>
                    <Box flexDirection="column">{renderTokens((token as Tokens.Blockquote).tokens, color)}</Box>
                </Box>
            )

        case "space":
            return <Text key={key}> </Text>

        // --- Inline tokens ---

        case "strong":
            return (
                <Text {...styles.markdown.strong} {...(color ? { color } : {})} key={key}>
                    {renderTokens((token as Tokens.Strong).tokens, color)}
                </Text>
            )

        case "em":
            return (
                <Text {...styles.markdown.emphasis} {...(color ? { color } : {})} key={key}>
                    {renderTokens((token as Tokens.Em).tokens, color)}
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
                        {renderTokens(tokens, color)}
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
                <Text {...styles.markdown.hr} key={key}>
                    {"─".repeat(process.stdout.columns || 80)}
                </Text>
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
            const colWidths = headerTexts.map((h, ci) => {
                const maxRowWidth = rowTexts.reduce(
                    (max, row) => Math.max(max, (row[ci] || "").length),
                    0,
                )
                return Math.max(h.length, maxRowWidth)
            })
            const topBorder = colWidths.map((w) => "─".repeat(w + 2)).join("┬")
            const headerSep = colWidths.map((w) => "─".repeat(w + 2)).join("┼")
            const bottomBorder = colWidths.map((w) => "─".repeat(w + 2)).join("┴")
            const renderRow = (cells: string[]): string =>
                "│" + cells.map((c, ci) => ` ${c.padEnd(colWidths[ci])} `).join("│") + "│"
            return (
                <Box flexDirection="column" key={key}>
                    <Text {...styles.markdown.tableBorder}>{`┌${topBorder}┐`}</Text>
                    <Text {...styles.markdown.tableHeader}>{renderRow(headerTexts)}</Text>
                    <Text {...styles.markdown.tableBorder}>{`├${headerSep}┤`}</Text>
                    {rowTexts.map((row, ri) => (
                        <Text key={ri}>{renderRow(row)}</Text>
                    ))}
                    <Text {...styles.markdown.tableBorder}>{`└${bottomBorder}┘`}</Text>
                </Box>
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
 */
export const Markdown: React.FC<{ children: string; color?: string }> = ({ children, color }) => {
    const tokens = lexer(children)
    return <Box flexDirection="column">{renderTokens(tokens, color)}</Box>
}
