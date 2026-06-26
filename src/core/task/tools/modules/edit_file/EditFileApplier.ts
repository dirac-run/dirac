import { CardStatus } from "@/shared/ExtensionMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolResponse } from "../../types/ToolResponse"
import { EditFormatter } from "./utils/EditFormatter"
import { PreparedFileBatch } from "./types"

// Applies prepared batches to disk, formats files, and produces final diagnostic results.
export class EditFileApplier {
	constructor(private resultsFormatter: EditFormatter) {}

	async applyAndSave(env: IToolEnvironment, preparedBatches: PreparedFileBatch[], cards: Record<string, any>, userEdits?: Record<string, string>): Promise<Map<string, any>> {
		const appliedResults = new Map<string, any>()

		// Update all cards to RUNNING state
		await Promise.all(preparedBatches.map(async (batch) => {
			const card = cards[batch.absolutePath]
			if (card) await card.update({ status: CardStatus.RUNNING, body: "Applying edits..." })
		}))

		// Prepare files for batch application — override with user edits if present
		const filesToApply = preparedBatches.map((batch) => ({
			path: batch.absolutePath,
			content: userEdits?.[batch.displayPath] ?? batch.prepared!.finalContent,
		}))
		const batchResults = await env.editor.applyAndSaveBatchSilently(filesToApply)

		// Best-effort formatting after saving
		for (const batch of preparedBatches) {
			try { await env.editor.format(batch.absolutePath) } catch { /* formatting is best-effort */ }
		}

		// Process results and update cards
		await Promise.all(preparedBatches.map(async (batch) => {
			const saveResult = batchResults.get(batch.absolutePath)
			if (!saveResult) return
			let finalContent: string
			try { finalContent = await env.workspace.readFile(batch.absolutePath) }
			catch { finalContent = saveResult.content || batch.prepared!.finalContent }
			const finalLines = finalContent.split(/\r?\n/)

			appliedResults.set(batch.absolutePath, {
				saveResult,
				finalContent,
				finalLines,
				newLineHashes: AnchorStateManager.reconcile(batch.absolutePath, finalLines, env.config.ulid),
			})

			const card = cards[batch.absolutePath]
			if (card) await card.update({ header: `Edited ${batch.displayPath}`, status: CardStatus.SUCCESS, body: batch.prepared!.diff, renderType: "diff" })
		}))

		return appliedResults
	}

	async finalizeResults(env: IToolEnvironment, preparedBatches: PreparedFileBatch[], appliedResults: Map<string, any>): Promise<ToolResponse[]> {
		const results: ToolResponse[] = []
		const paths = preparedBatches.map((b) => b.absolutePath)
		await env.diagnostics.prepare(paths)
		const rawDiagnostics = await env.diagnostics.getRaw(paths)

		for (const batch of preparedBatches) {
			const applied = appliedResults.get(batch.absolutePath)
			const fileDiagnostics = rawDiagnostics.find((d) => d.filePath === batch.absolutePath)?.diagnostics || []
			const diagnosticsResult = { newProblemsMessage: fileDiagnostics.length > 0 ? `Found ${fileDiagnostics.length} problems` : "", fixedCount: 0 }
			const result = this.resultsFormatter.createResultsResponse(
				batch.prepared!, applied.finalLines, applied.newLineHashes, diagnosticsResult, "full",
				applied.saveResult?.autoFormattingEdits, applied.saveResult?.userEdits, false,
			)
			results.push(result)
		}
		return results
	}
}
