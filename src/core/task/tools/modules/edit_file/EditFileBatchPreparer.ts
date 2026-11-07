import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/formatResponse"
import { DiracDefaultTool } from "@shared/tools"
import {
	anchorByteLimitMessage,
	anchorLimitMessage,
	MAX_ANCHORED_FILE_BYTES,
	MAX_ANCHORED_FILE_LINES,
} from "@shared/anchor-limits"
import { stripHashesFromDiff } from "@utils/line-hashing"
import { CardStatus } from "@/shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolResponse } from "../../types/ToolResponse"
import { EditFileFormatter } from "./EditFileFormatter"
import { FileEdit, PreparedEdits, PreparedFileBatch } from "./types"
import { EditExecutor } from "./utils/EditExecutor"

// Prepares file batches: resolves paths, checks diracignore, resolves anchors, applies edits in memory.
export class EditFileBatchPreparer {
	constructor(
		private executor: EditExecutor,
		private fileFormatter: EditFileFormatter,
	) { }

	async prepare(files: FileEdit[], env: IToolEnvironment, cards: Record<string, any> = {}) {
		const preparedBatches: PreparedFileBatch[] = []
		const results: ToolResponse[] = []
		const totalRequestedEdits = files.reduce((count, file) => count + file.edits.length, 0)
		let totalResolvedEdits = 0
		let totalFailedEdits = 0

		for (const [fileIndex, file] of files.entries()) {
			const { absolutePath, displayPath } = await env.workspace.resolvePath(file.path)
			if (!env.config.services.diracIgnoreController.validateAccess(file.path)) {
				totalFailedEdits += file.edits.length
				results.push(formatResponse.diracIgnoreError(file.path))
				continue
			}

			const prepared = await this.prepareEdits(absolutePath, displayPath, file.edits, fileIndex, env)
			if ("error" in prepared) {
				totalFailedEdits += file.edits.length
				results.push(prepared.error)
				continue
			}

			totalResolvedEdits += prepared.resolvedEdits.length
			totalFailedEdits += prepared.failedEdits.length

			const failureMessages = prepared.failedEdits.map((failed) =>
				this.executor.formatFailureMessage(failed.edit, failed.error, { fileIndex, editIndex: failed.editIndex }),
			)
			if (prepared.resolvedEdits.length === 0) {
				const failureMessage = failureMessages.join("\n\n")
				results.push(failureMessage)
				const card = await env.ui.createCard({
					header: `Could not edit ${displayPath} — ${prepared.failedEdits.length} edit(s) failed`,
					icon: DiracIcon.FILE_EDIT,
					status: CardStatus.ERROR,
					body: failureMessage,
					collapsed: true,
				})
				await card.finalize(CardStatus.ERROR)
				continue
			}

			const { finalLines, appliedEdits } = this.executor.applyEdits(prepared.lines, prepared.resolvedEdits)
			prepared.finalLines = finalLines
			prepared.finalContent = finalLines.join("\n")
			prepared.appliedEdits = appliedEdits
			prepared.diff = this.fileFormatter.generateDiff(displayPath, prepared.lines, finalLines)

			const partialSuffix =
				prepared.failedEdits.length > 0
					? ` — ${prepared.resolvedEdits.length} ready, ${prepared.failedEdits.length} failed`
					: ""
			cards[absolutePath] = await env.ui.createCard({
				header: `Editing ${displayPath}${partialSuffix}`,
				icon: DiracIcon.FILE_EDIT,
				collapsed: true,
			})
			const cardBody = [stripHashesFromDiff(prepared.diff), ...failureMessages].filter(Boolean).join("\n\n")
			await cards[absolutePath].update({ body: cardBody })

			preparedBatches.push({ absolutePath, displayPath, blocks: [], prepared })
		}

		return {
			preparedBatches,
			results,
			totalRequestedEdits,
			totalResolvedEdits,
			totalFailedEdits,
			cards,
		}
	}

	private async prepareEdits(
		absolutePath: string,
		displayPath: string,
		edits: any[],
		fileIndex: number,
		env: IToolEnvironment,
	): Promise<PreparedEdits | { error: string }> {
		try {
			const fileInfo = await env.workspace.getFileInfo(absolutePath)
			if (fileInfo.size > MAX_ANCHORED_FILE_BYTES) {
				return { error: `Cannot edit ${displayPath}: ${anchorByteLimitMessage()}` }
			}
			const diskLineCount = await env.workspace.countTextFileLines(absolutePath)
			if (diskLineCount > MAX_ANCHORED_FILE_LINES) {
				return { error: `Cannot edit ${displayPath}: ${anchorLimitMessage(diskLineCount)}` }
			}
			const content = await env.editor.readText(absolutePath)
			if (Buffer.byteLength(content, "utf8") > MAX_ANCHORED_FILE_BYTES) {
				return { error: `Cannot edit ${displayPath}: ${anchorByteLimitMessage()}` }
			}
			const lines = content.split(/\r?\n/)
			if (lines.length > MAX_ANCHORED_FILE_LINES) {
				return { error: `Cannot edit ${displayPath}: ${anchorLimitMessage(lines.length)}` }
			}
			const lineHashes = env.anchors.reconcile(absolutePath, lines)
			const { resolvedEdits, failedEdits } = this.executor.resolveEdits(
				[{ type: "tool_use", name: DiracDefaultTool.EDIT_FILE, params: { edits } } as ToolUse],
				lines,
				lineHashes,
			)
			const { finalLines } = this.executor.applyEdits(lines, resolvedEdits)
			if (finalLines.length > MAX_ANCHORED_FILE_LINES) {
				return { error: `Cannot edit ${displayPath}: the requested edits would produce ${finalLines.length.toLocaleString()} lines, above the ${MAX_ANCHORED_FILE_LINES.toLocaleString()}-line hash-anchoring limit.` }
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
				fileIndex,
			}
		} catch (error: any) {
			return { error: `Error preparing edits for ${displayPath}: ${error.message}` }
		}
	}
}
