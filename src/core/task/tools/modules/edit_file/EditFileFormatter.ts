import * as diff from "diff"
import { PreparedFileBatch } from "./types"

// Handles diff generation and edit message construction for the edit_file tool.
export class EditFileFormatter {
	// Generates a unified diff patch between original and final line arrays.
	generateDiff(displayPath: string, originalLines: string[], finalLines: string[]): string {
		return diff.createPatch(displayPath, originalLines.join("\n"), finalLines.join("\n"))
	}

	// Builds the structured edit message object for a batch of prepared files.
	buildEditMessage(batches: PreparedFileBatch[]): any {
		const totalRequestedEdits = batches.reduce((acc, b) => acc + b.prepared!.resolvedEdits.length, 0)
		const diffs = batches.map((b) => b.prepared?.diff).join("\n\n")
		return {
			tool: "editFile",
			path: batches.length === 1 ? batches[0].displayPath : "Multiple files",
			filesCount: batches.length,
			editsCount: totalRequestedEdits,
			diff: diffs,
			editSummaries: batches.map((b) => ({
				path: b.displayPath,
				edits: b.prepared?.appliedEdits.map((ae) => ({ additions: ae.linesAdded, deletions: ae.linesDeleted })) || [],
				diff: b.prepared?.diff,
				finalContent: b.prepared?.finalContent,
			})),
			operationIsLocatedInWorkspace: true,
			hint: "Review and edit in the editor before approving.",
		}
	}
}
