import { Box, Text } from "ink"
import { lexer, type Token, type Tokens } from "marked"
import React from "react"

/**
 * Add "(Tab)" hint after "Act mode" mentions in plain text.
 * Case-insensitive, avoids double-adding if already present.
 */
function addActModeHint(text: string, keyPrefix: string): React.ReactNode[] {
	const actModeRegex = /\bact\s+mode\b(?!\s*\(tab\))/gi
	const parts = text.split(actModeRegex)
	const matches = text.match(actModeRegex)

	if (!matches || parts.length <= 1) {
		return [text]
	}

	const nodes: React.ReactNode[] = []
	parts.forEach((part, i) => {
		if (part) nodes.push(part)
		if (matches[i]) {
			nodes.push(
				<React.Fragment key={`${keyPrefix}-act-mode-${i}`}>
					{matches[i]}
					<Text color="gray"> (Tab)</Text>
				</React.Fragment>,
			)
		}
	})
	return nodes
}

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
			return (
				<Box key={key} marginY={depth === 1 ? 1 : 0}>
					<Text bold color={color}>
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
				<Box flexDirection="column" key={key} marginY={1}>
					{(token as Tokens.Code).text.split("\n").map((line, i) => (
						<Text color="cyan" key={i}>
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
					<Text color="gray">│ </Text>
					<Box flexDirection="column">{renderTokens((token as Tokens.Blockquote).tokens, color)}</Box>
				</Box>
			)

		case "space":
			return <Text key={key}> </Text>

		// --- Inline tokens ---

		case "strong":
			return (
				<Text bold color={color} key={key}>
					{renderTokens((token as Tokens.Strong).tokens, color)}
				</Text>
			)

		case "em":
			return (
				<Text color={color} italic key={key}>
					{renderTokens((token as Tokens.Em).tokens, color)}
				</Text>
			)

		case "codespan":
			return <Text key={key}>{(token as Tokens.Codespan).text}</Text>

		case "link": {
			const { text, href } = token as Tokens.Link
			return (
				<Text color={color} key={key}>
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
					{addActModeHint(text, `${key}`)}
				</Text>
			)
		}

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
 * Render a markdown string as Ink components.
 */
export const MarkdownText: React.FC<{ children: string; color?: string }> = ({ children, color }) => {
	const tokens = lexer(children)
	return <Box flexDirection="column">{renderTokens(tokens, color)}</Box>
}
