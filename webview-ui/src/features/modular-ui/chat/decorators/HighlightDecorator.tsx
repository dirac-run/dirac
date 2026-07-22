import { mentionRegexGlobal } from "@shared/context-mentions"
import { slashCommandRegexGlobal } from "@/shared/lib/slash-commands"
import type { ReactNode } from "react"
import type { InputDecorator } from "../types"

type HighlightRange = {
	start: number
	end: number
}

function collectHighlightRanges(value: string): HighlightRange[] {
	const ranges: HighlightRange[] = []
	const mentionRegex = new RegExp(mentionRegexGlobal.source, "g")

	for (const match of value.matchAll(mentionRegex)) {
		if (match.index === undefined) continue
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}

	const slashRegex = new RegExp(slashCommandRegexGlobal.source, "g")
	const slashMatch = slashRegex.exec(value)
	if (slashMatch?.index !== undefined) {
		const prefixLength = slashMatch[1]?.length ?? 0
		const command = slashMatch[2] ?? ""
		ranges.push({
			start: slashMatch.index + prefixLength,
			end: slashMatch.index + prefixLength + command.length,
		})
	}

	return ranges.sort((left, right) => left.start - right.start)
}

function renderHighlightedText(value: string) {
	const displayValue = value.endsWith("\n") ? `${value}\n` : value
	const ranges = collectHighlightRanges(value)
	const nodes: ReactNode[] = []
	let cursor = 0

	for (const range of ranges) {
		if (range.start < cursor) continue
		if (range.start > cursor) nodes.push(displayValue.slice(cursor, range.start))
		nodes.push(
			<mark className="mention-context-textarea-highlight" key={`${range.start}-${range.end}`}>
				{displayValue.slice(range.start, range.end)}
			</mark>,
		)
		cursor = range.end
	}

	if (cursor < displayValue.length) nodes.push(displayValue.slice(cursor))
	return nodes
}

export const HighlightDecorator: InputDecorator = {
	id: "highlight",
	renderHighlight: (value: string) => <div>{renderHighlightedText(value)}</div>,
}
