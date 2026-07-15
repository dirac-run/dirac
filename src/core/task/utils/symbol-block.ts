import * as path from "path"
import { Node as SyntaxNode, Tree } from "web-tree-sitter"
import { loadRequiredLanguageParsers } from "../../../services/tree-sitter/languageParser"

export interface SymbolBlock {
	startLine: number
	endLine: number
}

/** Finds the structural block containing a symbol position with Tree-sitter. */
export async function getSymbolStructuralBlock(
	absoluteFilePath: string,
	fileContent: string,
	hit: {
		startLine: number
		startColumn: number
		endLine: number
		endColumn: number
	},
): Promise<SymbolBlock> {
	try {
		const languageParsers = await loadRequiredLanguageParsers([absoluteFilePath])
		const extension = path.extname(absoluteFilePath).toLowerCase().slice(1)
		const { parser } = languageParsers[extension] || {}
		if (!parser) return fallbackBlock(hit)

		let tree: Tree | null = null
		try {
			const parsedTree = parser.parse(fileContent) as Tree
			tree = parsedTree
			if (!parsedTree.rootNode) return fallbackBlock(hit)
			const node = parsedTree.rootNode.descendantForPosition(
				{ row: hit.startLine, column: hit.startColumn },
				{ row: hit.endLine, column: hit.endColumn },
			)
			if (!node) return fallbackBlock(hit)

			const definitionNode = findContainingDefinition(node)
			if (!definitionNode) return fallbackBlock(hit)

			let endLine = definitionNode.endPosition.row
			if (definitionNode.endPosition.column === 0 && endLine > definitionNode.startPosition.row) endLine--
			return { startLine: definitionNode.startPosition.row, endLine }
		} finally {
			tree?.delete()
		}
	} catch {
		return fallbackBlock(hit)
	}
}

function fallbackBlock(hit: SymbolBlock): SymbolBlock {
	return { startLine: hit.startLine, endLine: hit.endLine }
}

function findContainingDefinition(node: SyntaxNode): SyntaxNode | null {
	const wrapperTypes = [
		"export_statement",
		"export_declaration",
		"ambient_declaration",
		"decorated_definition",
		"internal_module",
		"pressure",
	]
	let current = node.parent
	while (current) {
		if (isDefinitionNode(current) && current.endPosition.row > current.startPosition.row) {
			let definitionNode = current
			while (definitionNode.parent && wrapperTypes.includes(definitionNode.parent.type)) {
				definitionNode = definitionNode.parent
			}
			return definitionNode
		}
		current = current.parent
	}
	return null
}

function isDefinitionNode(node: SyntaxNode): boolean {
	return ["function", "method", "declaration", "definition", "class", "module", "item", "type"].some((type) =>
		node.type.includes(type),
	)
}
