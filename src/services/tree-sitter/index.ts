import { Node as SyntaxNode, Tree } from "web-tree-sitter"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { LanguageParser } from "./languageParser"

export interface ParsedDefinition {
	lineIndex: number
	text: string
	indentation: string
	lineCount?: number
	calls?: string[]
}

export async function parseFile(
	filePath: string,
	languageParsers: LanguageParser,
	diracIgnoreController?: DiracIgnoreController,
	options?: { showCallGraph?: boolean },
): Promise<ParsedDefinition[] | null> {
	if (diracIgnoreController && !diracIgnoreController.validateAccess(filePath)) return null

	const fileContent = await fs.readFile(filePath, "utf8")
	const extension = path.extname(filePath).toLowerCase().slice(1)
	const { parser, query } = languageParsers[extension] || {}
	if (!parser || !query) return null

	const definitions: ParsedDefinition[] = []
	let tree: Tree | null = null
	try {
		const parsedTree = parser.parse(fileContent) as Tree
		tree = parsedTree
		if (!parsedTree.rootNode) return null

		const captures = query.captures(parsedTree.rootNode)
		const definedNames = new Set<string>()
		const allReferences: { node: SyntaxNode; text: string; line: number }[] = []
		const definitionNodes = new Map<number, string>()

		for (const capture of captures) {
			if (capture.name.includes("definition") && !capture.name.includes("name.definition")) {
				definitionNodes.set(capture.node.id, capture.name)
			}
			if (!options?.showCallGraph) continue
			if (capture.name.includes("name.definition.function") || capture.name.includes("name.definition.method")) {
				definedNames.add(capture.node.text)
			} else if (capture.name.includes("name.reference")) {
				allReferences.push({
					node: capture.node,
					text: capture.node.text,
					line: capture.node.startPosition.row,
				})
			}
		}

		captures.sort((left, right) => left.node.startPosition.row - right.node.startPosition.row)
		const lines = fileContent.split("\n")
		let lastLineAdded = -1

		for (const capture of captures) {
			const { node, name } = capture
			const startLine = node.startPosition.row
			if (!name.includes("name.definition") || !lines[startLine] || startLine <= lastLineAdded) continue

			const definition: ParsedDefinition = {
				lineIndex: startLine,
				text: lines[startLine],
				indentation: lines[startLine].match(/^\s*/)?.[0] || "",
			}
			lastLineAdded = startLine
			if (options?.showCallGraph) {
				const definitionNode = findDefinitionNode(node, definitionNodes)
				if (definitionNode) {
					addCallGraphMetadata(definition, name, node, definitionNode, allReferences, definedNames)
				}
			}
			definitions.push(definition)
		}
	} catch (error) {
		Logger.log(`Error parsing file: ${error}\n`)
	} finally {
		tree?.delete()
	}

	return definitions.length > 0 ? definitions : null
}

function findDefinitionNode(node: SyntaxNode, definitionNodes: Map<number, string>): SyntaxNode | null {
	let current: SyntaxNode | null = node
	while (current) {
		if (definitionNodes.has(current.id)) return current
		current = current.parent
	}
	return null
}

function addCallGraphMetadata(
	definition: ParsedDefinition,
	captureName: string,
	nameNode: SyntaxNode,
	definitionNode: SyntaxNode,
	allReferences: { node: SyntaxNode; text: string; line: number }[],
	definedNames: Set<string>,
): void {
	const startRow = definitionNode.startPosition.row
	const endRow = definitionNode.endPosition.row
	if (
		captureName.includes("name.definition.function") ||
		captureName.includes("name.definition.method") ||
		captureName.includes("name.definition.class") ||
		captureName.includes("name.definition.interface")
	) {
		definition.lineCount = endRow - startRow + 1
	}
	if (!captureName.includes("name.definition.function") && !captureName.includes("name.definition.method")) return

	const localCalls = new Set<string>()
	for (const reference of allReferences) {
		if (
			reference.line >= startRow &&
			reference.line <= endRow &&
			definedNames.has(reference.text) &&
			reference.text !== nameNode.text &&
			isCallNode(reference.node)
		) {
			localCalls.add(reference.text)
		}
	}
	if (localCalls.size > 0) definition.calls = [...localCalls]
}

function isCallNode(node: SyntaxNode): boolean {
	const parent = node.parent
	if (!parent) return false

	const callTypes = [
		"call",
		"call_expression",
		"method_invocation",
		"function_call_expression",
		"member_call_expression",
		"invocation_expression",
	]
	if (callTypes.includes(parent.type)) return true

	const memberTypes = ["member_expression", "member_access_expression", "property_access", "member_call_expression"]
	return memberTypes.includes(parent.type) && !!parent.parent && callTypes.includes(parent.parent.type)
}
