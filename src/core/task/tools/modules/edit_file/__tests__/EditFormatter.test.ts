import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { PreparedEdits } from "../types"
import { EditExecutor } from "../utils/EditExecutor"
import { EditFormatter } from "../utils/EditFormatter"

function prepareEdit(lineCount: number): PreparedEdits {
	const lines = Array.from({ length: lineCount }, (_, index) => `line ${index}`)
	const finalLines = ["changed", ...lines.slice(1)]
	const edit = { edit_type: "replace" as const, anchor: "Old§line 0", text: "changed" }
	return {
		content: lines.join("\n"),
		finalContent: finalLines.join("\n"),
		diff: "",
		lines,
		finalLines,
		lineHashes: lines.map((_, index) => `old${index}`),
		displayPath: "file.ts",
		fileIndex: 0,
		resolvedEdits: [{ lineIdx: 0, endIdx: 0, edit, editIndex: 0 }],
		failedEdits: [],
		appliedEdits: [{ startIdx: 0, endIdx: 0, originalStartIdx: 0, originalEndIdx: 0, edit, linesAdded: 1, linesDeleted: 1 }],
	}
}

const formatter = new EditFormatter(new EditExecutor())
const cleanDiagnostics = { newProblemsMessage: "", fixedCount: 0 }

function format(prepared: PreparedEdits, autoFormatting = false, userModified = false, problems = ""): string {
	return formatter.createResultsResponse(
		prepared,
		prepared.finalLines,
		["new", ...prepared.lineHashes.slice(1)],
		{ ...cleanDiagnostics, newProblemsMessage: problems },
		"full",
		autoFormatting,
		userModified,
	) as string
}

describe("EditFormatter results", () => {
	for (const [lineCount, label] of [
		[20, "Diff (unanchored):"],
		[2, "Updated file content (unanchored):"],
	] as const) {
		it(`labels ${label} without repeated editing instructions`, () => {
			const result = format(prepareEdit(lineCount))
			assert.ok(result.startsWith("Applied 1 edit(s) successfully (+1, -1 lines)."))
			assert.ok(result.includes(label))
			assert.ok(result.includes("changed"))
			assert.ok(!/reread|IMPORTANT|CRITICAL|undefined|Auto-formatting|User modified|Diagnostics:/.test(result))
		})
	}

	it("reports boolean change flags without treating them as diff text", () => {
		const result = format(prepareEdit(20), true, true)
		assert.ok(result.includes("User modified this file during review; preserve their changes."))
		assert.ok(result.includes("Auto-formatting applied."))
		assert.ok(!/true|Pay close attention|MUST/.test(result))
	})

	it("does not claim post-save diagnostics are newly introduced", () => {
		const result = format(prepareEdit(20), false, false, "Found 2 problems\nproblem details")
		assert.ok(result.includes("Diagnostics:\nFound 2 problems\nproblem details"))
		assert.ok(!result.includes("New problems"))
	})

	it("retains partial-success counts and indexed failures without duplicating batch retry instructions", () => {
		const prepared = prepareEdit(20)
		prepared.failedEdits.push({ edit: prepared.resolvedEdits[0].edit, editIndex: 1, error: "Missing anchor" })
		const result = format(prepared)
		assert.ok(result.includes("Partial success in files[0] (file.ts): 1 edit(s) applied (+1, -1 lines); 1 failed."))
		assert.ok(result.includes("files[0].edits[1]"))
		assert.ok(result.includes("Missing anchor"))
		assert.ok(!result.includes("Do not retry"))
	})

	it("retains the saved-file anchor-limit warning and alternative", () => {
		const prepared = prepareEdit(2)
		const result = formatter.createResultsResponse(
			prepared,
			prepared.finalLines,
			undefined,
			cleanDiagnostics,
			"full",
			false,
			false,
			"File exceeds anchor limits.",
		) as string
		assert.ok(result.startsWith("Applied 1 edit(s) successfully"))
		assert.ok(result.includes("Warning after saving: File exceeds anchor limits."))
		assert.ok(result.includes("use execute_command"))
	})
})
