import { CardStatus } from "@/shared/ExtensionMessage"
import {
	anchorByteLimitMessage,
	anchorLimitMessage,
	MAX_ANCHORED_FILE_BYTES,
	MAX_ANCHORED_FILE_LINES,
} from "@shared/anchor-limits"
import type { IToolEnvironment, SaveResult } from "../../interfaces/IToolEnvironment"
import type { ToolResponse } from "../../types/ToolResponse"
import { PreparedFileBatch } from "./types"
import { EditFormatter } from "./utils/EditFormatter"

interface AppliedFileResult {
	saveResult: SaveResult
	finalContent: string
	finalLines: string[]
	newLineHashes: string[] | undefined
	postSaveWarning: string | undefined
	userModified: boolean
}

// Applies prepared batches to disk, formats files, and produces final diagnostic results.
export class EditFileApplier {
	constructor(private resultsFormatter: EditFormatter) { }

	async applyAndSave(
		env: IToolEnvironment,
		preparedBatches: PreparedFileBatch[],
		cards: Record<string, any>,
		userEdits?: Record<string, string>,
	): Promise<Map<string, AppliedFileResult>> {
		const appliedResults = new Map<string, AppliedFileResult>()
		const filesToApply = preparedBatches.map((batch) => ({
			path: batch.absolutePath,
			content: userEdits?.[batch.displayPath] ?? batch.prepared!.finalContent,
		}))

		for (const [index, file] of filesToApply.entries()) {
			if (Buffer.byteLength(file.content, "utf8") > MAX_ANCHORED_FILE_BYTES) {
				throw new Error(`Cannot save ${preparedBatches[index].displayPath}: ${anchorByteLimitMessage()}`)
			}
			const lineCount = file.content.split(/\r?\n/).length
			if (lineCount > MAX_ANCHORED_FILE_LINES) {
				throw new Error(`Cannot save ${preparedBatches[index].displayPath}: ${anchorLimitMessage(lineCount)}`)
			}
		}

		await Promise.all(
			preparedBatches.map(async (batch) => {
				const card = cards[batch.absolutePath]
				if (card) await card.update({ status: CardStatus.RUNNING, body: "Applying edits..." })
			}),
		)

		const batchResults = await env.editor.applyAndSaveBatchSilently(filesToApply)
		const formattedContents = new Map<string, string>()

		for (const batch of preparedBatches) {
			try {
				formattedContents.set(batch.absolutePath, await env.editor.format(batch.absolutePath))
			} catch {
				// Formatting is best-effort; the confirmed save result remains authoritative.
			}
		}

		await Promise.all(
			preparedBatches.map(async (batch) => {
				const saveResult = batchResults.get(batch.absolutePath)
				if (!saveResult) return
				const finalContent = formattedContents.get(batch.absolutePath) ?? saveResult.content
				const finalLines = finalContent.split(/\r?\n/)
				const postSaveWarning = finalLines.length > MAX_ANCHORED_FILE_LINES
					? anchorLimitMessage(finalLines.length)
					: Buffer.byteLength(finalContent, "utf8") > MAX_ANCHORED_FILE_BYTES
						? anchorByteLimitMessage()
						: undefined
				const newLineHashes = postSaveWarning
					? undefined
					: env.anchors.reconcile(batch.absolutePath, finalLines)
				if (postSaveWarning) env.anchors.clear(batch.absolutePath)

				appliedResults.set(batch.absolutePath, {
					saveResult,
					userModified: saveResult.userEdits || userEdits?.[batch.displayPath] !== undefined,
					finalContent,
					finalLines,
					newLineHashes,
					postSaveWarning,
				})

				const card = cards[batch.absolutePath]
				if (!card) return
				const prepared = batch.prepared!
				const isPartial = prepared.failedEdits.length > 0
				const header = isPartial
					? `Partially edited ${batch.displayPath} — ${prepared.resolvedEdits.length} applied, ${prepared.failedEdits.length} failed`
					: `Edited ${batch.displayPath} — ${prepared.resolvedEdits.length} edit(s) applied`
				const failureSummary = prepared.failedEdits
					.map((failed) => `files[${prepared.fileIndex}].edits[${failed.editIndex}] failed: ${failed.error}`)
					.join("\n\n")
				const warning = postSaveWarning ? `Warning after saving: ${postSaveWarning}` : ""
				await card.update({
					header,
					status: CardStatus.SUCCESS,
					body: [prepared.diff, failureSummary, warning].filter(Boolean).join("\n\n"),
					renderType: "diff",
					diffs: [
						{
							path: batch.displayPath,
							oldText: prepared.content,
							newText: finalContent,
						},
					],
				})
				await card.finalize(CardStatus.SUCCESS)
			}),
		)

		return appliedResults
	}

	async finalizeResults(
		env: IToolEnvironment,
		preparedBatches: PreparedFileBatch[],
		appliedResults: Map<string, AppliedFileResult>,
	): Promise<ToolResponse[]> {
		const results: ToolResponse[] = []
		const paths = preparedBatches.map((b) => b.absolutePath)
		await env.diagnostics.prepare(paths)
		const rawDiagnostics = await env.diagnostics.getRaw(paths)

		for (const batch of preparedBatches) {
			const applied = appliedResults.get(batch.absolutePath)!
			const fileDiagnostics = rawDiagnostics.find((d) => d.filePath === batch.absolutePath)?.diagnostics || []
			const fileContentMap = applied.newLineHashes
				? new Map([[batch.absolutePath, { lines: applied.finalLines, hashes: applied.newLineHashes }]])
				: undefined
			const diagnosticDetails = await env.diagnostics.formatProblems(
				[{ filePath: batch.absolutePath, diagnostics: fileDiagnostics }],
				fileContentMap,
			)
			const diagnosticsResult = {
				newProblemsMessage:
					fileDiagnostics.length > 0
						? `Found ${fileDiagnostics.length} problems${diagnosticDetails ? `\n${diagnosticDetails}` : ""}`
						: "",
				fixedCount: 0,
			}
			const result = this.resultsFormatter.createResultsResponse(
				batch.prepared!,
				applied.finalLines,
				applied.newLineHashes,
				diagnosticsResult,
				"full",
				applied.saveResult.autoFormatting,
				applied.userModified,
				applied.postSaveWarning,
			)
			results.push(result)
		}
		return results
	}
}
