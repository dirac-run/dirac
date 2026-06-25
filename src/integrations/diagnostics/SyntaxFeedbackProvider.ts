import { Node as SyntaxNode } from "web-tree-sitter"
import * as path from "path"
import { loadRequiredLanguageParsers } from "@/services/tree-sitter/languageParser"
import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { Logger } from "@/shared/services/Logger"
import { DiagnosticsFeedbackResult, IDiagnosticsProvider } from "./IDiagnosticsProvider"
import { diagnosticsToProblemsString } from "./index"

export class SyntaxFeedbackProvider implements IDiagnosticsProvider {
    async capturePreSaveState(): Promise<FileDiagnostics[]> {
        // Syntax-only mode doesn't need to poll or compare against baseline host diagnostics.
        return []
    }

    async getDiagnosticsFeedback(
        filePath: string,
        content: string,
        _preSaveDiagnostics: FileDiagnostics[],
        hashes?: string[],
    ): Promise<DiagnosticsFeedbackResult> {
        try {
            const ext = path.extname(filePath).toLowerCase().slice(1)
            const languageParsers = await loadRequiredLanguageParsers([filePath])
            const { parser } = languageParsers[ext] || {}

            if (!parser) {
                Logger.error(`[SyntaxFeedbackProvider] No parser found for ${filePath}`)
                return { newProblemsMessage: "", fixedCount: 0 }
            }

            const tree = parser.parse(content)
            if (!tree || !tree.rootNode) {
                Logger.error(`[SyntaxFeedbackProvider] Failed to parse tree or rootNode is missing for ${filePath}`)
                return { newProblemsMessage: "", fixedCount: 0 }
            }

            if (!tree.rootNode.hasError) {
                return { newProblemsMessage: "", fixedCount: 0 }
            }

            const errors = this.findErrors(tree.rootNode)
            if (errors.length === 0) {
                return { newProblemsMessage: "", fixedCount: 0 }
            }

            const message = await diagnosticsToProblemsString(
                [{ filePath, diagnostics: errors }],
                [DiagnosticSeverity.DIAGNOSTIC_ERROR],
                new Map([[filePath, { lines: content.split("\n"), hashes }]]),
                5,
            )

            Logger.error(`[SyntaxFeedbackProvider] Returning syntax errors for ${filePath}: ${message}`)
            return {
                newProblemsMessage: message,
                fixedCount: 0,
            }
        } catch (error) {
            Logger.error(`Error in syntax check for ${filePath}:`, error)
            return { newProblemsMessage: "", fixedCount: 0 }
        }
    }


    async getDiagnosticsFeedbackForFiles(
        files: Array<{ filePath: string; content: string; hashes?: string[] }>,
        preSaveDiagnostics: FileDiagnostics[]
    ): Promise<DiagnosticsFeedbackResult[]> {
        return Promise.all(
            files.map((f) => this.getDiagnosticsFeedback(f.filePath, f.content, preSaveDiagnostics, f.hashes))
        )
    }

    private findErrors(node: SyntaxNode): Diagnostic[] {
        const errors: Diagnostic[] = []
        if (node.type === "ERROR") {
            errors.push({
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column },
                },
                message: `Syntax error at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`,
                severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
                source: "Syntax",
            })
        } else if (node.isMissing) {
            errors.push({
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column },
                },
                message: `Missing '${node.type}' at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`,
                severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
                source: "Syntax",
            })
        }

        // To prevent excessive error messages, only check children if the node itself doesn't have an error,
        // or if we want more granular errors. Tree-sitter ERROR nodes usually consume the tokens.
        // Let's traverse all to be thorough but maybe limit the number of reported errors.
        if (errors.length < 5) {
            for (let i = 0; i < node.childCount; i++) {
                const childErrors = this.findErrors(node.child(i)!)
                errors.push(...childErrors)
                if (errors.length >= 5) break
            }
        }

        return errors
    }
}
