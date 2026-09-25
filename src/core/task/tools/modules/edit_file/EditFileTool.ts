import { formatResponse } from "@core/formatResponse"
import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { getAnchoredLinePattern, getDelimiter } from "@utils/line-hashing"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { ToolResponseCombiner } from "../../utils/ToolResponseCombiner"
import { EditFileApplier } from "./EditFileApplier"
import { EditFileApprovalFlow } from "./EditFileApprovalFlow"
import { EditFileBatchPreparer } from "./EditFileBatchPreparer"
import { EditFileFormatter } from "./EditFileFormatter"
import { EditFileValidator } from "./EditFileValidator"
import { FileEdit } from "./types"
import { EditExecutor } from "./utils/EditExecutor"
import { EditFormatter } from "./utils/EditFormatter"

export interface EditFileArgs {
	files: FileEdit[]
}

export const edit_file_spec: DiracToolSpec = {
	id: DiracDefaultTool.EDIT_FILE,
	name: "edit_file",
	description: `Edit one or more files by replacing, inserting after, or inserting before specific lines.

REQUIRED LINE ANCHORS:
edit_file can only edit lines identified by current line anchors. It has no line-number, search-text, or unanchored editing mode. Before calling it, obtain anchored output containing every line you will use as anchor or end_anchor from read_file, search_files, or inspect_ast with include_anchors: true. edit_file cannot infer or create these coordinates.

Each anchored source line has the form ANCHOR${getDelimiter()}CONTENT. The word before ${getDelimiter()} is an opaque, file-scoped line ID maintained for the current conversation; the text after it is the exact current source line. Unchanged lines keep their IDs when surrounding lines move. New or changed lines get new IDs, and deleted-line IDs stop resolving.

The complete ANCHOR${getDelimiter()}CONTENT line is the edit coordinate. edit_file rereads the file, locates the line by ID, and verifies the supplied content exactly. Copy the complete anchored line verbatim. Never retype it or combine an ID from one line with content from another. Given Apple${getDelimiter()}first and Banana${getDelimiter()}second, Apple${getDelimiter()}second is invalid.

EDIT TYPES:
1. replace: Replaces the inclusive range from anchor through end_anchor. For one line, use the same complete anchored line for both endpoints.
2. insert_after: Inserts text immediately after the complete anchored line in anchor. end_anchor is not used.
3. insert_before: Inserts text immediately before the complete anchored line in anchor. end_anchor is not used.

RANGE RULES:
1. Use the smallest range that fully contains the intended edit.
2. For multi-line syntax, use the exact complete first and last lines, including the construct's closing syntax but no unrelated surrounding lines.
3. Replacement text is ordinary source text and must not contain anchors.
For a named block, confirm both the start and the intended closing line belong to that same block. If search context ends before the closing line, read the missing range before choosing an insertion or deletion anchor.
4. A trailing newline terminates the last supplied line without inserting a blank line before the next existing line. Use two trailing newlines to insert one blank line there. At end of file, a trailing newline is retained.
When removing a block, preserve existing blank separators exactly; include only the block's start through its closing line unless explicitly asked to remove surrounding blank lines.
5. In a file ending with a newline, the final empty anchored line represents EOF. insert_after on that line appends without adding a blank line; start text with a newline to add one.
6. If an anchor fails, reread the smallest relevant range with include_anchors: true and copy its current anchored lines. Do not widen the range as a workaround.

BATCHING RULES:
Batch all non-overlapping edits into one call. Edits must not overlap; multiple files may be edited in the same call.`,
	parameters: [
		{
			name: "files",
			type: "array",
			required: true,
			instruction: "An array of file objects to edit.",
			items: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "The path of the file to edit (relative to the current working directory).",
					},
					edits: {
						type: "array",
						description: "An array of edit objects to apply to the file.",
						items: {
							type: "object",
							properties: {
								edit_type: {
									type: "string",
									enum: ["replace", "insert_after", "insert_before"],
									description: "Required operation. Use replace, insert_after, or insert_before.",
								},
								anchor: {
									type: "string",
									description:
										`Required complete ANCHOR${getDelimiter()}CONTENT source line copied verbatim from current anchored output. Identifies the start of a replace range or the insertion point. Must contain one line only.`,
									pattern: getAnchoredLinePattern(),
								},
								end_anchor: {
									type: "string",
									description:
										`Semantically required only for replace: the complete ANCHOR${getDelimiter()}CONTENT line at the inclusive end of the range. Use the same value as anchor for one line. Omit for insertions; strict providers may send null, which is normalized to omission before execution.`,
									pattern: getAnchoredLinePattern(),
								},
								text: {
									type: "string",
									description:
										"Required ordinary source text. Use \\n for new lines and \\\\n for a literal '\\n'. Do not include line anchors.",
								},
							},
							required: ["edit_type", "anchor", "text"],
						},
					},
				},
				required: ["path", "edits"],
			},
		},
	],
}

export class EditFileTool implements IDiracTool<EditFileArgs> {
	private executor = new EditExecutor()
	private resultsFormatter = new EditFormatter(this.executor)
	private fileFormatter = new EditFileFormatter()
	private validator = new EditFileValidator()
	private batchPreparer = new EditFileBatchPreparer(this.executor, this.fileFormatter)
	private approvalFlow = new EditFileApprovalFlow()
	private applier = new EditFileApplier(this.resultsFormatter)

	spec(): DiracToolSpec {
		return edit_file_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: EditFileArgs, env: IToolEnvironment): Promise<any> {
		const files = this.validator.validateFiles(args, env)
		if (typeof files === "string") return files

		const cards: Record<string, any> = {}
		let writesApplied = false

		try {
			await env.context.ensureAnchorState()

			const { preparedBatches, results, totalRequestedEdits, totalResolvedEdits, totalFailedEdits } =
				await this.batchPreparer.prepare(files, env, cards)

			if (preparedBatches.length === 0) {
				env.telemetry.captureCustomMetadata({
					filesCount: files.length,
					requestedEdits: totalRequestedEdits,
					appliedEdits: 0,
					failedEdits: totalFailedEdits,
					outcome: totalFailedEdits > 0 ? "failure" : "success",
				})
				const combined = ToolResponseCombiner.combine(results)
				return totalFailedEdits > 0 && typeof combined === "string" ? formatResponse.toolError(combined) : combined
			}

			const { approved, userEdits, feedback } = await this.approvalFlow.handle(env, preparedBatches, cards)
			if (!approved) return feedback || formatResponse.toolDenied()

			env.config.callbacks.assertMutationAuthorized(DiracDefaultTool.EDIT_FILE)
			const appliedResults = await this.applier.applyAndSave(env, preparedBatches, cards, userEdits)
			writesApplied = true
			const finalResults = await this.applier.finalizeResults(env, preparedBatches, appliedResults)
			results.push(...finalResults)

			const outcome = totalFailedEdits > 0 ? "partial" : "success"
			if (outcome === "partial") {
				results.unshift(
					formatResponse.toolResult(
						`Partial success: ${totalResolvedEdits} of ${totalRequestedEdits} edits were applied; ${totalFailedEdits} failed. Do not retry the ${totalResolvedEdits} applied edits. Retry only the indexed failed edits below.`,
					),
				)
			}

			env.telemetry.captureCustomMetadata({
				filesCount: files.length,
				requestedEdits: totalRequestedEdits,
				appliedEdits: totalResolvedEdits,
				failedEdits: totalFailedEdits,
				outcome,
			})
			await env.editor.hideReview()

			return ToolResponseCombiner.combine(results)
		} catch (error) {
			// Text typed on the waiting card: the coordinator skips the cards and forwards the text.
			if (error instanceof ToolSkippedByUserMessage) {
				// A failing cleanup must not replace the skip, or the typed text is lost.
				await env.editor.hideReview().catch(() => {})
				throw error
			}
			const executionError = toError(error)
			const cleanupFailures: string[] = []

			if (!writesApplied) {
				for (const card of Object.values(cards)) {
					try {
						await card.update({
							status: CardStatus.ERROR,
							body: `✕ Error: ${executionError.message}`,
						})
					} catch (presentationError) {
						cleanupFailures.push(`card ${card.id} update failed: ${toError(presentationError).message}`)
					}
					try {
						await card.finalize(CardStatus.ERROR)
					} catch (presentationError) {
						cleanupFailures.push(`card ${card.id} finalization failed: ${toError(presentationError).message}`)
					}
				}
			}

			try {
				await env.editor.hideReview()
			} catch (presentationError) {
				cleanupFailures.push(`review cleanup failed: ${toError(presentationError).message}`)
			}

			const cleanupWarning = cleanupFailures.length > 0
				? `\n\nObservability cleanup failed: ${cleanupFailures.join("; ")}`
				: ""
			if (writesApplied) {
				throw new Error(`Edits were saved, but post-save processing failed: ${executionError.message}${cleanupWarning}`)
			}
			throw new Error(`Edit failed: ${executionError.message}${cleanupWarning}`)
		}
	}
}
