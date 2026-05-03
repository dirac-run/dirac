import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { isLocatedInWorkspace } from "@utils/path"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getDiagnosticsProviders } from "@/integrations/diagnostics/getDiagnosticsProviders"

import { DiracSayTool } from "@/shared/ExtensionMessage"
import { DiracAskResponse } from "@/shared/WebviewMessage"
import { DiracDefaultTool } from "@/shared/tools"
import { ToolResponse } from "../../../index"
import { showNotificationForApproval } from "../../../utils"
import { ToolValidator } from "../../ToolValidator"
import { TaskConfig } from "../../types/TaskConfig"
import { ToolResultUtils } from "../../utils/ToolResultUtils"
import { EditExecutor } from "./EditExecutor"
import { EditFormatter } from "./EditFormatter"
import { FileEdit, PreparedEdits, PreparedFileBatch } from "./types"

export class BatchProcessor {
    constructor(
        private validator: ToolValidator,
        private executor: EditExecutor,
        private formatter: EditFormatter,
        private useLinterOnlyForSyntax: boolean,
        private diagnosticsTimeoutMs: number,
        private diagnosticsDelayMs: number,
        private diffMode: "full" | "additions-only",
    ) { }

    resolvePath(config: TaskConfig, relPath: string): { absolutePath: string; displayPath: string } {
        const pathResult = resolveWorkspacePath(config, relPath, "EditFileToolHandler.resolvePath")
        return typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult
    }

    groupBlocksByPath(config: TaskConfig): Map<string, PreparedFileBatch> {
        const allBlocks = config.taskState.assistantMessageContent.filter(
            (b: any): b is ToolUse => b.type === "tool_use" && b.name === DiracDefaultTool.EDIT_FILE,
        )

        const groups = new Map<string, PreparedFileBatch>()

        for (const b of allBlocks) {
            const fileEdits: FileEdit[] = []
            
            let files = b.params.files
            let wasStringified = false
            if (typeof files === "string") {
                try {
                    files = JSON.parse(files)
                    b.params.files = files
                    wasStringified = true
                } catch (e) { }
            }

            if (Array.isArray(files)) {
                fileEdits.push(...files)
            }

            for (const fe of fileEdits) {
                let editsWasStringified = false
                if (typeof fe.edits === "string") {
                    try {
                        fe.edits = JSON.parse(fe.edits)
                        editsWasStringified = true
                    } catch (e) { }
                }

                const { absolutePath, displayPath } = this.resolvePath(config, fe.path)
                if (!groups.has(absolutePath)) {
                    groups.set(absolutePath, { absolutePath, displayPath, blocks: [], wasStringified: wasStringified || editsWasStringified })
                } else if (wasStringified || editsWasStringified) {
                    groups.get(absolutePath)!.wasStringified = true
                }

                groups.get(absolutePath)!.blocks.push({
                    ...b,
                    params: { ...b.params, path: fe.path, edits: fe.edits },
                } as any)
            }
        }
        return groups
    }

    async executeMultiFileBatch(
        config: TaskConfig,
        allBatches: Map<string, PreparedFileBatch>,
    ): Promise<Map<string, ToolResponse>> {
        const results = new Map<string, ToolResponse>()
        const preparedBatches: PreparedFileBatch[] = []

        for (const batch of allBatches.values()) {
            const { error, prepared } = await this.validateAndPrepare(config, batch.absolutePath, batch.displayPath, batch.blocks)
            if (error) {
                results.set(batch.absolutePath, error)
            } else if (prepared) {
                // Apply all edits in memory for this batch
                const { finalLines, appliedEdits } = this.executor.applyEdits(prepared.lines, prepared.resolvedEdits)
                prepared.finalLines = finalLines
                prepared.finalContent = finalLines.join("\n")
                prepared.appliedEdits = appliedEdits

                // Generate diff for the summary
                let diff = `*** Update File: ${batch.displayPath}\n\n`
                
                const sortedEdits = [...appliedEdits].sort((a, b) => a.originalStartIdx - b.originalStartIdx)

                for (const applied of sortedEdits) {
                    const editType = applied.edit.edit_type
                    let searchLines: string[] = []
                    let replaceLines: string[] = []

                    const replaceTextLines = applied.edit.text === "" ? [] : applied.edit.text.split("\n")

                    if (editType === "insert_after") {
                        searchLines = [prepared.lines[applied.originalStartIdx]]
                        replaceLines = [prepared.lines[applied.originalStartIdx], ...replaceTextLines]
                    } else if (editType === "insert_before") {
                        searchLines = [prepared.lines[applied.originalStartIdx]]
                        replaceLines = [...replaceTextLines, prepared.lines[applied.originalStartIdx]]
                    } else {
                        searchLines = prepared.lines.slice(applied.originalStartIdx, applied.originalEndIdx + 1)
                        replaceLines = replaceTextLines
                    }

                    const contextBeforeStart = Math.max(0, applied.originalStartIdx - 2)
                    const contextBefore = prepared.lines.slice(contextBeforeStart, applied.originalStartIdx)
                    
                    let afterStartIdx = applied.originalEndIdx + 1
                    if (editType === "insert_after" || editType === "insert_before") {
                        afterStartIdx = applied.originalStartIdx + 1
                    }
                    const contextAfterEnd = Math.min(prepared.lines.length, afterStartIdx + 2)
                    const contextAfter = prepared.lines.slice(afterStartIdx, contextAfterEnd)

                    const searchContent = [...contextBefore, ...searchLines, ...contextAfter].join("\n")
                    const replaceContent = [...contextBefore, ...replaceLines, ...contextAfter].join("\n")

                    const startLineNumber = contextBeforeStart + 1

                    diff += `<<<<<<< SEARCH:${startLineNumber}\n${searchContent}\n=======\n${replaceContent}\n>>>>>>> REPLACE\n\n`
                }
                prepared.diff = diff

                preparedBatches.push({ ...batch, prepared })
            }
        }

        if (preparedBatches.length === 0) {
            return results
        }
        const providers = getDiagnosticsProviders(
            this.useLinterOnlyForSyntax,
            this.diagnosticsTimeoutMs,
            this.diagnosticsDelayMs,
        )

        // 1. Capture pre-save diagnostics for all files once
        const preDiagnostics = (
            await Promise.all(providers.map((p) => p.capturePreSaveState()))
        ).flat()

        const allAutoApproved = await this.checkAutoApproval(config, preparedBatches)

        if (allAutoApproved) {
            // FAST PATH: All files auto-approved, apply them all silently
            const appliedResults = new Map<string, any>()
            let anyFailed = false
            let anySucceeded = false

            for (const batch of preparedBatches) {
                try {
                    const applied = await this.applyAndSave(config, batch, { silent: true })
                    appliedResults.set(batch.absolutePath, applied)
                    anySucceeded = true
                } catch (error) {
                    anyFailed = true
                    const errorMessage = error instanceof Error ? error.message : String(error)
                    results.set(batch.absolutePath, formatResponse.toolError(`Error applying edits to ${batch.displayPath}: ${errorMessage}`))
                } finally {
                    await config.services.diffViewProvider.reset().catch(() => { })
                }
            }

            if (anyFailed) {
                config.taskState.consecutiveMistakeCount++
            } else if (anySucceeded) {
                config.taskState.consecutiveMistakeCount = 0
            }

            // Run diagnostics and format results
            await this.processDiagnosticsAndFormatResults(config, preparedBatches, appliedResults, providers, preDiagnostics, results)
            
            await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
            await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

            const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
            const finalMessage = await this.buildEditMessage(config, successfulBatches)
            await config.callbacks.say("tool", JSON.stringify(finalMessage), undefined, undefined, false)

            return results
        }

        // ITERATIVE PATH: At least one file needs approval
        let forceAutoApproveRemaining = false
        const appliedResults = new Map<string, any>()
        let anyFailed = false
        let anySucceeded = false

        for (const batch of preparedBatches) {
            let shouldAutoApprove = forceAutoApproveRemaining || await this.checkAutoApproval(config, [batch])

            if (!shouldAutoApprove) {
                await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
                await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

                // Show the diff for this specific file
                await config.services.diffViewProvider.showReview([{
                    absolutePath: batch.absolutePath,
                    displayPath: batch.displayPath,
                    content: batch.prepared!.finalContent
                }])

                const intermediateMessage = await this.buildEditMessage(config, [batch])
                await config.callbacks.say("tool", JSON.stringify(intermediateMessage), undefined, undefined, true)

                const approvalResult = await this.requestCombinedApproval(config, [batch])
                const { didApprove, response, text, userEdits } = approvalResult

                if (!didApprove && response !== "messageResponse") {
                    await config.services.diffViewProvider.hideReview()
                }
                
                if (response === "yesButtonClicked" && config.services.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
                    forceAutoApproveRemaining = true
                }

                if (response === "messageResponse") {
                    results.set(batch.absolutePath, formatResponse.toolDeniedWithFeedback(text || ""))
                    continue
                }


                if (!didApprove) {
                    results.set(batch.absolutePath, formatResponse.toolDenied())
                    
                    // Fill remaining files with skipped message
                    const currentIndex = preparedBatches.indexOf(batch)
                    for (let i = currentIndex + 1; i < preparedBatches.length; i++) {
                        const rb = preparedBatches[i]
                        results.set(rb.absolutePath, "Skipped due to rejection of a previous file in the same batch.")
                    }
                    break
                }

                if (userEdits && userEdits[batch.displayPath] !== undefined) {
                    batch.prepared!.finalContent = userEdits[batch.displayPath]
                    batch.prepared!.finalLines = batch.prepared!.finalContent.split(/\r?\n/)
                }

                if (didApprove) {
                    // Don't call hideReview here if we are about to apply and save, 
                    // as it clears the CodeLenses and closes the editor we need.
                    // hideReview() will be called implicitly by reset() in the finally block or after the loop.
                }
            }

            // Apply and save this file
            try {
                const applied = await this.applyAndSave(config, batch, { silent: false })
                appliedResults.set(batch.absolutePath, applied)
                anySucceeded = true
            } catch (error) {
                anyFailed = true
                const errorMessage = error instanceof Error ? error.message : String(error)
                results.set(batch.absolutePath, formatResponse.toolError(`Error applying edits to ${batch.displayPath}: ${errorMessage}`))
            } finally {
                await config.services.diffViewProvider.reset().catch(() => { })
            }
        }

        if (anyFailed) {
            config.taskState.consecutiveMistakeCount++
        } else if (anySucceeded) {
            config.taskState.consecutiveMistakeCount = 0
        }

        // Run diagnostics and format results for all successfully applied files
        await this.processDiagnosticsAndFormatResults(config, preparedBatches, appliedResults, providers, preDiagnostics, results)

        await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
        await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
        const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
        const finalMessage = await this.buildEditMessage(config, successfulBatches)
        await config.callbacks.say("tool", JSON.stringify(finalMessage), undefined, undefined, false)

        return results
    }

    private async processDiagnosticsAndFormatResults(
        config: TaskConfig,
        preparedBatches: PreparedFileBatch[],
        appliedResults: Map<string, any>,
        providers: any[],
        preDiagnostics: any[],
        results: Map<string, ToolResponse>
    ): Promise<void> {
        const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
        if (successfulBatches.length === 0) return

        const diagnosticsData = successfulBatches.map((b) => {
            const applied = appliedResults.get(b.absolutePath)!
            return {
                filePath: b.absolutePath,
                content: applied.finalContent,
                hashes: applied.newLineHashes,
            }
        })

        const providerDiagnostics = await Promise.all(
            providers.map((p) => p.getDiagnosticsFeedbackForFiles(diagnosticsData, preDiagnostics))
        )

        for (let i = 0; i < successfulBatches.length; i++) {
            const batch = successfulBatches[i]
            const applied = appliedResults.get(batch.absolutePath)!
            let finalDiagnosticsResult = { newProblemsMessage: "", fixedCount: 0 }

            for (const resultsOfProvider of providerDiagnostics) {
                const res = resultsOfProvider[i]
                if (res.newProblemsMessage && !finalDiagnosticsResult.newProblemsMessage) {
                    finalDiagnosticsResult.newProblemsMessage = res.newProblemsMessage
                }
                finalDiagnosticsResult.fixedCount += res.fixedCount
            }

            batch.diagnostics = finalDiagnosticsResult

            const result = this.formatter.createResultsResponse(
                batch.prepared!,
                applied.finalLines,
                applied.newLineHashes,
                finalDiagnosticsResult,
                this.diffMode,
                applied.saveResult.autoFormattingEdits,
                applied.saveResult.userEdits,
                batch.wasStringified
            )
            results.set(batch.absolutePath, result)
        }
    }

    async validateAndPrepare(
        config: TaskConfig,
        absolutePath: string,
        displayPath: string,
        blocks: ToolUse[],
    ): Promise<{ error?: ToolResponse; prepared?: PreparedEdits }> {
        for (const block of blocks) {
            if (block.params.path === undefined || block.params.edits === undefined) {
                let files = block.params.files
                if (typeof files === "string") {
                    try { files = JSON.parse(files) } catch (e) { }
                }
                if (!Array.isArray(files)) {
                    config.taskState.consecutiveMistakeCount++
                    return { error: formatResponse.toolError("The 'files' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON.") }
                }
            }

            const edits = block.params.edits
            if (!Array.isArray(edits)) {
                config.taskState.consecutiveMistakeCount++
                return { error: formatResponse.toolError("The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON.") }
            }

            for (const edit of edits) {
                const editType = edit.edit_type
                const hasEndAnchor = !!edit.end_anchor
                const isReplace = editType === "replace" || !editType // default is replace

                if (!editType || !edit.anchor || (isReplace && !hasEndAnchor) || edit.text === undefined) {
                    config.taskState.consecutiveMistakeCount++
                    const missingField = !editType
                        ? "edit_type"
                        : !edit.anchor
                            ? "anchor"
                            : isReplace && !hasEndAnchor
                                ? "end_anchor"
                                : "text"
                    return { error: formatResponse.toolError(`Each edit must contain '${missingField}'.`) }
                }
            }
        }

        const preparedResult = await this.prepareEdits(config, absolutePath, displayPath, blocks)
        if ("error" in preparedResult) {
            return { error: preparedResult.error }
        }

        return { prepared: preparedResult }
    }

    async checkAutoApproval(config: TaskConfig, batches: PreparedFileBatch[]): Promise<boolean> {
        if (config.isSubagentExecution) return true
        for (const batch of batches) {
            const allowed = await config.callbacks.shouldAutoApproveToolWithPath(DiracDefaultTool.EDIT_FILE, batch.displayPath)
            if (!allowed) return false
        }
        return true
    }

    async requestCombinedApproval(config: TaskConfig, batches: PreparedFileBatch[]): Promise<{ didApprove: boolean; response: DiracAskResponse; text?: string; userEdits?: Record<string, string> }> {
        const totalRequestedEdits = batches.reduce(
            (acc, b) =>
                acc + b.blocks.reduce((acc2, b2) => acc2 + (Array.isArray(b2.params.edits) ? b2.params.edits.length : 0), 0),
            0,
        )

        const fileNames = batches.map((b) => path.basename(b.absolutePath)).join(", ")
        const notificationMessage = batches.length === 1 
            ? `Dirac wants to edit ${batches[0].displayPath} with ${totalRequestedEdits} anchored edits`
            : `Dirac wants to edit ${fileNames} with ${totalRequestedEdits} anchored edits`
        showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

        while (true) {
            const completeMessage = await this.buildEditMessage(config, batches)
            await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
            await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

            const result = await ToolResultUtils.askApprovalAndPushFeedback("tool", JSON.stringify(completeMessage), config)
            const { response, userEdits } = result

            if (response === "editButtonClicked") {
                // Re-trigger showReview to ensure editors are open
                await config.services.diffViewProvider.showReview(batches.map(b => ({
                    absolutePath: b.absolutePath,
                    displayPath: b.displayPath,
                    content: b.prepared!.finalContent
                })))
                await config.services.diffViewProvider.scrollToFirstDiff()
                continue
            }

            if (response === "viewButtonClicked") {
                // Re-trigger showReview and scroll to first diff
                await config.services.diffViewProvider.showReview(batches.map(b => ({
                    absolutePath: b.absolutePath,
                    displayPath: b.displayPath,
                    content: b.prepared!.finalContent
                })))
                await config.services.diffViewProvider.scrollToFirstDiff()
                for (const batch of batches) {
                    await config.services.diffViewProvider.scrollToFirstDiff()
                }
                continue
            }

            if (response === "undoButtonClicked") {
                await config.services.diffViewProvider.undoUserEdits()
                continue
            }

            return { didApprove: result.didApprove, response, text: result.text, userEdits }
        }
    }

    async buildEditMessage(config: TaskConfig, batches: PreparedFileBatch[]): Promise<DiracSayTool> {
        const totalRequestedEdits = batches.reduce(
            (acc, b) =>
                acc + b.blocks.reduce((acc2, b2) => acc2 + (Array.isArray(b2.params.edits) ? b2.params.edits.length : 0), 0),
            0,
        )

        const warningCount = batches.reduce((acc, b) => acc + (b.prepared?.failedEdits.length || 0), 0)
        const warning = warningCount > 0 ? `\n\nWarning: ${warningCount} edit(s) failed to resolve and will be skipped.` : ""
        const diffs = batches.map((b) => b.prepared?.diff).join("\n\n")

        const editSummaries = await Promise.all(
            batches.map(async (b) => ({
                path: b.displayPath,
                edits:
                    b.prepared?.appliedEdits.map((ae) => ({
                        additions: ae.linesAdded,
                        deletions: ae.linesDeleted,
                    })) || [],
                diagnostics: b.diagnostics,
                diff: b.prepared?.diff,
                finalContent: b.prepared?.finalContent,
            })),
        )

        const operationIsLocatedInWorkspace =
            batches.length === 1
                ? await isLocatedInWorkspace(batches[0].absolutePath)
                : (await Promise.all(batches.map((b) => isLocatedInWorkspace(b.absolutePath)))).every(Boolean)

        return {
            tool: "editFile",
            path: batches.length === 1 ? batches[0].displayPath : "Multiple files",
            filesCount: batches.length,
            editsCount: totalRequestedEdits,
            diff: diffs + warning,
            editSummaries,
            operationIsLocatedInWorkspace,
            hint: "Review and edit in the editor before approving.",
        }
    }

    async applyAndSave(
        config: TaskConfig,
        batch: PreparedFileBatch,
        options: { silent: boolean },
    ): Promise<{
        saveResult: { finalContent: string; autoFormattingEdits?: string; userEdits?: string }
        finalContent: string
        finalLines: string[]
        newLineHashes: string[]
    }> {
        const { absolutePath, displayPath, prepared } = batch
        if (!prepared) throw new Error("Failed to prepare edits.")

        let { finalContent, finalLines } = prepared

        if (options.silent) {
            const saveResult = await config.services.diffViewProvider.applyAndSaveSilently(absolutePath, finalContent)
            const actualFinalContent = saveResult.finalContent || finalContent

            if (actualFinalContent !== finalContent) {
                finalContent = actualFinalContent
                finalLines = finalContent.split(/\r?\n/)
            }

            config.taskState.consecutiveMistakeCount = 0
            config.taskState.didEditFile = true
            config.services.fileContextTracker.markFileAsEditedByDirac(displayPath)
            await config.services.fileContextTracker.trackFileContext(displayPath, "dirac_edited")

            const newLineHashes = AnchorStateManager.reconcile(absolutePath, finalLines, config.ulid)

            return {
                saveResult: {
                    finalContent: actualFinalContent,
                    autoFormattingEdits: saveResult.autoFormattingEdits,
                    userEdits: saveResult.userEdits,
                },
                finalContent,
                finalLines,
                newLineHashes,
            }
        }


        config.services.diffViewProvider.editType = "modify"
        // Stage the changes in the diff view provider before saving
        await config.services.diffViewProvider.open(absolutePath, { displayPath })
        if (!config.services.diffViewProvider.isEditing) {
            await config.services.diffViewProvider.update(finalContent, true)
        }

        // Wait for the diff view to update before saving to ensure auto-formatting is triggered
        await setTimeoutPromise(200)

        // Save the changes and get the final content (including any auto-formatting)
        // Save the changes and get the final content (including any auto-formatting)
        // We skip diagnostics here because executeMultiFileBatch handles them in parallel for the whole batch
        const saveResult = await this.saveAndTrackChanges(config, absolutePath, displayPath, finalContent, { skipDiagnostics: true })

        // Update finalContent and finalLines if they changed during save (e.g. auto-formatting)
        if (saveResult.finalContent !== finalContent) {
            finalContent = saveResult.finalContent
            finalLines = finalContent.split(/\r?\n/)
        }

        const newLineHashes = AnchorStateManager.reconcile(absolutePath, finalLines, config.ulid)

        return { saveResult, finalContent, finalLines, newLineHashes }
    }

    async prepareEdits(
        config: TaskConfig,
        absolutePath: string,
        displayPath: string,
        blocks: ToolUse[],
    ): Promise<PreparedEdits | { error: ToolResponse }> {
        try {
            await HostProvider.workspace.saveOpenDocumentIfDirty({ filePath: absolutePath })
            const content = await fs.readFile(absolutePath, "utf8")
            const lines = content.split(/\r?\n/)
            const lineHashes = AnchorStateManager.reconcile(absolutePath, lines, config.ulid)

            const { resolvedEdits, failedEdits } = this.executor.resolveEdits(blocks, lines, lineHashes)

            if (resolvedEdits.length === 0) {
                const failureMessages = failedEdits.map((f) => this.executor.formatFailureMessage(f.edit, f.error))
                return { error: formatResponse.toolError(failureMessages.join("\n\n")) }
            }

            return {
                content,
                finalContent: content, // Placeholder
                diff: "", // Placeholder
                resolvedEdits,
                failedEdits,
                appliedEdits: [], // Placeholder
                lines,
                lineHashes,
                finalLines: lines, // Placeholder
                displayPath,
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            return { error: formatResponse.toolError(`Error preparing edits: ${errorMessage}`) }
        }
    }

    async saveAndTrackChanges(
        config: TaskConfig,
        absolutePath: string,
        displayPath: string,
        finalContent: string,
        options?: { skipDiagnostics?: boolean },
    ): Promise<{ finalContent: string; autoFormattingEdits?: string; userEdits?: string }> {
        // Use DiffViewProvider to save changes, which handles auto-formatting and VS Code document synchronization
        const saveResult = await config.services.diffViewProvider.saveChanges(options)
        const actualFinalContent = saveResult.finalContent || finalContent

        config.taskState.consecutiveMistakeCount = 0
        config.taskState.didEditFile = true
        config.services.fileContextTracker.markFileAsEditedByDirac(displayPath)
        await config.services.fileContextTracker.trackFileContext(displayPath, "dirac_edited")

        return {
            finalContent: actualFinalContent,
            autoFormattingEdits: saveResult.autoFormattingEdits,
            userEdits: saveResult.userEdits,
        }
    }
}
