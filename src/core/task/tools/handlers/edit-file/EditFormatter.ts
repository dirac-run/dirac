import { formatResponse } from "@core/prompts/responses"
import { formatLineWithHash, getDelimiter } from "@utils/line-hashing"
import { ToolResponse } from "../../../index"
import { EditExecutor } from "./EditExecutor"
import { AppliedEdit, PreparedEdits } from "./types"

export class EditFormatter {
	constructor(private executor: EditExecutor) { }

	getAdditionOnlyDiffBlock(
		originalLines: string[],
		originalHashes: string[],
		finalLines: string[],
		finalHashes: string[],
		applied: AppliedEdit,
	): string {
		const { originalStartIdx, originalEndIdx, startIdx, endIdx, edit } = applied
		const res: string[] = []
		const contextCount = 3

		// 1. Context Before (from original state)
		const beforeStart = Math.max(0, originalStartIdx - contextCount)
		for (let i = beforeStart; i < originalStartIdx; i++) {
			res.push(` ${formatLineWithHash(originalLines[i], originalHashes[i])}`)
		}

		// 2. Deletion Summary (only count lines that are truly gone)
		const finalHashesSet = new Set(finalHashes.slice(startIdx, endIdx + 1))
		let trulyRemovedCount = 0
		for (let i = originalStartIdx; i <= originalEndIdx; i++) {
			if (!finalHashesSet.has(originalHashes[i])) {
				trulyRemovedCount++
			}
		}

		if (trulyRemovedCount > 0) {
			res.push(`${trulyRemovedCount} lines between ${edit.anchor} and ${edit.end_anchor} have been deleted`)
		}

		// 3. Added/Neutral Lines (from final state)
		const originalHashesSet = new Set(originalHashes.slice(originalStartIdx, originalEndIdx + 1))
		for (let i = startIdx; i <= endIdx; i++) {
			const hash = finalHashes[i]
			const prefix = originalHashesSet.has(hash) ? " " : "+"
			res.push(`${prefix}${formatLineWithHash(finalLines[i], hash)}`)
		}

		// 4. Context After (from final state)
		const afterEnd = Math.min(finalLines.length - 1, endIdx + contextCount)
		for (let i = endIdx + 1; i <= afterEnd; i++) {
			res.push(` ${formatLineWithHash(finalLines[i], finalHashes[i])}`)
		}

		return res.join("\n")
	}

	getDiffBlock(
		originalLines: string[],
		originalHashes: string[],
		finalLines: string[],
		finalHashes: string[],
		applied: AppliedEdit,
	): string {
		const contextBeforeCount = 3
		const contextAfterCount = 3
		const { originalStartIdx, originalEndIdx, startIdx, endIdx } = applied
		const res: string[] = []

		const beforeStart = Math.max(0, originalStartIdx - contextBeforeCount)
		for (let i = beforeStart; i < originalStartIdx; i++) {
			res.push(` ${formatLineWithHash(originalLines[i], originalHashes[i])}`)
		}

		const finalHashesSet = new Set(finalHashes.slice(startIdx, endIdx + 1))
		for (let i = originalStartIdx; i <= originalEndIdx; i++) {
			if (!finalHashesSet.has(originalHashes[i])) {
				res.push(`-${formatLineWithHash(originalLines[i], originalHashes[i])}`)
			}
		}

		const originalHashesSet = new Set(originalHashes.slice(originalStartIdx, originalEndIdx + 1))
		for (let i = startIdx; i <= endIdx; i++) {
			const hash = finalHashes[i]
			const prefix = originalHashesSet.has(hash) ? " " : "+"
			res.push(`${prefix}${formatLineWithHash(finalLines[i], hash)}`)
		}

		const afterEnd = Math.min(finalLines.length - 1, endIdx + contextAfterCount)
		for (let i = endIdx + 1; i <= afterEnd; i++) {
			res.push(` ${formatLineWithHash(finalLines[i], finalHashes[i])}`)
		}
		return res.join("\n")
	}

	createResultsResponse(
		prepared: PreparedEdits,
		finalLines: string[],
		newLineHashes: string[],
		diagnosticsResult: { newProblemsMessage: string; fixedCount: number },
		diffMode: "full" | "additions-only",
		autoFormattingEdits?: string,
		userEdits?: string,
		wasStringified?: boolean,
	): ToolResponse {
		const { resolvedEdits, failedEdits, appliedEdits, lines, lineHashes } = prepared
		const appliedDiffs: string[] = []

		let totalAdded = 0
		let totalRemoved = 0

		for (const applied of appliedEdits) {
			const { originalStartIdx, originalEndIdx, startIdx, endIdx } = applied

			// Calculate added/removed lines for this edit
			const originalHashesSet = new Set(lineHashes.slice(originalStartIdx, originalEndIdx + 1))
			const finalHashesSet = new Set(newLineHashes.slice(startIdx, endIdx + 1))

			// Removed: lines in original range not in final range
			for (let i = originalStartIdx; i <= originalEndIdx; i++) {
				if (!finalHashesSet.has(lineHashes[i])) {
					totalRemoved++
				}
			}

			// Added: lines in final range not in original range
			for (let i = startIdx; i <= endIdx; i++) {
				if (!originalHashesSet.has(newLineHashes[i])) {
					totalAdded++
				}
			}

			const diffBlock =
				diffMode === "additions-only"
					? this.getAdditionOnlyDiffBlock(lines, lineHashes, finalLines, newLineHashes, applied)
					: this.getDiffBlock(lines, lineHashes, finalLines, newLineHashes, applied)
			appliedDiffs.push(diffBlock)
		}

		const totalDiffLines = appliedDiffs.reduce((acc, d) => acc + d.split("\n").length, 0)
		const useFullFile = totalDiffLines > finalLines.length * 0.7 && finalLines.length > 0

		const results: string[] = []
		if (useFullFile) {
			results.push(
				`Because the changes were extensive, the full updated file content with anchors is provided below to ensure clarity:\n\n${finalLines
					.map((line, i) => formatLineWithHash(line, newLineHashes[i]))
					.join("\n")}`,
			)
		} else {
			results.push(...appliedDiffs)
		}

		for (const failed of failedEdits) {
			results.push(this.executor.formatFailureMessage(failed.edit, failed.error))
		}

		// Check for accidental literal \n in applied edits
		for (const applied of appliedEdits) {
			if (applied.edit.text.includes("\\n")) {
				const anchorName = applied.edit.anchor.split(getDelimiter())[0]
				const endAnchorName = applied.edit.end_anchor?.split(getDelimiter())[0]
				const endAnchorPart = endAnchorName ? ` and ending with ${endAnchorName}` : ""
				results.push(
					`Your edit starting with ${anchorName}${endAnchorPart} inserted a '\\n' literal in the code because you supplied double backslash '\\\\n'. If you meant to add a newline char instead, update it using '\\n' in the next call. You do not need escape characters in the text portion`,
				)
			}
		}

		if (diagnosticsResult.fixedCount > 0) {
			results.push(`Fixed ${diagnosticsResult.fixedCount} linter error(s).`)
		}

		if (diagnosticsResult.newProblemsMessage) {
			const message = diagnosticsResult.newProblemsMessage.trim()
			if (message.length > 0) {
				results.push(`New problems detected after saving the file:\n${message}`)
			}
		}

		if (userEdits) {
			results.push(`*** User Modified File CRITICAL: The user manually modified the file during review. You MUST NOT revert these changes. If you need to fix syntax errors in the same area, you MUST incorporate the user's changes into your new edits.): ${prepared.displayPath}\n\n${userEdits}`)
		}

		if (autoFormattingEdits) {
			results.push(
				`The user's editor also applied the following auto-formatting to your content:\n\n${autoFormattingEdits}\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future edit_file operations to this file are accurate.)`,
			)
		}

		const lineChanges = ` (+${totalAdded}, -${totalRemoved} lines)`
		const summary = `Applied ${resolvedEdits.length} edit(s) successfully${lineChanges}. NOTE the UPDATED anchors below.${failedEdits.length > 0 ? ` ${failedEdits.length} edit(s) failed.` : ""
			}`
		if (wasStringified) {
			results.push(`Note: You provided the 'files' parameter as a stringified JSON array. While this was successfully parsed and applied, you should provide it as a native JSON array in the future.`)
		}

		return formatResponse.toolResult(`${summary}\n\n${results.join("\n\n---\n\n")}`)
	}
}
