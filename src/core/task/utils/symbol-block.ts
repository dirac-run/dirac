import * as path from "path"
import { Node as SyntaxNode } from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../services/tree-sitter/languageParser"

export interface SymbolBlock {
    startLine: number
    endLine: number
}

/**
 * Finds the structural block (e.g., function, class, method) containing a symbol at a given position.
 * Uses Tree-sitter to traverse up the AST from the symbol's location.
 */
export async function getSymbolStructuralBlock(
    absFilePath: string,
    fileContent: string,
    hit: { startLine: number; startColumn: number; endLine: number; endColumn: number },
): Promise<SymbolBlock> {
    try {
        const languageParsers = await loadRequiredLanguageParsers([absFilePath])
        const ext = path.extname(absFilePath).toLowerCase().slice(1)
        const { parser } = languageParsers[ext] || {}

        if (!parser) {
            return { startLine: hit.startLine, endLine: hit.endLine }
        }

        const tree = parser.parse(fileContent)
        if (!tree || !tree.rootNode) {
            return { startLine: hit.startLine, endLine: hit.endLine }
        }

        const node = tree.rootNode.descendantForPosition(
            { row: hit.startLine, column: hit.startColumn },
            { row: hit.endLine, column: hit.endColumn },
        )

        if (!node) {
            return { startLine: hit.startLine, endLine: hit.endLine }
        }

        let startLine = hit.startLine
        let endLine = hit.endLine

        let parent = node.parent
        let definitionNode: SyntaxNode | null = null
        const wrapperTypes = [
            "export_statement",
            "export_declaration",
            "ambient_declaration",
            "decorated_definition",
            "internal_module",
            "pressure",
        ]

        while (parent) {
            if (
                parent.type.includes("function") ||
                parent.type.includes("method") ||
                parent.type.includes("declaration") ||
                parent.type.includes("definition") ||
                parent.type.includes("class") ||
                parent.type.includes("module") ||
                parent.type.includes("item") ||
                parent.type.includes("type")
            ) {
                if (parent.endPosition.row - parent.startPosition.row > 0) {
                    definitionNode = parent
                    let current = parent
                    while (current.parent && wrapperTypes.includes(current.parent.type)) {
                        current = current.parent
                        definitionNode = current
                    }
                    break
                }
            }
            parent = parent.parent
        }

        if (definitionNode) {
            startLine = definitionNode.startPosition.row
            endLine = definitionNode.endPosition.row
            if (definitionNode.endPosition.column === 0 && endLine > startLine) {
                endLine--
            }
        }

        return { startLine, endLine }
    } catch (error) {
        // Fallback to the original line if anything goes wrong
        return { startLine: hit.startLine, endLine: hit.endLine }
    }
}
