import { formatResponse } from "@/core/prompts/responses"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { DiagnosticFormatter } from "../../utils/DiagnosticFormatter"

export interface Replacement {
    path: string
    symbol: string
    text: string
    type?: string
}

export interface ReplaceSymbolArgs {
    replacements?: Replacement[]
    // Legacy single replacement support
    path?: string
    symbol?: string
    text?: string
    type?: string
}

export const replace_symbol_spec: DiracToolSpec = {
    id: DiracDefaultTool.REPLACE_SYMBOL,
    name: "replace_symbol",
    description:
        "Replaces one or more symbols (functions, methods, or classes) in one or more files with new code. This is more robust and token-efficient than edit_file because it targets specific AST nodes directly. IMPORTANT: You MUST provide the complete and correct replacement for each symbol, including all its associated JSDoc, comments, decorators, and export keywords. The tool will replace the entire original range of the symbol and its metadata with your provided text.",
    parameters: [
        {
            name: "replacements",
            required: false,
            type: "array",
            items: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    symbol: { type: "string" },
                    text: { type: "string" },
                    type: { type: "string" },
                },
                required: ["path", "symbol", "text"],
            },
            instruction: "An array of replacement objects.",
        },
        {
            name: "path",
            required: false,
            type: "string",
            instruction: "Relative path to the source file (legacy single replacement).",
        },
        {
            name: "symbol",
            required: false,
            type: "string",
            instruction: "The dot-separated path to the symbol to replace (legacy single replacement).",
        },
        {
            name: "text",
            required: false,
            type: "string",
            instruction: "The complete new code for the symbol (legacy single replacement).",
        },
        {
            name: "type",
            required: false,
            type: "string",
            instruction: "Optional type of the symbol (legacy single replacement).",
        },
    ],
}

export class ReplaceSymbolTool implements IDiracTool<ReplaceSymbolArgs> {
    spec(): DiracToolSpec {
        return replace_symbol_spec
    }

    supportedSurfaces(): SurfaceType[] {
        return ["all"]
    }

    async processCall(args: ReplaceSymbolArgs, env: IToolEnvironment): Promise<any> {
        const replacements = this.getReplacements(args)

        if (replacements.length === 0) {
            return this.handleMissingParameters(env)
        }

        const isSubagent = env.config.isSubagentExecution
        const cards = new Map<string, any>()

        try {
            const fileBatches = await this.prepareFileBatches(replacements, env)

            if (!isSubagent) {
                for (const [absolutePath, batch] of fileBatches) {
                    const firstSymbol = batch.replacements[0].symbol
                    const otherCount = batch.replacements.length - 1
                    const card = await env.ui.createCard({
                        header: `Replacing ${firstSymbol}${otherCount > 0 ? ` (+${otherCount} more)` : ""} in ${batch.displayPath}`,
                        icon: DiracIcon.SYMBOL_REPLACE,
                        status: CardStatus.RUNNING,
                        collapsed: true,
                    })
                    cards.set(absolutePath, card)
                }
            }

            env.telemetry.captureCustomMetadata({
                replacementsCount: replacements.length,
                filesCount: fileBatches.size,
            })

            const { filesToReview, pendingChanges } = await this.preparePendingChanges(fileBatches, env)

            const shouldAutoApprove = await this.checkAutoApproval(env, fileBatches)
            let approved = false
            let reason: string | undefined

            if (shouldAutoApprove) {
                approved = true
            } else {
                await env.editor.showReview(filesToReview)
                const symbolNames = Array.from(new Set(replacements.map((r) => r.symbol)))
                const symbolSummary = symbolNames.length > 2
                    ? `${symbolNames.slice(0, 2).join(", ")} and ${symbolNames.length - 2} more`
                    : symbolNames.join(" and ")

                const changeSummary = replacements
                    .map((r) => `- \`${r.symbol}\` → new text in ${r.path}`)
                    .join("\n")

                const card = await env.ui.createCard({
                    header: `Replace ${replacements.length} occurrence(s) of ${symbolSummary} in ${fileBatches.size} file(s)?`,
                    icon: DiracIcon.SYMBOL_REPLACE,
                    status: CardStatus.WAITING_FOR_INPUT,
                    requireApproval: true,
                    collapsed: false,
                    renderType: "markdown",
                    body: changeSummary,
                })

                const result = await card.waitForInteraction()
                if (result.action === DiracAskResponse.MESSAGE) {
                    if (result.text) {
                        await env.ui.upsertText(result.text, false, "user")
                    }
                    await card.finalize(CardStatus.SKIPPED)
                    for (const [, fileCard] of cards) {
                        await fileCard.update({ body: `↩ Skipped — user sent a message instead` })
                        await fileCard.finalize(CardStatus.SKIPPED)
                    }
                    await env.editor.hideReview()
                    return formatResponse.toolDeniedWithFeedback(result.text || "")
                }
                approved = result.action === DiracAskResponse.APPROVE
                reason = result.value
                await card.finalize(approved ? CardStatus.SUCCESS : CardStatus.CANCELLED)
            }

            if (!approved) {
                return this.handleUserDenial(reason, Array.from(cards.values()), env)
            }

            const results = await this.applyChanges(pendingChanges, fileBatches, env)

            await env.editor.hideReview()
            for (const [absolutePath, card] of cards) {
                const batch = fileBatches.get(absolutePath)!
                const firstSymbol = batch.replacements[0].symbol
                const otherCount = batch.replacements.length - 1
                const bodyLines = batch.replacements.map((r) => `✓ ${r.symbol}`)
                await card.update({
                    header: `Replaced ${firstSymbol}${otherCount > 0 ? ` (+${otherCount} more)` : ""} in ${batch.displayPath}`,
                    body: bodyLines.join("\n"),
                })
                await card.finalize(CardStatus.SUCCESS)
            }
            env.orchestration.setTaskState("consecutiveMistakeCount", 0)
            return results.join("\n\n")
        } catch (error: any) {
            return this.handleError(error, Array.from(cards.values()), env)
        }
    }

    private getReplacements(args: ReplaceSymbolArgs): Replacement[] {
        const replacements: Replacement[] = args.replacements || []
        if (args.path && args.symbol && args.text) {
            replacements.push({
                path: args.path,
                symbol: args.symbol,
                text: args.text,
                type: args.type,
            })
        }
        return replacements
    }

    private async handleMissingParameters(env: IToolEnvironment): Promise<string> {
        const mistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount") + 1
        env.orchestration.setTaskState("consecutiveMistakeCount", mistakeCount)
        const errorMsg = formatResponse.missingToolParameterError("replacements")
        await env.ui.upsertText(errorMsg)
        return errorMsg
    }

    private async prepareFileBatches(
        replacements: Replacement[],
        env: IToolEnvironment,
    ): Promise<Map<string, { absolutePath: string; displayPath: string; replacements: Replacement[] }>> {
        const fileBatches = new Map<string, { absolutePath: string; displayPath: string; replacements: Replacement[] }>()
        for (const r of replacements) {
            const { absolutePath, displayPath } = await env.workspace.resolvePath(r.path)
            if (!fileBatches.has(absolutePath)) {
                fileBatches.set(absolutePath, { absolutePath, displayPath, replacements: [] })
            }
            fileBatches.get(absolutePath)!.replacements.push(r)
        }
        return fileBatches
    }

    private async preparePendingChanges(
        fileBatches: Map<string, { absolutePath: string; displayPath: string; replacements: Replacement[] }>,
        env: IToolEnvironment,
    ): Promise<{
        filesToReview: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[]
        pendingChanges: Map<string, string>
    }> {
        const filesToReview: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[] = []
        const pendingChanges = new Map<string, string>()

        for (const [absolutePath, batch] of fileBatches) {
            let content = await env.workspace.readFile(absolutePath)
            const rangesWithText: { startIndex: number; endIndex: number; text: string }[] = []

            for (const r of batch.replacements) {
                const range = await env.symbol.getSymbolRange(absolutePath, r.symbol, r.type)
                if (!range) {
                    throw new Error(`Symbol '${r.symbol}' not found in ${batch.displayPath}.`)
                }
                rangesWithText.push({ startIndex: range.startIndex, endIndex: range.endIndex, text: r.text })
            }

            rangesWithText.sort((a, b) => b.startIndex - a.startIndex)

            for (const r of rangesWithText) {
                content = content.slice(0, r.startIndex) + r.text + content.slice(r.endIndex)
            }

            pendingChanges.set(absolutePath, content)
            filesToReview.push({ absolutePath, displayPath: batch.displayPath, content, originalContent: content })
        }
        return { filesToReview, pendingChanges }
    }

    private async handleUserDenial(reason: string | undefined, cards: any[], env: IToolEnvironment): Promise<string> {
        await env.editor.hideReview()
        for (const card of cards) {
            await card.update({
                status: CardStatus.CANCELLED,
                body: `✕ Replacement cancelled by user.${reason ? ` Reason: ${reason}` : ""}`,
            })
        }
        return reason ? formatResponse.toolDeniedWithFeedback(reason) : formatResponse.toolDenied()
    }
    private async checkAutoApproval(env: IToolEnvironment, fileBatches: Map<string, any>): Promise<boolean> {
        if (env.config.isSubagentExecution) return true
        for (const absPath of fileBatches.keys()) {
            const { displayPath } = await env.workspace.resolvePath(absPath)
            const allowed = await env.config.callbacks.shouldAutoApproveToolWithPath(DiracDefaultTool.EDIT_FILE, displayPath)
            if (!allowed) return false
        }
        return true
    }



    private async applyChanges(
        pendingChanges: Map<string, string>,
        fileBatches: Map<string, { absolutePath: string; displayPath: string; replacements: Replacement[] }>,
        env: IToolEnvironment,
    ): Promise<string[]> {
        const results: string[] = []
        for (const [absolutePath, content] of pendingChanges) {
            const batch = fileBatches.get(absolutePath)!
            const saveResult = await env.editor.applyAndSaveSilently(absolutePath, content)

            await env.diagnostics.prepare([absolutePath])
            const diagnostics = await env.diagnostics.getRaw([absolutePath])
            const fileDiagnostics = diagnostics.find(
                (d) => d.filePath === absolutePath || absolutePath.endsWith(d.filePath),
            )

            const symbolList = batch.replacements.map((r) => `'${r.symbol}'`).join(", ")
            let resultMsg = `Successfully replaced symbols ${symbolList} in ${batch.displayPath}. Any existing hash anchors for these symbols are now stale.`

            if (saveResult.userEdits) resultMsg += " (User made additional edits)"
            if (saveResult.autoFormatting) resultMsg += " (Auto-formatting applied)"

            if (fileDiagnostics && fileDiagnostics.diagnostics && fileDiagnostics.diagnostics.length > 0) {
                const errors = fileDiagnostics.diagnostics.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)
                if (errors.length > 0) {
                    resultMsg += `\nWarning: ${errors.length} error(s) detected after replacement:\n`
                    resultMsg += DiagnosticFormatter.formatDetailed(batch.displayPath, absolutePath, diagnostics, content)
                }
            }
            results.push(resultMsg)
        }
        return results
    }

    private async handleError(error: any, cards: any[], env: IToolEnvironment): Promise<string> {
        await env.editor.hideReview()
        const mistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount") + 1
        env.orchestration.setTaskState("consecutiveMistakeCount", mistakeCount)
        for (const card of cards) {
            await card.update({ body: `✕ Error: ${error.message}` })
            await card.finalize(CardStatus.ERROR)
        }
        return formatResponse.toolError(error.message)
    }
}
