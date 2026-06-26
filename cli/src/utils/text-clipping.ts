const DEFAULT_COLUMNS = 80

export function estimateVisualLineCount(text: string, columns = DEFAULT_COLUMNS): number {
	const width = Math.max(1, columns)
	const lines = text.split("\n")
	return lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0)
}

export function clipTextToLastVisualLines(
	text: string,
	maxLines: number,
	columns = DEFAULT_COLUMNS,
	marker = "… earlier output clipped …",
): string {
	const lineBudget = Math.max(1, maxLines)
	const width = Math.max(1, columns)
	const lines = text.split("\n")
	const kept: string[] = []
	let usedLines = 0
	let clipped = false

	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]
		const visualLines = Math.max(1, Math.ceil(line.length / width))
		if (usedLines + visualLines <= lineBudget) {
			kept.unshift(line)
			usedLines += visualLines
			continue
		}

		const remainingLines = lineBudget - usedLines
		if (remainingLines > 0) {
			kept.unshift(line.slice(-remainingLines * width))
			usedLines = lineBudget
		}
		clipped = true
		break
	}

	const result = kept.join("\n")
	if (!clipped && lines.length === kept.length) {
		return result
	}

	return `${marker}\n${result}`
}

export function summarizeFirstLine(text: string, maxLength = 100): string {
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find(Boolean)

	if (!line) return ""

	const plain = line
		.replace(/^#{1,6}\s+/, "")
		.replace(/[*_`~]+/g, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^>\s+/, "")

	if (plain.length <= maxLength) return plain
	return `${plain.slice(0, maxLength - 1)}…`
}

/**
 * Clip text to a window of maxLines visual lines, offset from the bottom.
 *
 * scrollFromBottom = 0 → equivalent to clipTextToLastVisualLines (last N lines)
 * scrollFromBottom = K → window shifted K visual lines up from the bottom
 */
export function clipTextToWindow(
	text: string,
	maxLines: number,
	columns = DEFAULT_COLUMNS,
	scrollFromBottom = 0,
	marker = "… earlier output clipped …",
): { visibleText: string; hasMoreAbove: boolean; hasMoreBelow: boolean } {
	const lineBudget = Math.max(1, maxLines)
	const width = Math.max(1, columns)
	const lines = text.split("\n")

	// Compute cumulative visual line count for each logical line
	const cumulativeVisual: number[] = []
	let total = 0
	for (const line of lines) {
		total += Math.max(1, Math.ceil(line.length / width))
		cumulativeVisual.push(total)
	}
	const totalVisualLines = total

	if (totalVisualLines <= lineBudget) {
		return { visibleText: text, hasMoreAbove: false, hasMoreBelow: false }
	}

	const maxScroll = totalVisualLines - lineBudget
	const clampedScroll = Math.min(Math.max(0, scrollFromBottom), maxScroll)

	// Window in visual line coordinates (0-indexed from top)
	const windowEndVisual = totalVisualLines - clampedScroll
	const windowStartVisual = windowEndVisual - lineBudget

	// Map visual coordinates back to logical line indices
	let startLineIdx = 0
	for (let i = 0; i < cumulativeVisual.length; i++) {
		if (cumulativeVisual[i] > windowStartVisual) {
			startLineIdx = i
			break
		}
	}
	let endLineIdx = lines.length - 1
	for (let i = startLineIdx; i < cumulativeVisual.length; i++) {
		endLineIdx = i
		if (cumulativeVisual[i] >= windowEndVisual) break
	}

	const visibleLines = lines.slice(startLineIdx, endLineIdx + 1)
	const visibleText = visibleLines.join("\n")

	const hasMoreAbove = clampedScroll < maxScroll
	const hasMoreBelow = clampedScroll > 0

	let result = visibleText
	if (startLineIdx > 0) {
		result = `${marker}\n${result}`
	}

	return { visibleText: result, hasMoreAbove, hasMoreBelow }
}
