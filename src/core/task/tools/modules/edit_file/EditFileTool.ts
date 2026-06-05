import { IDiracTool } from "../../interfaces/IDiracTool"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { formatResponse } from "@core/prompts/responses"
import { CardStatus } from "@/shared/ExtensionMessage"
import { EditExecutor } from "./utils/EditExecutor"
import { EditFormatter } from "./utils/EditFormatter"
import { FileEdit, PreparedFileBatch, PreparedEdits } from "./types"
import { ToolResponse } from "../../../index"
import { ToolResponseCombiner } from "../../utils/ToolResponseCombiner"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import * as diff from "diff"
import { getDelimiter, stripHashes } from "@utils/line-hashing"

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
                                    description: "The new text content for the edit. use \\n for new lines. \\\\n if you want literal '\\n'.",
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
    private formatter = new EditFormatter(this.executor)

    spec(): DiracToolSpec {
        return edit_file_spec
    }

    supportedSurfaces(): SurfaceType[] {
        return ["all"]
    }

    async processCall(args: EditFileArgs, env: IToolEnvironment): Promise<any> {
        let { files } = args
        if (typeof files === "string") {
            try {
                files = JSON.parse(files)
            } catch (e) { }
        }

        if (!Array.isArray(files)) {
            env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
            return "The 'files' parameter must be a valid array of objects."
        }

        // 1. Parse stringified edits inside each file
        for (const file of files) {
            if (typeof file.edits === "string") {
                try {
                    file.edits = JSON.parse(file.edits)
                } catch (e) {
                    env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
                    return "The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON."
                }
            }
            if (!Array.isArray(file.edits)) {
                env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
                return "The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON."
            }
        }

        // 2. Resolve and Prepare
        const { preparedBatches, results, totalRequestedEdits, cards, hasError } = await this.resolveAndPrepareBatches(files, env)

        // Do NOT increment mistake count for batch preparation errors.
        // Errors like diracignore denials or edit application failures are
        // valid outcomes — the coordinator will handle thrown exceptions.

        if (preparedBatches.length === 0) {
            return ToolResponseCombiner.combine(results)
        }

        // 2. Handle Approval Flow
        const { approved, userEdits, feedback } = await this.handleApprovalFlow(env, preparedBatches, cards)

        if (!approved) {
            return feedback || formatResponse.toolDenied()
        }

        // 3. Apply and Save
        const appliedResults = await this.applyAndSaveBatches(env, preparedBatches, cards, userEdits)

        // 4. Diagnostics and Final Results
        const finalResults = await this.finalizeResults(env, preparedBatches, appliedResults)
        results.push(...finalResults)

        // 5. Telemetry
        env.telemetry.captureCustomMetadata({
            filesCount: files.length,
            editsCount: totalRequestedEdits,
        })

        await env.editor.hideReview()

        return ToolResponseCombiner.combine(results)
    }

    private async resolveAndPrepareBatches(files: FileEdit[], env: IToolEnvironment) {
        const preparedBatches: PreparedFileBatch[] = []
        let hasError = false
        const cards: Record<string, any> = {}
        const results: ToolResponse[] = []
        let totalRequestedEdits = 0

        for (const file of files) {
            const { absolutePath, displayPath } = await env.workspace.resolvePath(file.path)

            // Check diracignore
            if (!env.config.services.diracIgnoreController.validateAccess(file.path)) {
                hasError = true
                results.push(formatResponse.diracIgnoreError(file.path))
                continue
            }


            const prepared = await this.prepareEdits(absolutePath, displayPath, file.edits, env)
            if ("error" in prepared) {
                if (cards[absolutePath]) {
                    await cards[absolutePath].update({ status: CardStatus.ERROR, body: `✕ Error: ${prepared.error}` })
                }
                hasError = true
                results.push(prepared.error)
                continue
            }

            // Apply edits in memory
            const { finalLines, appliedEdits } = this.executor.applyEdits(prepared.lines, prepared.resolvedEdits)

            // Create a card for each file with stats
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

            // Generate diff for the card
            prepared.diff = this.generateDiff(displayPath, prepared.lines, finalLines)

            if (cards[absolutePath]) {
                await cards[absolutePath].update({ body: stripHashes(prepared.diff) })
            }

            preparedBatches.push({ absolutePath, displayPath, blocks: [], prepared })
            totalRequestedEdits += prepared.resolvedEdits.length
        }

        return { preparedBatches, results, totalRequestedEdits, cards, hasError }
    }

    private async prepareEdits(
        absolutePath: string,
        displayPath: string,
        edits: any[],
        env: IToolEnvironment
    ): Promise<PreparedEdits | { error: any }> {
        try {
            await env.workspace.saveOpenDocumentIfDirty({ filePath: absolutePath })
            const content = await env.workspace.readFile(absolutePath)
            const lines = content.split(/\r?\n/)
            const lineHashes = AnchorStateManager.reconcile(absolutePath, lines, env.config.ulid)

            const { resolvedEdits, failedEdits } = this.executor.resolveEdits(
                [{ params: { edits } } as any],
                lines,
                lineHashes
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

    private generateDiff(displayPath: string, originalLines: string[], finalLines: string[]): string {
        return diff.createPatch(displayPath, originalLines.join("\n"), finalLines.join("\n"))
    }

    private async checkAutoApproval(env: IToolEnvironment, batches: PreparedFileBatch[]): Promise<boolean> {
        if (env.config.isSubagentExecution) return true
        if (env.config.autoApprover.isUnrestrictedAutoApprove()) return true
        for (const batch of batches) {
            const allowed = await env.config.callbacks.shouldAutoApproveToolWithPath(
                DiracDefaultTool.EDIT_FILE,
                batch.displayPath,
            )
            if (!allowed) return false
        }
        return true
    }

    private async handleApprovalFlow(
        env: IToolEnvironment,
        preparedBatches: PreparedFileBatch[],
        cards: Record<string, any>
    ): Promise<{ approved: boolean; userEdits?: Record<string, string>; feedback?: string }> {
        const shouldAutoApprove = await this.checkAutoApproval(env, preparedBatches)

        if (shouldAutoApprove) {
            return { approved: true }
        }

        // Manual approval path - show review first
        await env.editor.showReview(
            preparedBatches.map((b) => ({
                absolutePath: b.absolutePath,
                displayPath: b.displayPath,
                content: b.prepared!.finalContent,
                originalContent: b.prepared!.content,
            }))
        )
        await env.editor.scrollToFirstDiff()

        while (true) {
            const totalRequestedEdits = preparedBatches.reduce((acc, b) => acc + b.prepared!.resolvedEdits.length, 0)
            const fileSummary =
                preparedBatches.length === 1
                    ? `file ${preparedBatches[0].displayPath}`
                    : `${preparedBatches.length} files`
            const permissionMessage = `Apply ${totalRequestedEdits} edit(s) to ${fileSummary}?`

            const result = await env.interaction.askPermission(permissionMessage)
            const isRejection = result.action === DiracAskResponse.REJECT
            await result.card.finalize(isRejection ? CardStatus.CANCELLED : CardStatus.SUCCESS)

            if (result.action === DiracAskResponse.EDIT || result.action === DiracAskResponse.VIEW) {
                await env.editor.showReview(
                    preparedBatches.map((b) => ({
                        absolutePath: b.absolutePath,
                        displayPath: b.displayPath,
                        content: b.prepared!.finalContent,
                        originalContent: b.prepared!.content,
                    }))
                )
                await env.editor.scrollToFirstDiff()
                continue
            }

            if (result.action === DiracAskResponse.UNDO) {
                await env.editor.undoUserEdits()
                continue
            }

            if (result.action === DiracAskResponse.MESSAGE) {
                if (result.text) {
                    await env.ui.upsertText(result.text, false, "user")
                }
                await result.card.finalize(CardStatus.SKIPPED)
                for (const batch of preparedBatches) {
                    if (cards[batch.absolutePath]) {
                        await cards[batch.absolutePath].update({
                            body: `- [ ] Skipped — user sent a message instead`,
                        })
                        await cards[batch.absolutePath].finalize(CardStatus.SKIPPED)
                    }
                }
                await env.editor.hideReview()
                return { approved: false, feedback: formatResponse.toolDeniedWithFeedback(result.text || result.value || "") }
            }

            if (!result.approved) {
                for (const batch of preparedBatches) {
                    if (cards[batch.absolutePath]) {
                        await cards[batch.absolutePath].finalize(CardStatus.CANCELLED);
                        await cards[batch.absolutePath].update({
                            body: `- [ ] User denied permission`,
                        })
                    }
                }
                await env.editor.hideReview()
                return { approved: false }
            }

            return { approved: true, userEdits: result.userEdits }
        }
    }

    private async applyAndSaveBatches(
        env: IToolEnvironment,
        preparedBatches: PreparedFileBatch[],
        cards: Record<string, any>,
        userEdits?: Record<string, string>
    ): Promise<Map<string, any>> {
        const appliedResults = new Map<string, any>()

        // Update all cards to RUNNING state
        await Promise.all(
            preparedBatches.map(async (batch) => {
                const card = cards[batch.absolutePath]
                if (card) {
                    await card.update({ status: CardStatus.RUNNING, body: "Applying edits..." })
                }
            })
        )

        // Prepare files for batch application
        const filesToApply = preparedBatches.map((batch) => {
            let content = batch.prepared!.finalContent
            if (userEdits && userEdits[batch.displayPath] !== undefined) {
                content = userEdits[batch.displayPath]
            }
            return { path: batch.absolutePath, content }
        })

        // Apply all edits in a single transaction
        const batchResults = await env.editor.applyAndSaveBatchSilently(filesToApply)

        // Format files after saving
        for (const batch of preparedBatches) {
            try {
                await env.editor.format(batch.absolutePath)
            } catch {
                // Formatting is best-effort — continue if it fails
            }
        }

        // Process results and update cards
        await Promise.all(
            preparedBatches.map(async (batch) => {
                const saveResult = batchResults.get(batch.absolutePath)
                if (!saveResult) return

                // Re-read content after formatting
                let finalContent: string
                try {
                    finalContent = await env.workspace.readFile(batch.absolutePath)
                } catch {
                    finalContent = saveResult.content || batch.prepared!.finalContent
                }
                const finalLines = finalContent.split(/\r?\n/)

                appliedResults.set(batch.absolutePath, {
                    saveResult,
                    finalContent,
                    finalLines,
                    newLineHashes: AnchorStateManager.reconcile(batch.absolutePath, finalLines, env.config.ulid),
                })

                const card = cards[batch.absolutePath]
                if (card) {
                    await card.update({
                        header: `Edited ${batch.displayPath}`,
                        status: CardStatus.SUCCESS,
                        body: batch.prepared!.diff,
                        renderType: "diff",
                    })
                }
            })
        )

        return appliedResults
    }

    private async finalizeResults(
        env: IToolEnvironment,
        preparedBatches: PreparedFileBatch[],
        appliedResults: Map<string, any>
    ): Promise<ToolResponse[]> {
        const results: ToolResponse[] = []
        await env.diagnostics.prepare(preparedBatches.map((b) => b.absolutePath))
        const rawDiagnostics = await env.diagnostics.getRaw(preparedBatches.map((b) => b.absolutePath))

        for (const batch of preparedBatches) {
            const applied = appliedResults.get(batch.absolutePath)
            const fileDiagnostics = rawDiagnostics.find((d) => d.filePath === batch.absolutePath)?.diagnostics || []

            const diagnosticsResult = {
                newProblemsMessage: fileDiagnostics.length > 0 ? `Found ${fileDiagnostics.length} problems` : "",
                fixedCount: 0,
            }

            const result = this.formatter.createResultsResponse(
                batch.prepared!,
                applied.finalLines,
                applied.newLineHashes,
                diagnosticsResult,
                "full",
                applied.saveResult?.autoFormattingEdits,
                applied.saveResult?.userEdits,
                false
            )
            results.push(result)
        }
        return results
    }

    private buildEditMessage(batches: PreparedFileBatch[]): any {
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
                edits:
                    b.prepared?.appliedEdits.map((ae) => ({
                        additions: ae.linesAdded,
                        deletions: ae.linesDeleted,
                    })) || [],
                diff: b.prepared?.diff,
                finalContent: b.prepared?.finalContent,
            })),
            operationIsLocatedInWorkspace: true, // Simplified
            hint: "Review and edit in the editor before approving.",
        }
    }
}
