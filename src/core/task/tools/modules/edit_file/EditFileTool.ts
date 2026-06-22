import { formatResponse } from "@core/formatResponse"
import { getDelimiter } from "@utils/line-hashing"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
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
Read the files of extract function first to get current anchors. Each file contains an array of edits.

EDIT TYPES:
1. replace (default): Replaces an inclusive range of lines from anchor to end_anchor.
2. insert_after: Inserts the provided text immediately after the line specified by anchor. end_anchor is not used.
3. insert_before: Inserts the provided text immediately before the line specified by anchor. end_anchor is not used.

ANCHOR RULES:
1. Anchors are a single opaque word (e.g., "AppleBanana") and basically hashes that carry no meaning, followed by ${getDelimiter()} which is followed by the actual line content.
2. For 'replace', anchors are inclusive, meaning what you specify as anchor and end_anchor, the lines belonging to both and everything in between will be overwritten.
3. Anchors are file scoped. "Apple${getDelimiter()}" in one file is different from "Apple${getDelimiter()}" in another file.  

When replacing multi-line statements, function calls, or dictionaries, you MUST ensure your end_anchor points to precisely the line where the construct ends (e.g. a closing bracket or end of function). Do not leave orphaned closing syntax on the following lines NOR do miss the closing syntax. 

Tip: if you are stuck updating a single line, try to change it to 'replace' call with start line is few lines before the the target line and end line is a few lines after.

BATCHING RULES:
You MUST batch all non-overlapping edits into a single tool call. As long as the edits do not overlap, our backend tooling guarantees safety. Multiple files can be edited in a single call also.`,
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
									description: "The type of edit to perform. Defaults to 'replace'.",
								},
								anchor: {
									type: "string",
									description:
										"Anchor for the start of the edit or the insertion point. Must contain a single line only, no newline char.",
									pattern: `^[A-Za-z]+${getDelimiter()}[^\\r\\n]*$`,
								},
								end_anchor: {
									type: "string",
									description:
										"Anchor for the end of the edit (required for 'replace'). Must contain a single line only, no newline char.",
									pattern: `^[A-Za-z]+${getDelimiter()}[^\\r\\n]*$`,
								},
								text: {
									type: "string",
									description:
										"The new text content for the edit. use \\n for new lines. \\\\n if you want literal '\\n'.",
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
	private batchPreparer = new EditFileBatchPreparer(this.executor, this.fileFormatter, this.resultsFormatter)
	private approvalFlow = new EditFileApprovalFlow()
	private applier = new EditFileApplier(this.resultsFormatter)

	spec(): DiracToolSpec {
		return edit_file_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: EditFileArgs, env: IToolEnvironment): Promise<any> {
		// 1. Validate and normalize parameters
		const files = this.validator.validateFiles(args, env)
		if (typeof files === "string") return files

		// 2. Resolve and prepare batches (diracignore, anchors, in-memory apply)
		const { preparedBatches, results, totalRequestedEdits, cards } = await this.batchPreparer.prepare(files, env)
		if (preparedBatches.length === 0) return ToolResponseCombiner.combine(results)

		// 3. Handle approval flow
		const { approved, userEdits, feedback } = await this.approvalFlow.handle(env, preparedBatches, cards)
		if (!approved) return feedback || formatResponse.toolDenied()

		// 4. Apply and save to disk
		const appliedResults = await this.applier.applyAndSave(env, preparedBatches, cards, userEdits)

		// 5. Diagnostics and final results
		const finalResults = await this.applier.finalizeResults(env, preparedBatches, appliedResults)
		results.push(...finalResults)

		// 6. Telemetry
		env.telemetry.captureCustomMetadata({ filesCount: files.length, editsCount: totalRequestedEdits })
		await env.editor.hideReview()

		return ToolResponseCombiner.combine(results)
	}
}
