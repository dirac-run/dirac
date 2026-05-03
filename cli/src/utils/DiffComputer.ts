/**
 * DiffComputer - Computes line-level diffs between search and replace blocks
 * Uses the diff library for Myers diff algorithm
 */

import * as Diff from "diff"

export interface DiffLine {
	type: "add" | "remove" | "context" | "separator"
	content: string
	/** Line number in the old/search block (for remove and context) */
	oldLineNumber?: number
	/** Line number in the new/replace block (for add and context) */
	newLineNumber?: number
}

export interface DiffBlock {
	/** Lines in this diff block */
	lines: DiffLine[]
	/** Total additions in this block */
	additions: number
	/** Total deletions in this block */
	deletions: number
}

export interface ComputedDiff {
	/** All diff blocks (one per SEARCH/REPLACE pair) */
	blocks: DiffBlock[]
	/** Total additions across all blocks */
	totalAdditions: number
	/** Total deletions across all blocks */
	totalDeletions: number
}

// Format markers
const MARKERS = {
	SEARCH_BLOCK: "<<<<<<< SEARCH",
	SEARCH_SEPARATOR: "=======",
	REPLACE_BLOCK: ">>>>>>> REPLACE",
	NEW_BEGIN: "*** Begin Patch",
	NEW_END: "*** End Patch",
	FILE_PATTERN: /^\*\*\* (Add|Update|Delete) File: (.+)$/m,
} as const

/**
 * Parse SEARCH/REPLACE format and extract pairs of search/replace text
 */
function parseSearchReplacePairs(content: string): Array<{ search: string; replace: string; startLine?: number }> {
	const pairs: Array<{ search: string; replace: string; startLine?: number }> = []

	// Find all SEARCH blocks
	const searchRegex = /(?:-{7,}|<{7,}) SEARCH(?:[: ](\d+))?/g
	const searchPositions: Array<{ index: number; startLine?: number }> = []
	let match: RegExpExecArray | null
	while ((match = searchRegex.exec(content)) !== null) {
		searchPositions.push({ index: match.index, startLine: match[1] ? parseInt(match[1], 10) : undefined })
	}

	for (let i = 0; i < searchPositions.length; i++) {
		const { index: start, startLine } = searchPositions[i]
		const end = i < searchPositions.length - 1 ? searchPositions[i + 1].index : content.length
		const blockContent = content.substring(start, end)

		// Extract content after SEARCH marker
		const searchMarkerMatch = blockContent.match(searchRegex)
		const searchMarkerLength = searchMarkerMatch ? searchMarkerMatch[0].length : MARKERS.SEARCH_BLOCK.length
		const afterSearch = blockContent.substring(searchMarkerLength).replace(/^\r?\n/, "")
		const separatorIndex = afterSearch.indexOf(MARKERS.SEARCH_SEPARATOR)

		if (separatorIndex === -1) {
			// Still streaming - only SEARCH block available, treat as deletion
			const searchContent = afterSearch.trimEnd()
			pairs.push({ search: searchContent, replace: "", startLine })
		} else {
			// Extract SEARCH block
			const searchContent = afterSearch.substring(0, separatorIndex).replace(/\r?\n$/, "")

			// Extract REPLACE block
			const afterSeparator = afterSearch.substring(separatorIndex + MARKERS.SEARCH_SEPARATOR.length).replace(/^\r?\n/, "")
			let replaceEndIndex = afterSeparator.indexOf(MARKERS.REPLACE_BLOCK)
			if (replaceEndIndex === -1) {
				replaceEndIndex = afterSeparator.indexOf("+++++++ REPLACE")
			}
			const replaceContent =
				replaceEndIndex !== -1
					? afterSeparator.substring(0, replaceEndIndex).replace(/\r?\n$/, "")
					: afterSeparator.trimEnd()

			pairs.push({ search: searchContent, replace: replaceContent, startLine })
		}
	}

	return pairs
}

/**
 * Parse ApplyPatch format into search/replace pairs
 * This format uses +/- prefixes directly
 */
function parseApplyPatchPairs(content: string): Array<{ search: string; replace: string }> {
	const pairs: Array<{ search: string; replace: string }> = []

	const beginIndex = content.indexOf(MARKERS.NEW_BEGIN)
	if (beginIndex === -1) return pairs

	const endIndex = content.indexOf(MARKERS.NEW_END)
	const contentStart = beginIndex + MARKERS.NEW_BEGIN.length
	const contentEnd = endIndex !== -1 ? endIndex : content.length
	const patchContent = content.substring(contentStart, contentEnd).trim()

	const searchLines: string[] = []
	const replaceLines: string[] = []

	for (const line of patchContent.split("\n")) {
		// Skip file header lines
		if (line.match(/^\*\*\* (Add|Update|Delete) File:/)) continue
		if (line.trim() === "@@") continue

		if (line.startsWith("+")) {
			const hasSpace = line.startsWith("+ ")
			replaceLines.push(hasSpace ? line.slice(2) : line.slice(1))
		} else if (line.startsWith("-")) {
			const hasSpace = line.startsWith("- ")
			searchLines.push(hasSpace ? line.slice(2) : line.slice(1))
		} else if (line.trim()) {
			// Context line - appears in both
			searchLines.push(line)
			replaceLines.push(line)
		}
	}

	if (searchLines.length > 0 || replaceLines.length > 0) {
		pairs.push({
			search: searchLines.join("\n"),
			replace: replaceLines.join("\n"),
		})
	}

	return pairs
}

/**
 * Compute line-level diff between search and replace text
 * Uses Myers diff algorithm via the diff library
 */
function computeLineDiff(search: string, replace: string, startLine?: number): DiffBlock {
	const lines: DiffLine[] = []
	let additions = 0
	let deletions = 0

	// Handle empty cases
	if (!search && !replace) {
		return { lines: [], additions: 0, deletions: 0 }
	}

	// Use diffLines for line-level comparison
	// The newlineIsToken option treats newlines as separate tokens for cleaner diffs
	const changes = Diff.diffLines(search, replace, { newlineIsToken: false })

	let oldLineNum = startLine ?? 1
	let newLineNum = startLine ?? 1

	for (const change of changes) {
		// Split the value into individual lines, preserving empty lines
		const changeLines = change.value.replace(/\n$/, "").split("\n")

		for (const line of changeLines) {
			if (change.added) {
				lines.push({
					type: "add",
					content: line,
					newLineNumber: newLineNum,
				})
				newLineNum++
				additions++
			} else if (change.removed) {
				lines.push({
					type: "remove",
					content: line,
					oldLineNumber: oldLineNum,
				})
				oldLineNum++
				deletions++
			} else {
				// Context line (unchanged)
				lines.push({
					type: "context",
					content: line,
					oldLineNumber: oldLineNum,
					newLineNumber: newLineNum,
				})
				oldLineNum++
				newLineNum++
			}
		}
	}

	return { lines, additions, deletions }
}

/**
 * Compute diff from tool content (SEARCH/REPLACE or ApplyPatch format)
 */
/**
 * Parse new format patches (*** Add/Update/Delete File: path)
 */
function parseNewFormat(content: string): Array<{ search: string; replace: string }> {
	const pairs: Array<{ search: string; replace: string }> = []
	const lines = content.split("\n")

	let searchLines: string[] = []
	let replaceLines: string[] = []

	for (const line of lines) {
		if (line.match(MARKERS.FILE_PATTERN)) {
			if (searchLines.length > 0 || replaceLines.length > 0) {
				pairs.push({
					search: searchLines.join("\n"),
					replace: replaceLines.join("\n"),
				})
				searchLines = []
				replaceLines = []
			}
			continue
		}
		if (line.trim() === "@@") {
			if (searchLines.length > 0 || replaceLines.length > 0) {
				pairs.push({
					search: searchLines.join("\n"),
					replace: replaceLines.join("\n"),
				})
				searchLines = []
				replaceLines = []
			}
			continue
		}

		if (line.startsWith("+")) {
			const hasSpace = line.startsWith("+ ")
			replaceLines.push(hasSpace ? line.slice(2) : line.slice(1))
		} else if (line.startsWith("-")) {
			const hasSpace = line.startsWith("- ")
			searchLines.push(hasSpace ? line.slice(2) : line.slice(1))
		} else if (line.trim()) {
			searchLines.push(line.startsWith(" ") ? line.slice(1) : line)
			replaceLines.push(line.startsWith(" ") ? line.slice(1) : line)
		}
	}

	if (searchLines.length > 0 || replaceLines.length > 0) {
		pairs.push({
			search: searchLines.join("\n"),
			replace: replaceLines.join("\n"),
		})
	}

	return pairs
}

export function computeDiff(content: string): ComputedDiff {
	// Detect format and parse pairs
	let pairs: Array<{ search: string; replace: string; startLine?: number }>

	if (content.includes(MARKERS.SEARCH_BLOCK) || content.includes("------- SEARCH") || content.match(/<{7,} SEARCH:\d+/)) {
		pairs = parseSearchReplacePairs(content)
	} else if (content.includes(MARKERS.NEW_BEGIN)) {
		pairs = parseApplyPatchPairs(content)
	} else if (content.match(MARKERS.FILE_PATTERN)) {
		pairs = parseNewFormat(content)
	} else {
		// Fallback: treat as new file (all additions)
		const lines = content.split("\n")
		return {
			blocks: [
				{
					lines: lines.map((line, idx) => ({
						type: "add" as const,
						content: line,
						newLineNumber: idx + 1,
					})),
					additions: lines.length,
					deletions: 0,
				},
			],
			totalAdditions: lines.length,
			totalDeletions: 0,
		}
	}

	// Compute diff for each pair
	const blocks: DiffBlock[] = []
	let totalAdditions = 0
	let totalDeletions = 0

	for (const pair of pairs) {
		const block = computeLineDiff(pair.search, pair.replace, pair.startLine)
		blocks.push(block)
		totalAdditions += block.additions
		totalDeletions += block.deletions
	}

	return { blocks, totalAdditions, totalDeletions }
}

/**
 * Get the maximum line number width for gutter sizing
 */
export function getGutterWidth(diff: ComputedDiff): number {
	let maxLineNum = 0

	for (const block of diff.blocks) {
		for (const line of block.lines) {
			if (line.oldLineNumber !== undefined) {
				maxLineNum = Math.max(maxLineNum, line.oldLineNumber)
			}
			if (line.newLineNumber !== undefined) {
				maxLineNum = Math.max(maxLineNum, line.newLineNumber)
			}
		}
	}

	return Math.max(1, maxLineNum.toString().length)
}
