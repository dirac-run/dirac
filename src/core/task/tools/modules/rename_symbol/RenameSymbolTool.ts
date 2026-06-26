import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { formatResponse } from "@core/formatResponse"
import * as path from "path"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { DiagnosticFormatter } from "../../utils/DiagnosticFormatter"

export interface RenameSymbolArgs {
    existing_symbol: string
    new_symbol: string
    paths: string[]
}

export const rename_symbol_spec: DiracToolSpec = {
    id: DiracDefaultTool.RENAME_SYMBOL,
    name: "rename_symbol",
    description:
        "Renames ALL occurrences of a symbol (function, class, method, or variable) inside the specified files or directories. This tool can identify precise symbols using a language's AST and is more accurate than a simple search-and-replace because it understands the language structure. For renaming tasks, strongly prefer this as the first pass.",
    parameters: [
        {
            name: "existing_symbol",
            required: true,
            type: "string",
            instruction: "The exact name of the symbol to be renamed.",
        },
        {
            name: "new_symbol",
            required: true,
            type: "string",
            instruction: "The new name for the symbol.",
        },
        {
            name: "paths",
            required: true,
            type: "array",
            items: { type: "string" },
            instruction: "An array of relative paths to the directories or files to perform the rename in.",
        },
    ],
}

export class RenameSymbolTool implements IDiracTool<RenameSymbolArgs> {
    spec(): DiracToolSpec {
        return rename_symbol_spec
    }

    supportedSurfaces(): SurfaceType[] {
        return ["all"]
    }

    async processCall(args: RenameSymbolArgs, env: IToolEnvironment): Promise<any> {
        const { existing_symbol, new_symbol, paths: relPaths } = args

        this.validateArgs(existing_symbol, new_symbol, relPaths, env)

        const paths = Array.isArray(relPaths) ? relPaths : [relPaths]
        const cards = !env.config.isSubagentExecution ? new Map<string, any>() : undefined

        try {
            const filteredOccurrences = await this.findOccurrences(existing_symbol, paths, env)

            if (filteredOccurrences.length === 0) {
                env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
                if (cards) {
                    for (const fileCard of cards.values()) {
                        await fileCard.update({
                            body: `✕ No occurrences of symbol '${existing_symbol}' found in the specified paths.`,
                        })
                        await fileCard.finalize(CardStatus.SKIPPED)
                    }
                }
                return `No occurrences of symbol '${existing_symbol}' found in the specified paths.`
            }

            const { pendingChanges, filesToReview, fileBatches } = await this.prepareChanges(filteredOccurrences, new_symbol, env)
            if (cards) {
                for (const [absPath, batch] of fileBatches) {
                    const { displayPath } = await env.workspace.resolvePath(absPath)
                    const fileCard = await env.ui.createCard({
                        header: `Renaming '${existing_symbol}' to '${new_symbol}' in ${displayPath}`,
                        icon: DiracIcon.SYMBOL_RENAME,
                        status: CardStatus.RUNNING,
                        collapsed: true,
                    })
                    cards.set(absPath, fileCard)
                }
            }

            if (cards) {
                for (const [absPath, fileCard] of cards) {
                    const batch = fileBatches.get(absPath)!
                    await fileCard.update({
                        header: `Renaming '${existing_symbol}' to '${new_symbol}' (${batch.length} hits) in ${fileCard.header.split(" in ")[1]}`,
                        body: `✓ Found ${batch.length} occurrences. Waiting for approval...`,
                    })
                }
            }

            const shouldAutoApprove = await this.checkAutoApproval(env, fileBatches)
            let approved = false
            let message: string | undefined

            if (shouldAutoApprove) {
                approved = true
                if (cards) {
                    for (const [absPath, fileCard] of cards) {
                        const batch = fileBatches.get(absPath)!
                        await fileCard.update({
                            header: `Renaming '${existing_symbol}' to '${new_symbol}' (${batch.length} hits) in ${fileCard.header.split(" in ")[1]}`,
                            body: `✓ Found ${batch.length} occurrences. Auto-approved.`,
                        })
                    }
                }
            } else {
                if (cards) {
                    for (const [absPath, fileCard] of cards) {
                        const batch = fileBatches.get(absPath)!
                        await fileCard.update({
                            header: `Renaming '${existing_symbol}' to '${new_symbol}' (${batch.length} hits) in ${fileCard.header.split(" in ")[1]}`,
                            body: `✓ Found ${batch.length} occurrences. Waiting for approval...`,
                        })
                    }
                }

                const result = await this.requestApproval(
                    existing_symbol,
                    new_symbol,
                    fileBatches.size,
                    filteredOccurrences.length,
                    filesToReview,
                    cards ? Array.from(cards.values()) : undefined,
                    env,
                )
                approved = result.approved
                message = result.message
            }

            if (!approved) {
                return message ? formatResponse.toolDeniedWithFeedback(message) : formatResponse.toolDenied()
            }

            const results = await this.applyChanges(pendingChanges, filesToReview, env)

            env.orchestration.setTaskState("consecutiveMistakeCount", 0)
            env.telemetry.captureCustomMetadata({
                replacementsCount: filteredOccurrences.length,
                filesCount: fileBatches.size,
            })

            if (cards) {
                for (const [absPath, fileCard] of cards) {
                    const batch = fileBatches.get(absPath)!
                    await fileCard.update({
                        header: `Renamed '${existing_symbol}' to '${new_symbol}' in ${fileCard.header.split(" in ")[1]}`,
                        body: `✓ Successfully renamed ${batch.length} occurrences`,
                    })
                    await fileCard.finalize(CardStatus.SUCCESS)
                }
            }

            return this.formatResult(existing_symbol, new_symbol, filteredOccurrences.length, fileBatches.size, results)
        } catch (error: any) {
            await env.editor.hideReview()
            env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (cards) {
                for (const fileCard of cards.values()) {
                    await fileCard.update({ body: `✕ Error: ${errorMessage}` })
                    await fileCard.finalize(CardStatus.ERROR)
                }
            }
            return formatResponse.toolError(`Error renaming symbol: ${errorMessage}`)
        }
    }

    private validateArgs(existing_symbol: string, new_symbol: string, relPaths: string[], env: IToolEnvironment): void {
        if (!existing_symbol || !new_symbol || !relPaths || (Array.isArray(relPaths) && relPaths.length === 0)) {
            const missingParam = !existing_symbol ? "existing_symbol" : !new_symbol ? "new_symbol" : "paths"
            throw new Error(`Missing required parameter: ${missingParam}`)
        }
    }

    private async findOccurrences(existing_symbol: string, paths: string[], env: IToolEnvironment) {
        const projectRoot = env.config.cwd
        await env.symbol.initializeIndex(projectRoot)

        const occurrences = await env.symbol.getSymbols(existing_symbol)

        const absoluteRequestedPaths = await Promise.all(
            paths.map(async (p) => {
                const { absolutePath } = await env.workspace.resolvePath(p)
                return path.resolve(absolutePath)
            }),
        )

        return occurrences.filter((occ) => {
            const absOccPath = path.resolve(occ.path)
            return absoluteRequestedPaths.some((p) => absOccPath.startsWith(p))
        })
    }

    private async prepareChanges(filteredOccurrences: any[], new_symbol: string, env: IToolEnvironment) {
        const fileBatches = new Map<string, any[]>()
        for (const occ of filteredOccurrences) {
            const absPath = path.resolve(occ.path)
            if (!fileBatches.has(absPath)) {
                fileBatches.set(absPath, [])
            }
            fileBatches.get(absPath)!.push(occ)
        }

        const filesToReview: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[] = []
        const pendingChanges = new Map<string, string>()

        for (const [absPath, batch] of fileBatches) {
            const { displayPath } = await env.workspace.resolvePath(absPath)
            let content = await env.workspace.readFile(absPath)
            const lines = content.split(/\r?\n/)

            batch.sort((a, b) => {
                if (b.startLine !== a.startLine) return b.startLine - a.startLine
                return b.startColumn - a.startColumn
            })

            for (const occ of batch) {
                const line = lines[occ.startLine]
                if (line) {
                    const before = line.slice(0, occ.startColumn)
                    const after = line.slice(occ.endColumn)
                    lines[occ.startLine] = before + new_symbol + after
                }
            }

            const newContent = lines.join("\n")
            pendingChanges.set(absPath, newContent)
            filesToReview.push({ absolutePath: absPath, displayPath, content: newContent, originalContent: content })
        }

        return { pendingChanges, filesToReview, fileBatches }
    }
    private async checkAutoApproval(env: IToolEnvironment, fileBatches: Map<string, any[]>): Promise<boolean> {
        if (env.config.isSubagentExecution) return true
        for (const absPath of fileBatches.keys()) {
            const { displayPath } = await env.workspace.resolvePath(absPath)
            const allowed = await env.config.callbacks.shouldAutoApproveToolWithPath(DiracDefaultTool.EDIT_FILE, displayPath)
            if (!allowed) return false
        }
        return true
    }



    private async requestApproval(
        existing_symbol: string,
        new_symbol: string,
        fileCount: number,
        occurrenceCount: number,
        filesToReview: any[],
        cards: any[] | undefined,
        env: IToolEnvironment,
    ): Promise<{ approved: boolean; message?: string }> {
        await env.editor.showReview(filesToReview)

        const card = await env.ui.createCard({
            header: `Rename symbol '${existing_symbol}' to '${new_symbol}' in ${fileCount} file(s) (${occurrenceCount} occurrences)?`,
            icon: DiracIcon.SYMBOL_REPLACE,
            status: CardStatus.WAITING_FOR_INPUT,
            requireApproval: true,
            collapsed: false,
            renderType: "markdown",
            body: `Renaming \`${existing_symbol}\` → \`${new_symbol}\` in ${fileCount} file(s)`,
        })
        const result = await card.waitForInteraction()
        if (result.action === DiracAskResponse.MESSAGE) {
            if (result.text) {
                await env.ui.upsertText(result.text, false, "user")
            }
            await card.finalize(CardStatus.SKIPPED)
            await env.editor.hideReview()
            if (cards) {
                for (const c of cards) {
                    await c.update({ status: CardStatus.SKIPPED, body: `↩ Skipped — user sent a message instead` })
                }
            }
            return { approved: false, message: result.text || "" }
        }
        const approved = result.action === DiracAskResponse.APPROVE
        const reason = result.value
        await card.finalize(approved ? CardStatus.SUCCESS : CardStatus.CANCELLED)

        if (!approved) {
            await env.editor.hideReview()
            if (cards) {
                for (const c of cards) {
                    await c.update({
                        status: CardStatus.CANCELLED,
                        body: `✕ Rename cancelled by user.${reason ? ` Reason: ${reason}` : ""}`,
                    })
                }
            }
            return { approved: false, message: reason }
        }

        return { approved: true }
    }

    private async applyChanges(pendingChanges: Map<string, string>, filesToReview: any[], env: IToolEnvironment): Promise<string[]> {
        const results: string[] = []
        for (const [absolutePath, content] of pendingChanges) {
            const displayPath = filesToReview.find((f) => f.absolutePath === absolutePath)!.displayPath
            const saveResult = await env.editor.applyAndSaveSilently(absolutePath, content)

            await env.diagnostics.prepare([absolutePath])
            const diagnostics = await env.diagnostics.getRaw([absolutePath])
            const fileDiagnostics = diagnostics.find((d) => d.filePath === absolutePath || absolutePath.endsWith(d.filePath))

            let resultMsg = `Successfully renamed in ${displayPath}.`
            if (saveResult.userEdits) resultMsg += " (User made additional edits)"
            if (saveResult.autoFormatting) resultMsg += " (Auto-formatting applied)"

            if (fileDiagnostics && fileDiagnostics.diagnostics && fileDiagnostics.diagnostics.length > 0) {
                const errors = fileDiagnostics.diagnostics.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)
                if (errors.length > 0) {
                    resultMsg += `\nWarning: ${errors.length} error(s) detected after rename:\n`
                    resultMsg += DiagnosticFormatter.formatDetailed(displayPath, absolutePath, diagnostics, content)
                }
            }
            results.push(resultMsg)
        }

        await env.editor.hideReview()
        return results
    }

    private formatResult(
        existing_symbol: string,
        new_symbol: string,
        occurrenceCount: number,
        fileCount: number,
        results: string[],
    ): string {
        return `Successfully renamed symbol '${existing_symbol}' to '${new_symbol}' (${occurrenceCount} occurrences in ${fileCount} files).\n\n${results.join(
            "\n\n",
        )}`
    }
}
