import { Node as SyntaxNode, Tree } from "web-tree-sitter"
import * as path from "path"
import { loadRequiredLanguageParsers } from "@/services/tree-sitter/languageParser"
import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { Logger } from "@/shared/services/Logger"
import { DiagnosticsFeedbackResult, IDiagnosticsProvider } from "./IDiagnosticsProvider"
import { diagnosticsToProblemsString } from "./index"

export class SyntaxFeedbackProvider implements IDiagnosticsProvider {
	async capturePreSaveState(): Promise<FileDiagnostics[]> {
		return []
	}

	async getDiagnosticsFeedback(
		filePath: string,
		content: string,
		_preSaveDiagnostics: FileDiagnostics[],
		hashes?: string[],
	): Promise<DiagnosticsFeedbackResult> {
		try {
			const extension = path.extname(filePath).toLowerCase().slice(1)
			const languageParsers = await loadRequiredLanguageParsers([filePath])
			const { parser } = languageParsers[extension] || {}
			if (!parser) {
				Logger.error(`[SyntaxFeedbackProvider] No parser found for ${filePath}`)
				return { newProblemsMessage: "", fixedCount: 0 }
			}

			let tree: Tree | null = null
			try {
				const parsedTree = parser.parse(content) as Tree
				tree = parsedTree
				if (!parsedTree.rootNode) {
					Logger.error(`[SyntaxFeedbackProvider] Failed to parse tree or rootNode is missing for ${filePath}`)
					return { newProblemsMessage: "", fixedCount: 0 }
				}
				if (!parsedTree.rootNode.hasError) return { newProblemsMessage: "", fixedCount: 0 }

				const errors = this.findErrors(parsedTree.rootNode)
				if (errors.length === 0) return { newProblemsMessage: "", fixedCount: 0 }

				const message = await diagnosticsToProblemsString(
					[{ filePath, diagnostics: errors }],
					[DiagnosticSeverity.DIAGNOSTIC_ERROR],
					new Map([[filePath, { lines: content.split("\n"), hashes }]]),
					5,
				)
				Logger.error(`[SyntaxFeedbackProvider] Returning syntax errors for ${filePath}: ${message}`)
				return { newProblemsMessage: message, fixedCount: 0 }
			} finally {
				tree?.delete()
			}
		} catch (error) {
			Logger.error(`Error in syntax check for ${filePath}:`, error)
			return { newProblemsMessage: "", fixedCount: 0 }
		}
	}

	async getDiagnosticsFeedbackForFiles(
		files: Array<{ filePath: string; content: string; hashes?: string[] }>,
		preSaveDiagnostics: FileDiagnostics[],
	): Promise<DiagnosticsFeedbackResult[]> {
		const results: DiagnosticsFeedbackResult[] = []
		// Shared cached parsers are intentionally used sequentially in this batch path.
		for (const file of files) {
			results.push(await this.getDiagnosticsFeedback(file.filePath, file.content, preSaveDiagnostics, file.hashes))
		}
		return results
	}

	private findErrors(node: SyntaxNode): Diagnostic[] {
		const errors: Diagnostic[] = []
		if (node.type === "ERROR") {
			errors.push({
				range: {
					start: {
						line: node.startPosition.row,
						character: node.startPosition.column,
					},
					end: {
						line: node.endPosition.row,
						character: node.endPosition.column,
					},
				},
				message: `Syntax error at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`,
				severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
				source: "Syntax",
			})
		} else if (node.isMissing) {
			errors.push({
				range: {
					start: {
						line: node.startPosition.row,
						character: node.startPosition.column,
					},
					end: {
						line: node.endPosition.row,
						character: node.endPosition.column,
					},
				},
				message: `Missing '${node.type}' at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`,
				severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
				source: "Syntax",
			})
		}
		if (errors.length >= 5) return errors
		for (let index = 0; index < node.childCount && errors.length < 5; index++) {
			errors.push(...this.findErrors(node.child(index)!))
		}
		return errors
	}
}
