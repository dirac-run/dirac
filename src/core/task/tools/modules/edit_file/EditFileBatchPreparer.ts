import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/formatResponse"
import { DiracDefaultTool } from "@shared/tools"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { stripHashesFromDiff } from "@utils/line-hashing"
import { CardStatus } from "@/shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolResponse } from "../../types/ToolResponse"
import { EditFileFormatter } from "./EditFileFormatter"
import { FileEdit, PreparedEdits, PreparedFileBatch } from "./types"
import { EditExecutor } from "./utils/EditExecutor"
import { EditFormatter } from "./utils/EditFormatter"

// Prepares file batches: resolves paths, checks diracignore, resolves anchors, applies edits in memory.
export class EditFileBatchPreparer {
	constructor(
		private executor: EditExecutor,
		private fileFormatter: EditFileFormatter,
		private resultsFormatter: EditFormatter,
	) {}

	async prepare(files: FileEdit[], env: IToolEnvironment) {
		const preparedBatches: PreparedFileBatch[] = []
		let hasError = false
		const cards: Record<string, any> = {}
		const results: ToolResponse[] = []
		let totalRequestedEdits = 0

		for (const file of files) {
			const { absolutePath, displayPath } = await env.workspace.resolvePath(file.path)
			if (!env.config.services.diracIgnoreController.validateAccess(file.path)) {
				hasError = true
				results.push(formatResponse.diracIgnoreError(file.path))
				continue
			}

			const prepared = await this.prepareEdits(absolutePath, displayPath, file.edits, env)
			if ("error" in prepared) {
				if (cards[absolutePath])
					await cards[absolutePath].update({ status: CardStatus.ERROR, body: `✕ Error: ${prepared.error}` })
				hasError = true
				results.push(prepared.error)
				continue
			}

			const { finalLines, appliedEdits } = this.executor.applyEdits(prepared.lines, prepared.resolvedEdits)
			if (!env.config.isSubagentExecution) {
				const additions = appliedEdits.reduce((acc, e) => acc + e.linesAdded, 0)
				const deletions = appliedEdits.reduce((acc, e) => acc + e.linesDeleted, 0)
				const stats = additions > 0 || deletions > 0 ? ` (+${additions}, -${deletions})` : ""
				cards[absolutePath] = await env.ui.createCard({
					header: `Editing ${displayPath}`,
					icon: DiracIcon.FILE_EDIT,
					collapsed: true,
				})
			}
			prepared.finalLines = finalLines
			prepared.finalContent = finalLines.join("\n")
			prepared.appliedEdits = appliedEdits
			prepared.diff = this.fileFormatter.generateDiff(displayPath, prepared.lines, finalLines)
			if (cards[absolutePath]) await cards[absolutePath].update({ body: stripHashesFromDiff(prepared.diff) })

			preparedBatches.push({ absolutePath, displayPath, blocks: [], prepared })
			totalRequestedEdits += prepared.resolvedEdits.length
		}

		return { preparedBatches, results, totalRequestedEdits, cards, hasError }
	}

	private async prepareEdits(
		absolutePath: string,
		displayPath: string,
		edits: any[],
		env: IToolEnvironment,
	): Promise<PreparedEdits | { error: any }> {
		try {
			await env.workspace.saveOpenDocumentIfDirty({ filePath: absolutePath })
			const content = await env.workspace.readFile(absolutePath)
			const lines = content.split(/\r?\n/)
			const lineHashes = AnchorStateManager.reconcile(absolutePath, lines, env.config.ulid)
			const { resolvedEdits, failedEdits } = this.executor.resolveEdits(
				[{ type: "tool_use", name: DiracDefaultTool.EDIT_FILE, params: { edits } } as ToolUse],
				lines,
				lineHashes,
			)
			if (resolvedEdits.length === 0) {
				const failureMessages = failedEdits.map((f) => this.executor.formatFailureMessage(f.edit, f.error))
				return { error: formatResponse.toolError(failureMessages.join("\n\n")) }
			}
			return {
				content,
				finalContent: content,
				diff: "",
				resolvedEdits,
				failedEdits,
				appliedEdits: [],
				lines,
				lineHashes,
				finalLines: lines,
				displayPath,
			}
		} catch (error: any) {
			return { error: formatResponse.toolError(`Error preparing edits: ${error.message}`) }
		}
	}
}
