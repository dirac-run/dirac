import { formatResponse } from "@core/formatResponse"
import type { ToolResponse } from "../../../types/ToolResponse"
import { AppliedEdit, PreparedEdits } from "../types"
import { EditExecutor } from "./EditExecutor"

export class EditFormatter {
	constructor(private executor: EditExecutor) { }

	getAdditionOnlyDiffBlock(
		originalLines: string[],
		originalHashes: string[],
		finalLines: string[],
		finalHashes: string[],
		applied: AppliedEdit,
	): string {
		const { originalStartIdx, originalEndIdx, startIdx, endIdx } = applied
		const res: string[] = []
		const contextCount = 3

		const finalStartIdx = Math.min(startIdx, finalLines.length)
		const beforeStart = Math.max(0, finalStartIdx - contextCount)
		for (let i = beforeStart; i < finalStartIdx; i++) res.push(` ${finalLines[i]}`)

		const finalHashesSet = new Set(finalHashes.slice(startIdx, endIdx + 1))
		let trulyRemovedCount = 0
		for (let i = originalStartIdx; i <= originalEndIdx; i++) {
			if (!finalHashesSet.has(originalHashes[i])) trulyRemovedCount++
		}
		if (trulyRemovedCount > 0) res.push(`${trulyRemovedCount} selected line(s) were deleted`)

		const originalHashesSet = new Set(originalHashes.slice(originalStartIdx, originalEndIdx + 1))
		for (let i = startIdx; i <= endIdx; i++) {
			const prefix = originalHashesSet.has(finalHashes[i]) ? " " : "+"
			res.push(`${prefix}${finalLines[i]}`)
		}

		const afterEnd = Math.min(finalLines.length - 1, endIdx + contextCount)
		for (let i = endIdx + 1; i <= afterEnd; i++) res.push(` ${finalLines[i]}`)
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

		const finalStartIdx = Math.min(startIdx, finalLines.length)
		const beforeStart = Math.max(0, finalStartIdx - contextBeforeCount)
		for (let i = beforeStart; i < finalStartIdx; i++) res.push(` ${finalLines[i]}`)

		const finalHashesSet = new Set(finalHashes.slice(startIdx, endIdx + 1))
		for (let i = originalStartIdx; i <= originalEndIdx; i++) {
			if (!finalHashesSet.has(originalHashes[i])) res.push(`-${originalLines[i]}`)
		}

		const originalHashesSet = new Set(originalHashes.slice(originalStartIdx, originalEndIdx + 1))
		for (let i = startIdx; i <= endIdx; i++) {
			const prefix = originalHashesSet.has(finalHashes[i]) ? " " : "+"
			res.push(`${prefix}${finalLines[i]}`)
		}

		const afterEnd = Math.min(finalLines.length - 1, endIdx + contextAfterCount)
		for (let i = endIdx + 1; i <= afterEnd; i++) res.push(` ${finalLines[i]}`)
		return res.join("\n")
	}

	createResultsResponse(
		prepared: PreparedEdits,
		finalLines: string[],
		newLineHashes: string[] | undefined,
		diagnosticsResult: { newProblemsMessage: string; fixedCount: number },
		diffMode: "full" | "additions-only",
		autoFormatting?: boolean,
		userModified?: boolean,
		postSaveWarning?: string,
	): ToolResponse {
		const { resolvedEdits, failedEdits, appliedEdits, lines, lineHashes } = prepared
		const results: string[] = []
		let totalAdded = 0
		let totalRemoved = 0

		if (newLineHashes) {
			const appliedDiffs: string[] = []
			for (const applied of appliedEdits) {
				const { originalStartIdx, originalEndIdx, startIdx, endIdx } = applied
				const originalHashesSet = new Set(lineHashes.slice(originalStartIdx, originalEndIdx + 1))
				const finalHashesSet = new Set(newLineHashes.slice(startIdx, endIdx + 1))

				for (let i = originalStartIdx; i <= originalEndIdx; i++) {
					if (!finalHashesSet.has(lineHashes[i])) totalRemoved++
				}
				for (let i = startIdx; i <= endIdx; i++) {
					if (!originalHashesSet.has(newLineHashes[i])) totalAdded++
				}

				const diffBlock =
					diffMode === "additions-only"
						? this.getAdditionOnlyDiffBlock(lines, lineHashes, finalLines, newLineHashes, applied)
						: this.getDiffBlock(lines, lineHashes, finalLines, newLineHashes, applied)
				appliedDiffs.push(diffBlock)
			}

			const totalDiffLines = appliedDiffs.reduce((acc, diff) => acc + diff.split("\n").length, 0)
			const useFullFile = totalDiffLines > finalLines.length * 0.7 && finalLines.length > 0
			if (useFullFile) {
				results.push(`Updated file content (unanchored):\n\n${finalLines.join("\n")}`)
			} else {
				results.push(`Diff (unanchored):\n\n${appliedDiffs.join("\n\n")}`)
			}
		} else {
			for (const applied of appliedEdits) {
				totalAdded += applied.linesAdded
				totalRemoved += applied.linesDeleted
			}
			results.push(
				`Warning after saving: ${postSaveWarning ?? "Hash anchors are unavailable for the saved file."} Anchored edit_file calls are unavailable; use execute_command for further changes.`,
			)
		}

		for (const failed of failedEdits) {
			results.push(
				this.executor.formatFailureMessage(failed.edit, failed.error, {
					fileIndex: prepared.fileIndex,
					editIndex: failed.editIndex,
				}),
			)
		}

		if (diagnosticsResult.fixedCount > 0) results.push(`Fixed ${diagnosticsResult.fixedCount} linter error(s).`)
		if (diagnosticsResult.newProblemsMessage.trim()) {
			results.push(`Diagnostics:\n${diagnosticsResult.newProblemsMessage.trim()}`)
		}
		if (userModified) results.push("User modified this file during review; preserve their changes.")
		if (autoFormatting) results.push("Auto-formatting applied.")

		const lineChanges = ` (+${totalAdded}, -${totalRemoved} lines)`
		const summary = failedEdits.length > 0
			? `Partial success in files[${prepared.fileIndex}] (${prepared.displayPath}): ${resolvedEdits.length} edit(s) applied${lineChanges}; ${failedEdits.length} failed.`
			: `Applied ${resolvedEdits.length} edit(s) successfully${lineChanges}.`

		return formatResponse.toolResult(`${summary}\n\n${results.join("\n\n---\n\n")}`)
	}
}
