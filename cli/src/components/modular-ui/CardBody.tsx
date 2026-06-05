import { RenderType } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"
import { Diff } from "./Diff"
import { linkifyPaths } from "../../utils/terminal-link"
import { Markdown } from "./Markdown"

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
	const maxLines = isExpanded ? (maxHeight ? Math.floor(maxHeight / 1) : defaultMaxLines) : previewLines

	const shouldTruncate = lines.length > maxLines
	const displayBody = shouldTruncate ? lines.slice(0, maxLines).join("\n") : body.trim()

	let content: React.ReactNode
	switch (renderType) {
		case "markdown":
			content = <Markdown>{displayBody}</Markdown>
			break
		case "diff":
			content = <Diff content={displayBody} />
			break
		case "text":
		default:
			content = <Text>{linkifyPaths(displayBody)}</Text>
			break
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			{content}
			{shouldTruncate && (
				<Box marginTop={0}>
					<Text color="gray" dimColor italic>
						... {lines.length - maxLines} more lines {isExpanded ? "" : "(Press [v] to expand)"}
					</Text>
				</Box>
			)}
		</Box>
	)
}