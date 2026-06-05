import { Box, Text } from "ink"
import { lexer, type Token, type Tokens } from "marked"
import React from "react"
import { linkifyPaths } from "../../utils/terminal-link"

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
				<Box key={key} marginTop={depth <= 2 ? 1 : 0} marginBottom={depth === 1 ? 1 : 0}>
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
				<Box
					borderColor="gray"
					borderStyle="single"
					flexDirection="column"
					key={key}
						marginY={0}
					paddingX={1}
				>
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
			return <Text key={key}>{linkifyPaths((token as Tokens.Codespan).text)}</Text>

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
					{linkifyPaths(text)}
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
 * Render a markdown string as Ink components for Modular UI.
 */
export const Markdown: React.FC<{ children: string; color?: string }> = ({ children, color }) => {
	const tokens = lexer(children)
	return <Box flexDirection="column">{renderTokens(tokens, color)}</Box>
}
