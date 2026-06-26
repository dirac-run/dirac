import { ToolUse } from "@core/assistant-message"
import { splitAnchor, stripHashes, getDelimiter } from "@utils/line-hashing"
import { AppliedEdit, Edit, FailedEdit, ResolvedEdit } from "../types"

export class EditExecutor {
	resolveEdits(
		blocks: ToolUse[],
		lines: string[],
		lineHashes: string[],
	): { resolvedEdits: ResolvedEdit[]; failedEdits: FailedEdit[] } {
		const failedEdits: FailedEdit[] = []
		const resolvedEdits: ResolvedEdit[] = []
		const normalizedLineHashes = lineHashes.map((h) => h.trim())

		for (const block of blocks) {
			const edits = (block.params.edits as Edit[]) || []
			for (const edit of edits) {
				const diagnostics: string[] = []
				const editType = edit.edit_type

				const { index: lineIdx, error: startError } = this.resolveAnchor(
					"anchor",
					edit.anchor,
					normalizedLineHashes,
					lines,
				)
				if (startError) diagnostics.push(startError)

				let endIdx = lineIdx
				if (editType === "replace") {
					const { index: resolvedEndIdx, error: endError } = this.resolveAnchor(
						"end_anchor",
						edit.end_anchor,
						normalizedLineHashes,
						lines,
					)
					if (endError) diagnostics.push(endError)
					endIdx = resolvedEndIdx
				}

				if (lineIdx !== -1 && endIdx !== -1 && endIdx < lineIdx) {
					diagnostics.push("Range error: anchor must refer to a line that precedes or is the same as end_anchor.")
				}

				if (diagnostics.length > 0) {
					failedEdits.push({ edit, error: diagnostics.join(" ") })
				} else {
					resolvedEdits.push({ lineIdx, endIdx, edit })
				}
			}
		}
		return { resolvedEdits, failedEdits }
	}

	resolveAnchor(
		type: "anchor" | "end_anchor",
		rawAnchor: string | undefined,
		normalizedLineHashes: string[],
		lines: string[],
	): { index: number; error?: string } {
		const anchorRaw = rawAnchor || ""
		if (!anchorRaw.trim()) return { index: -1, error: `${type} is missing.` }

		const { anchor: anchorName, content: providedContent } = splitAnchor(anchorRaw)

		// 1. Check if the anchor name is valid (starts with a capital letter, letters only)
		const anchorExtractRegex = /^[A-Z][a-zA-Z]*$/
		if (!anchorExtractRegex.test(anchorName)) {
			return {
				index: -1,
				error: `${type} is missing or incorrectly formatted. It must start with a single word followed by the delimiter (e.g., "Apple${getDelimiter()}").`,
			}
		}

		// 2. Check if the anchor exists in the file
		const index = normalizedLineHashes.indexOf(anchorName)
		if (index === -1) {
			return {
				index: -1,
				error: `${type} "${anchorName}" not found in the file. Please ensure you are using the latest anchors from the most recent read tool output.`,
			}
		}

		// 3. Check for newlines in the provided code line
		if (providedContent.includes("\n") || providedContent.includes("\r")) {
			return {
				index: -1,
				error: `${type} "${anchorName}" exists, but the provided code line contains a newline character. Anchors must refer to a single line only in the format Anchor${getDelimiter()}{line_text}.`,
			}
		}

		// 4. Check if the code line matches the file's content
		const actualContent = lines[index]
		if (providedContent !== actualContent) {
			return {
				index: -1,
				error: `${type} "${anchorName}" exists, but the code line you provided does not match the file's content. Expected: "${actualContent}", Provided: "${providedContent}".`,
			}
		}

		return { index }
	}

	applyEdits(
		lines: string[],
		resolvedEdits: ResolvedEdit[],
	): { finalLines: string[]; addedCount: number; removedCount: number; appliedEdits: AppliedEdit[] } {
		const sortedEdits = [...resolvedEdits].sort((a, b) => b.lineIdx - a.lineIdx)
		const newLines = [...lines]
		let addedCount = 0
		let removedCount = 0
		const changes: Array<{
			originalLineIdx: number
			replacementCount: number
			removedCount: number
			edit: Edit
		}> = []

		for (const { lineIdx, endIdx, edit } of sortedEdits) {
			const editType = edit.edit_type
			const cleanText = stripHashes(edit.text || "")
			const replacementLines = cleanText === "" ? [] : cleanText.split(/\r?\n/)

			let removedInThisEdit: number
			let spliceIndex: number

			if (editType === "insert_after") {
				spliceIndex = lineIdx + 1
				removedInThisEdit = 0
			} else if (editType === "insert_before") {
				spliceIndex = lineIdx
				removedInThisEdit = 0
			} else {
				// replace
				spliceIndex = lineIdx
				removedInThisEdit = endIdx - lineIdx + 1
			}

			newLines.splice(spliceIndex, removedInThisEdit, ...replacementLines)
			addedCount += replacementLines.length
			removedCount += removedInThisEdit
			changes.push({
				originalLineIdx: lineIdx,
				replacementCount: replacementLines.length,
				removedCount: removedInThisEdit,
				edit,
			})
		}

		const appliedEdits: AppliedEdit[] = changes.map((change) => {
			let shift = 0
			for (const other of changes) {
				if (other.originalLineIdx < change.originalLineIdx) {
					shift += other.replacementCount - other.removedCount
				}
			}
			return {
				startIdx: change.originalLineIdx + shift,
				endIdx: change.originalLineIdx + shift + change.replacementCount - 1,
				originalStartIdx: change.originalLineIdx,
				originalEndIdx: change.originalLineIdx + change.removedCount - 1,
				edit: change.edit,
				linesAdded: change.replacementCount,
				linesDeleted: change.removedCount,
			}
		})

		return { finalLines: newLines, addedCount, removedCount, appliedEdits }
	}

	formatFailureMessage(edit: Edit, error?: string): string {
		const diagnostic = error
			? ` Diagnostics: ${error}`
			: " This almost certainly is because the anchors used were incorrect or not in ascending order or the text supplied was incorrect. please check again edit again"
		return `Edit (anchor: "${edit.anchor}", end_anchor: "${edit.end_anchor}") failed.${diagnostic}`
	}
}
